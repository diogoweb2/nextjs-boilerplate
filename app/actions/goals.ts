'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { and, asc, desc, eq, ilike, inArray, isNull } from 'drizzle-orm'
import { db } from '@/db'
import {
  goals,
  goalEntries,
  goalTransfers,
  transferReviews,
  transactions,
  merchants,
  categories,
  type Goal,
} from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { isDemoSession } from '@/app/lib/demo'
import { loadAllFlows, anchorMonth, netOverRange } from '@/app/lib/analytics'
import {
  savingsValue,
  totalContributed,
  progressPct,
  valueSeries,
  projectedCompletionYm,
  milestoneMessage,
  type EntryLite,
} from '@/app/lib/goals'
import {
  projectMortgage,
  inferRate,
  isExtraMortgagePayment,
  type MortgageProjection,
  type Payment,
} from '@/app/lib/mortgage'
import { pushConfigured, sendPushToAll } from '@/app/lib/push'
import { formatCurrency } from '@/app/lib/format'
import { recordTransferContribution, loadRegisteredAccountOptions } from '@/app/actions/investments'

// Personal figures stay out of committed code (public repo). Configure in
// .env.local; neutral fallbacks keep the build working without them.
const OWNER_BIRTHDATE = process.env.OWNER_BIRTHDATE || '1981-09-05'
const MORTGAGE_START_BALANCE = Number(process.env.MORTGAGE_START_BALANCE || '0')
const PAYOFF_AGE = 50
const DEFAULT_RATE = 0.055

function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

function revalidateGoals() {
  revalidatePath('/goals')
  revalidatePath('/')
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Loaders (called from the server pages; the routes are auth-gated by proxy.ts)
// ---------------------------------------------------------------------------

export type NetZeroView = {
  /** Cumulative net since the goal's start year (negative = still in the red). */
  value: number
  /** Net (income − spend) for the current calendar year so far. */
  currentYearNet: number
  /** Deficit carried from completed prior years (≤ 0). */
  priorCarryover: number
  startYear: number
  /** Amount still in the red = max(0, −value). */
  toRecover: number
}

export type GoalView = {
  id: number
  name: string
  emoji: string
  color: string
  kind: 'savings' | 'mortgage' | 'netzero'
  notify: boolean
  archived: boolean
  sortOrder: number
  targetAmount: number | null
  targetDate: string | null
  annualRate: number | null
  /** Savings only: fixed monthly auto-contribute amount for the surplus prompt. */
  autoContribute: number | null
  value: number
  contributed: number
  contributedThisMonth: number
  /** Money other goals borrowed from this one and still owe back (lender side). */
  owedToThis: number
  /** Money this goal borrowed from others and still owes back (borrower side). */
  owesOut: number
  /** Per-lender breakdown of what this goal still owes (drives the Repay panel). */
  owesTo: { goalId: number; amount: number }[]
  progressPct: number | null
  projectedCompletionYm: string | null
  milestone: string
  series: { ym: string; value: number }[]
  mortgage: MortgageProjection | null
  netZero: NetZeroView | null
}

/**
 * Mortgage monthly outflow (the "Mortgage" payee), split by month into the
 * contractual `regular` payment ("mortgage payment" in the description) and the
 * voluntary `extra` prepayment (the "customer transfer" top-ups). Both reduce
 * the balance; only the extra is something the owner chooses to change.
 */
function mortgagePayments(flows: Awaited<ReturnType<typeof loadAllFlows>>): Payment[] {
  const byYm = new Map<string, { regular: number; extra: number }>()
  for (const t of flows) {
    if (t.merchantName !== 'Mortgage' || t.flow !== 'expense') continue
    const ym = t.txnDate.slice(0, 7)
    const cur = byYm.get(ym) ?? { regular: 0, extra: 0 }
    if (isExtraMortgagePayment(t)) cur.extra += t.amount
    else cur.regular += t.amount
    byYm.set(ym, cur)
  }
  return [...byYm.entries()]
    .map(([ym, v]) => ({ ym, regular: v.regular, extra: v.extra }))
    .sort((a, b) => (a.ym < b.ym ? -1 : 1))
}

/** Auto-create the mortgage goal on first access, seeded from env (privacy). */
async function ensureMortgageGoal(): Promise<void> {
  const [existing] = await db.select().from(goals).where(eq(goals.kind, 'mortgage')).limit(1)
  if (existing) return
  const targetDate = `${Number(OWNER_BIRTHDATE.slice(0, 4)) + PAYOFF_AGE}${OWNER_BIRTHDATE.slice(4)}`
  const [g] = await db
    .insert(goals)
    .values({
      name: 'Mortgage Freedom',
      emoji: '🏠',
      color: '#10b981',
      kind: 'mortgage',
      targetAmount: '0',
      targetDate,
      annualRate: String(DEFAULT_RATE),
      sortOrder: 1000,
    })
    .returning({ id: goals.id })
  if (MORTGAGE_START_BALANCE > 0) {
    await db.insert(goalEntries).values({
      goalId: g.id,
      kind: 'balance',
      amount: MORTGAGE_START_BALANCE.toFixed(2),
      occurredAt: todayIso(),
      note: 'Starting balance',
    })
  }
}

/**
 * Lean mortgage projection for the dashboard net-worth card (reuses the same
 * inputs as loadGoalsData's mortgage goal). Returns null when no balance has been
 * recorded yet. Not demo-guarded — the net-worth loader handles demo itself.
 */
export async function loadMortgageProjection(): Promise<MortgageProjection | null> {
  await ensureMortgageGoal()
  const [goal] = await db.select().from(goals).where(eq(goals.kind, 'mortgage')).limit(1)
  if (!goal) return null
  const entries = await db.select().from(goalEntries).where(eq(goalEntries.goalId, goal.id))
  const snaps = entries
    .filter((e) => e.kind === 'balance')
    .map((e) => ({ ym: e.occurredAt.slice(0, 7), balance: Number(e.amount) }))
    .sort((a, b) => (a.ym < b.ym ? -1 : 1))
  if (snaps.length === 0) return null
  const flows = await loadAllFlows()
  const asOfYm = anchorMonth(flows.filter((t) => t.flow === 'expense')) ?? todayIso().slice(0, 7)
  return projectMortgage({
    birthDate: OWNER_BIRTHDATE,
    payoffAge: PAYOFF_AGE,
    annualRate: goal.annualRate === null ? DEFAULT_RATE : Number(goal.annualRate),
    snapshots: snaps,
    payments: mortgagePayments(flows),
    asOfYm,
  })
}

export async function loadGoalsData(): Promise<{ goals: GoalView[]; asOfYm: string; suggestNetZero: boolean; monthStats: { thisMonth: number; lastMonth: number } }> {
  if (await isDemoSession()) {
    const { demoGoalsData } = await import('@/app/lib/demo-data')
    return demoGoalsData()
  }
  await ensureMortgageGoal()
  await reconcileNetZeroGoals()

  const [goalRows, flows] = await Promise.all([
    db.select().from(goals).orderBy(asc(goals.sortOrder), asc(goals.createdAt)),
    loadAllFlows(),
  ])
  const goalIds = goalRows.map((g) => g.id)
  const entries = goalIds.length
    ? await db.select().from(goalEntries).where(inArray(goalEntries.goalId, goalIds))
    : []
  const entriesByGoal = new Map<number, EntryLite[]>()
  const balancesByGoal = new Map<number, { ym: string; balance: number }[]>()
  for (const e of entries) {
    const lite: EntryLite = { kind: e.kind, amount: Number(e.amount), occurredAt: e.occurredAt }
    const list = entriesByGoal.get(e.goalId) ?? []
    list.push(lite)
    entriesByGoal.set(e.goalId, list)
    if (e.kind === 'balance') {
      const bl = balancesByGoal.get(e.goalId) ?? []
      bl.push({ ym: e.occurredAt.slice(0, 7), balance: Number(e.amount) })
      balancesByGoal.set(e.goalId, bl)
    }
  }

  const expenses = flows.filter((t) => t.flow === 'expense')
  const asOfYm = anchorMonth(expenses) ?? todayIso().slice(0, 7)
  const payments = mortgagePayments(flows)

  const views: GoalView[] = goalRows.map((g) => {
    const list = entriesByGoal.get(g.id) ?? []
    const target = g.targetAmount === null ? null : Number(g.targetAmount)

    if (g.kind === 'mortgage') {
      const snaps = (balancesByGoal.get(g.id) ?? []).sort((a, b) => (a.ym < b.ym ? -1 : 1))
      const proj =
        snaps.length > 0
          ? projectMortgage({
              birthDate: OWNER_BIRTHDATE,
              payoffAge: PAYOFF_AGE,
              annualRate: g.annualRate === null ? DEFAULT_RATE : Number(g.annualRate),
              snapshots: snaps,
              payments,
              asOfYm,
            })
          : null
      return {
        ...baseView(g),
        value: proj?.currentBalance ?? 0,
        contributed: 0,
        contributedThisMonth: 0,
        progressPct: null,
        projectedCompletionYm: null,
        milestone: mortgageMessage(proj),
        series: [],
        mortgage: proj,
        netZero: null,
      }
    }

    if (g.kind === 'netzero') {
      const nz = netZeroView(g, flows, asOfYm)
      return {
        ...baseView(g),
        value: nz.value,
        contributed: 0,
        contributedThisMonth: 0,
        progressPct: null,
        projectedCompletionYm: null,
        milestone: netZeroMessage(nz),
        series: [],
        mortgage: null,
        netZero: nz,
      }
    }

    const value = savingsValue(list)
    const pct = progressPct(value, target)
    return {
      ...baseView(g),
      value,
      contributed: totalContributed(list),
      contributedThisMonth: 0,
      progressPct: pct,
      projectedCompletionYm: projectedCompletionYm(list, target, asOfYm),
      milestone: milestoneMessage(pct),
      series: valueSeries(list, asOfYm),
      mortgage: null,
      netZero: null,
    }
  })

  const curYear = asOfYm.slice(0, 4)
  const currentYearNet = netOverRange(flows, `${curYear}-01`, asOfYm)
  const suggestNetZero = !goalRows.some((g) => g.kind === 'netzero') && currentYearNet < -0.005

  const savingsGoalIds = new Set(goalRows.filter((g) => g.kind === 'savings' || g.kind === 'mortgage').map((g) => g.id))
  const prevYm = prevMonth(asOfYm)
  let thisMonth = 0
  let lastMonth = 0
  const thisMonthByGoal = new Map<number, number>()
  for (const e of entries) {
    if (!savingsGoalIds.has(e.goalId) || e.kind !== 'contribution' || Number(e.amount) <= 0) continue
    const ym = e.occurredAt.slice(0, 7)
    if (ym === asOfYm) {
      thisMonth += Number(e.amount)
      thisMonthByGoal.set(e.goalId, (thisMonthByGoal.get(e.goalId) ?? 0) + Number(e.amount))
    } else if (ym === prevYm) {
      lastMonth += Number(e.amount)
    }
  }

  // Borrow ledger: how much each goal is owed back (lender) / still owes (borrower).
  const transferRows = goalIds.length
    ? await db
        .select({
          fromGoalId: goalTransfers.fromGoalId,
          toGoalId: goalTransfers.toGoalId,
          amount: goalTransfers.amount,
          kind: goalTransfers.kind,
        })
        .from(goalTransfers)
        .where(inArray(goalTransfers.fromGoalId, goalIds))
    : []
  const owedToThis = new Map<number, number>()
  const owesOut = new Map<number, number>()
  // Per (borrower → lender) net owed, so each goal can repay specific lenders.
  const owedByPair = new Map<string, number>() // `${borrower}:${lender}` → amount
  for (const r of transferRows) {
    const amt = Number(r.amount)
    if (r.kind === 'borrow') {
      // from = lender (owed back), to = borrower (owes).
      owedToThis.set(r.fromGoalId, (owedToThis.get(r.fromGoalId) ?? 0) + amt)
      owesOut.set(r.toGoalId, (owesOut.get(r.toGoalId) ?? 0) + amt)
      const key = `${r.toGoalId}:${r.fromGoalId}`
      owedByPair.set(key, (owedByPair.get(key) ?? 0) + amt)
    } else if (r.kind === 'repay') {
      // from = borrower (owes less), to = lender (owed less).
      owedToThis.set(r.toGoalId, (owedToThis.get(r.toGoalId) ?? 0) - amt)
      owesOut.set(r.fromGoalId, (owesOut.get(r.fromGoalId) ?? 0) - amt)
      const key = `${r.fromGoalId}:${r.toGoalId}`
      owedByPair.set(key, (owedByPair.get(key) ?? 0) - amt)
    }
  }
  const clamp0 = (n: number) => Math.max(0, Math.round(n * 100) / 100)
  const owesToByGoal = new Map<number, { goalId: number; amount: number }[]>()
  for (const [key, raw] of owedByPair) {
    const amt = clamp0(raw)
    if (amt <= 0) continue
    const [borrower, lender] = key.split(':').map(Number)
    const list = owesToByGoal.get(borrower) ?? []
    list.push({ goalId: lender, amount: amt })
    owesToByGoal.set(borrower, list)
  }

  const viewsWithMonth = views.map((v) => ({
    ...v,
    contributedThisMonth: thisMonthByGoal.get(v.id) ?? 0,
    owedToThis: clamp0(owedToThis.get(v.id) ?? 0),
    owesOut: clamp0(owesOut.get(v.id) ?? 0),
    owesTo: owesToByGoal.get(v.id) ?? [],
  }))

  return { goals: viewsWithMonth, asOfYm, suggestNetZero, monthStats: { thisMonth: Math.round(thisMonth * 100) / 100, lastMonth: Math.round(lastMonth * 100) / 100 } }
}

function netZeroStartYear(g: Goal): number {
  return g.targetDate ? Number(g.targetDate.slice(0, 4)) : new Date(g.createdAt).getFullYear()
}

function netZeroView(g: Goal, flows: Awaited<ReturnType<typeof loadAllFlows>>, asOfYm: string): NetZeroView {
  const startYear = netZeroStartYear(g)
  const curYear = asOfYm.slice(0, 4)
  const value = netOverRange(flows, `${startYear}-01`, asOfYm)
  const currentYearNet = netOverRange(flows, `${curYear}-01`, asOfYm)
  return {
    value,
    currentYearNet,
    priorCarryover: Math.round((value - currentYearNet) * 100) / 100,
    startYear,
    toRecover: Math.max(0, -value),
  }
}

function netZeroMessage(nz: NetZeroView): string {
  if (nz.value >= -0.005) return 'Net zero reached — you clawed it all back! 🎉'
  if (nz.currentYearNet > 0.005)
    return `Digging out — ${formatCurrency(nz.currentYearNet)} recovered this year. Keep it up! 💪`
  return `${formatCurrency(nz.toRecover)} in the red. Every positive month gets you out. 🌱`
}

/**
 * Keep net-zero goals in sync with the data. Idempotent, so it's safe to run on
 * every import and page load:
 *  - active goal whose cumulative net reached ≥ 0 → congratulate (once) + archive.
 *  - archived goal whose CURRENT calendar year has slipped negative → revive it,
 *    re-anchoring the tracking start to this year (last year's debt was cleared).
 * The cumulative-net model means the Dec 31 → Jan 1 rollover is automatic: the new
 * year's net simply continues adding to the running total (a deficit carries over).
 */
export async function reconcileNetZeroGoals(): Promise<void> {
  const rows = await db.select().from(goals).where(eq(goals.kind, 'netzero'))
  if (rows.length === 0) return
  const flows = await loadAllFlows()
  const asOfYm = anchorMonth(flows.filter((t) => t.flow === 'expense')) ?? todayIso().slice(0, 7)
  const curYear = asOfYm.slice(0, 4)

  for (const g of rows) {
    const startYear = netZeroStartYear(g)
    const value = netOverRange(flows, `${startYear}-01`, asOfYm)
    const currentYearNet = netOverRange(flows, `${curYear}-01`, asOfYm)

    if (!g.archived && value >= -0.005) {
      await db.update(goals).set({ archived: true }).where(eq(goals.id, g.id))
      if (pushConfigured()) {
        await sendPushToAll({
          title: `${g.emoji} ${g.name} — net zero! 🎉`,
          body: 'You clawed it all back. Goal complete — enjoy the win!',
          url: '/goals',
        }).catch(() => {})
      }
    } else if (g.archived && currentYearNet < -0.005) {
      await db
        .update(goals)
        .set({ archived: false, targetDate: `${curYear}-01-01` })
        .where(eq(goals.id, g.id))
    }
  }
}

/**
 * Create (or revive) the single net-zero recovery goal. Tracking starts Jan 1 of
 * the current (anchor) year, so its value = the year's net so far, carrying
 * forward automatically thereafter.
 */
export async function createNetZeroGoal(): Promise<void> {
  await requireAuth()
  const [existing] = await db.select().from(goals).where(eq(goals.kind, 'netzero')).limit(1)
  if (existing) {
    if (existing.archived) await db.update(goals).set({ archived: false }).where(eq(goals.id, existing.id))
    revalidateGoals()
    return
  }
  const flows = await loadAllFlows()
  const asOfYm = anchorMonth(flows.filter((t) => t.flow === 'expense')) ?? todayIso().slice(0, 7)
  const year = asOfYm.slice(0, 4)
  await db.insert(goals).values({
    name: `Net-Zero ${year}`,
    emoji: '⚖️',
    color: '#f59e0b',
    kind: 'netzero',
    targetAmount: '0',
    targetDate: `${year}-01-01`,
    notify: true,
    sortOrder: 2000,
  })
  revalidateGoals()
}

function baseView(g: Goal) {
  return {
    id: g.id,
    name: g.name,
    emoji: g.emoji,
    color: g.color,
    kind: g.kind,
    notify: g.notify,
    archived: g.archived,
    sortOrder: g.sortOrder,
    targetAmount: g.targetAmount === null ? null : Number(g.targetAmount),
    targetDate: g.targetDate,
    annualRate: g.annualRate === null ? null : Number(g.annualRate),
    autoContribute: g.autoContribute === null ? null : Number(g.autoContribute),
    // Real values merged in loadGoalsData after aggregating goal_transfers.
    owedToThis: 0,
    owesOut: 0,
    owesTo: [],
  }
}

function mortgageMessage(proj: MortgageProjection | null): string {
  if (!proj) return 'Add your current balance to start tracking the payoff. 🏁'
  if (proj.currentBalance <= 0) return 'Mortgage-free! Incredible. 🎉🏠'
  return proj.onTrack
    ? 'On track to be mortgage-free by 50. Keep it up! 🟢'
    : `Behind pace — add ${formatCurrency(proj.prepay)}/mo to your extra payment to catch up. 🔴`
}

export type PendingReview = {
  id: number
  transactionId: number
  /** 'out' = money moved to investments (grows a goal); 'in' = money returned. */
  direction: 'out' | 'in'
  date: string
  amount: number
  merchant: string
  suggestedGoalId: number | null
  goals: { id: number; name: string; emoji: string }[]
  /** Registered accounts (TFSA/RESP) an outbound transfer can be tagged to. */
  registeredAccounts: { id: number; name: string; kind: string; ownerName: string }[]
}

/** Pending transfer reviews for the dashboard prompt (+ savings-goal options). */
export async function loadPendingReviews(): Promise<PendingReview[]> {
  if (await isDemoSession()) {
    const { demoPendingReviews } = await import('@/app/lib/demo-data')
    return demoPendingReviews()
  }
  const rows = await db
    .select({
      id: transferReviews.id,
      transactionId: transferReviews.transactionId,
      direction: transferReviews.direction,
      suggestedGoalId: transferReviews.suggestedGoalId,
      date: transactions.txnDate,
      amount: transactions.amount,
      merchant: merchants.name,
    })
    .from(transferReviews)
    .innerJoin(transactions, eq(transferReviews.transactionId, transactions.id))
    .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
    .where(eq(transferReviews.status, 'pending'))
    .orderBy(desc(transactions.txnDate))
  if (rows.length === 0) return []

  const goalOpts = await db
    .select({ id: goals.id, name: goals.name, emoji: goals.emoji })
    .from(goals)
    .where(and(eq(goals.kind, 'savings'), eq(goals.archived, false)))
    .orderBy(asc(goals.sortOrder), asc(goals.createdAt))

  const accountOpts = await loadRegisteredAccountOptions()

  return rows.map((r) => ({
    id: r.id,
    transactionId: r.transactionId,
    direction: r.direction,
    date: r.date,
    // Inbound deposits are stored negative (money in); show a positive figure.
    amount: Math.abs(Number(r.amount)),
    merchant: r.merchant,
    suggestedGoalId: r.suggestedGoalId,
    goals: goalOpts,
    registeredAccounts: accountOpts,
  }))
}

/**
 * Manual "extra" savings-goal contributions — those with NO backing transaction
 * (transactionId IS NULL) on a savings goal. These don't appear in any
 * transaction flow, so the 50/30/20 rule counts them as Savings explicitly.
 * Contributions that DO have a transaction (transfers tagged to a goal, or
 * `asExpense` deposits) already land in the Investment category, so they are
 * counted there instead — excluding txn-backed ones here avoids double counting.
 */
export async function loadManualSavingsContributions(): Promise<{ occurredAt: string; amount: number }[]> {
  if (await isDemoSession()) {
    const { demoManualSavingsContributions } = await import('@/app/lib/demo-data')
    return demoManualSavingsContributions()
  }
  const rows = await db
    .select({ amount: goalEntries.amount, occurredAt: goalEntries.occurredAt })
    .from(goalEntries)
    .innerJoin(goals, eq(goalEntries.goalId, goals.id))
    .where(
      and(
        eq(goals.kind, 'savings'),
        eq(goalEntries.kind, 'contribution'),
        isNull(goalEntries.transactionId),
      ),
    )
  return rows
    .map((r) => ({ occurredAt: r.occurredAt, amount: Number(r.amount) }))
    .filter((r) => r.amount > 0)
}

/**
 * Expense categories offered when spending from a goal, so the offsetting income
 * can be attributed to where the money actually went (e.g. a reno → Home).
 * Income/neutral buckets are excluded — they aren't real spend destinations.
 */
export async function loadSpendCategories(): Promise<{ id: number; name: string }[]> {
  if (await isDemoSession()) {
    const { demoCategoryRows } = await import('@/app/lib/demo-data')
    return demoCategoryRows()
      .filter((c) => c.kind === 'expense')
      .map((c) => ({ id: c.id, name: c.name }))
  }
  return db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(eq(categories.kind, 'expense'))
    .orderBy(asc(categories.name))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function categoryIdByName(name: string): Promise<number | null> {
  const [c] = await db.select({ id: categories.id }).from(categories).where(eq(categories.name, name)).limit(1)
  return c?.id ?? null
}

/** Return the id only if it's a real category, so a stale/forged select value
 *  can't write a dangling reference; null means "use the default bucket". */
async function validCategoryId(id: number | null | undefined): Promise<number | null> {
  if (id == null || !Number.isInteger(id)) return null
  const [c] = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, id)).limit(1)
  return c?.id ?? null
}

async function merchantIdByName(name: string, categoryName?: string): Promise<number> {
  const [existing] = await db.select({ id: merchants.id }).from(merchants).where(ilike(merchants.name, name)).limit(1)
  if (existing) return existing.id
  const categoryId = categoryName ? await categoryIdByName(categoryName) : null
  const [created] = await db.insert(merchants).values({ name, categoryId }).returning({ id: merchants.id })
  return created.id
}

/** Current savings value of a goal straight from its ledger (pre/post deltas). */
async function currentSavingsValue(goalId: number): Promise<number> {
  const rows = await db
    .select({ kind: goalEntries.kind, amount: goalEntries.amount, occurredAt: goalEntries.occurredAt })
    .from(goalEntries)
    .where(eq(goalEntries.goalId, goalId))
  return savingsValue(rows.map((r) => ({ kind: r.kind, amount: Number(r.amount), occurredAt: r.occurredAt })))
}

/** Fire an immediate push for a goal whose value changed (if it opted in). */
async function notifyGoalChange(goal: Goal, before: number, after: number): Promise<void> {
  if (!goal.notify || !pushConfigured()) return
  const delta = Math.round((after - before) * 100) / 100
  if (Math.abs(delta) < 0.005) return
  const pct = before !== 0 ? (delta / Math.abs(before)) * 100 : 100
  const sign = delta >= 0 ? '+' : '−'
  const arrow = goal.kind === 'mortgage' ? (delta < 0 ? '⬇️' : '⬆️') : delta >= 0 ? '📈' : '📉'
  const tail = goal.kind === 'mortgage' && delta < 0 ? ' · closer to payoff 🎉' : ''
  await sendPushToAll({
    title: `${goal.emoji} ${goal.name} ${formatCurrency(after)}`,
    body: `${arrow} ${sign}${Math.abs(pct).toFixed(1)}% · ${sign}${formatCurrency(Math.abs(delta))}${tail}`,
    url: '/goals',
  }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createGoal(input: {
  name: string
  emoji?: string
  color?: string
  targetAmount?: number | null
  targetDate?: string | null
  autoContribute?: number | null
}): Promise<void> {
  await requireAuth()
  const name = input.name.trim()
  if (!name) return
  const [{ max }] = await db
    .select({ max: goals.sortOrder })
    .from(goals)
    .orderBy(desc(goals.sortOrder))
    .limit(1)
    .then((r) => (r.length ? r : [{ max: 0 }]))
  await db.insert(goals).values({
    name,
    emoji: input.emoji?.trim() || '🎯',
    color: input.color || '#6366f1',
    kind: 'savings',
    targetAmount: input.targetAmount != null && input.targetAmount > 0 ? input.targetAmount.toFixed(2) : null,
    targetDate: input.targetDate || null,
    autoContribute: input.autoContribute != null && input.autoContribute > 0 ? input.autoContribute.toFixed(2) : null,
    sortOrder: (max ?? 0) + 1,
  })
  revalidateGoals()
}

export async function updateGoal(
  id: number,
  patch: {
    name?: string
    emoji?: string
    color?: string
    targetAmount?: number | null
    targetDate?: string | null
    /** Mortgage only: current annual interest rate as a decimal (3.55% → 0.0355). */
    annualRate?: number | null
    /** Savings only: fixed monthly auto-contribute amount (0/null clears the rule). */
    autoContribute?: number | null
  },
): Promise<void> {
  await requireAuth()
  const set: Record<string, unknown> = {}
  if (patch.name !== undefined) set.name = patch.name.trim()
  if (patch.emoji !== undefined) set.emoji = patch.emoji.trim() || '🎯'
  if (patch.color !== undefined) set.color = patch.color
  if (patch.targetAmount !== undefined)
    set.targetAmount = patch.targetAmount != null && patch.targetAmount > 0 ? patch.targetAmount.toFixed(2) : null
  if (patch.targetDate !== undefined) set.targetDate = patch.targetDate || null
  if (patch.autoContribute !== undefined)
    set.autoContribute =
      patch.autoContribute != null && patch.autoContribute > 0 ? patch.autoContribute.toFixed(2) : null
  if (patch.annualRate !== undefined)
    set.annualRate =
      patch.annualRate != null && Number.isFinite(patch.annualRate) && patch.annualRate >= 0
        ? Math.min(0.5, patch.annualRate).toFixed(4)
        : null
  if (Object.keys(set).length === 0) return
  await db.update(goals).set(set).where(eq(goals.id, id))
  revalidateGoals()
}

/**
 * Persist a user-chosen ordering of goals. `orderedIds` is the full list of goal
 * ids in the desired order; each goal's `sortOrder` is rewritten to its index so
 * the next `loadGoalsData` (ordered by `sortOrder`) reflects the new arrangement.
 */
export async function reorderGoals(orderedIds: number[]): Promise<void> {
  await requireAuth()
  const ids = orderedIds.filter((id) => Number.isInteger(id))
  if (ids.length === 0) return
  // neon-http has no transaction support; these single-row updates are
  // idempotent, so a partial failure just leaves a slightly stale order.
  for (let i = 0; i < ids.length; i++) {
    await db.update(goals).set({ sortOrder: i }).where(eq(goals.id, ids[i]))
  }
  revalidateGoals()
}

export async function archiveGoal(id: number, archived: boolean): Promise<void> {
  await requireAuth()
  await db.update(goals).set({ archived }).where(eq(goals.id, id))
  revalidateGoals()
}

export async function toggleNotify(id: number, notify: boolean): Promise<void> {
  await requireAuth()
  await db.update(goals).set({ notify }).where(eq(goals.id, id))
  revalidateGoals()
}

export async function deleteGoal(id: number): Promise<void> {
  await requireAuth()
  // Don't allow deleting the auto-managed mortgage goal (archive it instead).
  const [g] = await db.select().from(goals).where(eq(goals.id, id)).limit(1)
  if (!g || g.kind === 'mortgage') return
  await db.delete(goals).where(eq(goals.id, id))
  revalidateGoals()
}

/**
 * Add money to a savings goal. `asExpense` (the debt-recovery case) also inserts
 * a real Investment expense transaction so the budget reflects the move; the
 * default just grows the goal with no budget impact ("extra" money).
 */
export async function addContribution(input: {
  goalId: number
  amount: number
  occurredAt?: string
  note?: string
  asExpense?: boolean
}): Promise<void> {
  await requireAuth()
  const amount = Math.round(input.amount * 100) / 100
  if (!Number.isFinite(amount) || amount === 0) return
  const [goal] = await db.select().from(goals).where(eq(goals.id, input.goalId)).limit(1)
  if (!goal || goal.kind !== 'savings') return
  const occurredAt = input.occurredAt || todayIso()
  const before = await currentSavingsValue(goal.id)

  let transactionId: number | null = null
  if (input.asExpense && amount > 0) {
    const merchantId = await merchantIdByName('Investment (iTrade)', 'Investment')
    const [txn] = await db
      .insert(transactions)
      .values({
        source: 'scotia',
        flow: 'expense',
        externalId: `goal:${goal.id}:manual:${randomUUID().slice(0, 8)}`,
        txnDate: occurredAt,
        rawDescription: `Goal contribution — ${goal.name}`,
        merchantId,
        amount: amount.toFixed(2),
      })
      .returning({ id: transactions.id })
    transactionId = txn.id
  }

  await db.insert(goalEntries).values({
    goalId: goal.id,
    kind: 'contribution',
    amount: amount.toFixed(2),
    transactionId,
    occurredAt,
    note: input.note?.trim() || null,
  })
  await notifyGoalChange(goal, before, before + amount)
  revalidateGoals()
}

/**
 * Spend money out of a savings goal — the goal acting as a savings account for a
 * specific purpose (e.g. pull from "Travel" to fund a flight). Reduces the goal's
 * value via a negative contribution. `asIncome` (the default) also inserts a real
 * income transaction in the "Goal Spend" category so it offsets the purchase and
 * net stays correct; turning it off just lowers the goal with no budget impact.
 *
 * When the real money moves in from the investment account, attribute the imported
 * deposit via the dashboard inbound review instead, so you don't count it twice.
 */
export async function spendFromGoal(input: {
  goalId: number
  amount: number
  occurredAt?: string
  note?: string
  asIncome?: boolean
  /** Category for the offsetting income — e.g. spend from a kitchen-reno goal
   *  into "Home" so it lands in the right category. Falls back to the generic
   *  "Goal Spend" bucket when omitted. Only used when `asIncome` is not false. */
  categoryId?: number | null
}): Promise<void> {
  await requireAuth()
  const requested = Math.round(input.amount * 100) / 100
  if (!Number.isFinite(requested) || requested <= 0) return
  const [goal] = await db.select().from(goals).where(eq(goals.id, input.goalId)).limit(1)
  if (!goal || goal.kind !== 'savings') return
  const before = await currentSavingsValue(goal.id)
  if (before <= 0) return
  // Can't spend more than the goal holds.
  const amount = Math.min(requested, before)
  const occurredAt = input.occurredAt || todayIso()

  let transactionId: number | null = null
  if (input.asIncome !== false) {
    const categoryId = (await validCategoryId(input.categoryId)) ?? (await categoryIdByName('Goal Spend'))
    const merchantId = await merchantIdByName('Goal Withdrawal', 'Goal Spend')
    const [txn] = await db
      .insert(transactions)
      .values({
        source: 'scotia',
        flow: 'income',
        categoryId,
        externalId: `goal:${goal.id}:spend:${randomUUID().slice(0, 8)}`,
        txnDate: occurredAt,
        rawDescription: `Goal spend — ${goal.name}`,
        merchantId,
        // Income is stored negative (money in); see the sign convention.
        amount: (-amount).toFixed(2),
      })
      .returning({ id: transactions.id })
    transactionId = txn.id
  }

  await db.insert(goalEntries).values({
    goalId: goal.id,
    kind: 'contribution',
    amount: (-amount).toFixed(2),
    transactionId,
    occurredAt,
    note: input.note?.trim() || 'Goal spend',
  })
  await notifyGoalChange(goal, before, before - amount)
  revalidateGoals()
}

/**
 * Move money between two savings goals. Writes the two balancing ledger rows
 * (kind 'transfer': −amount on the source, +amount on the destination) plus a
 * goal_transfers record. Creates NO transaction (the money already left net when
 * first contributed), so it never touches the budget/analytics and never notifies.
 * Returns the amount actually moved (capped at the source's value).
 */
async function moveBetweenGoals(
  fromId: number,
  toId: number,
  requested: number,
  kind: 'transfer' | 'borrow' | 'repay',
  note?: string,
): Promise<number> {
  if (fromId === toId) return 0
  const amount = Math.round(requested * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0) return 0
  const [from] = await db.select().from(goals).where(eq(goals.id, fromId)).limit(1)
  const [to] = await db.select().from(goals).where(eq(goals.id, toId)).limit(1)
  if (!from || from.kind !== 'savings' || !to || to.kind !== 'savings') return 0
  const fromValue = await currentSavingsValue(fromId)
  const moved = Math.min(amount, fromValue)
  if (moved <= 0) return 0
  const occurredAt = todayIso()
  const trimmedNote = note?.trim() || null

  await db.insert(goalEntries).values([
    { goalId: fromId, kind: 'transfer', amount: (-moved).toFixed(2), occurredAt, note: trimmedNote },
    { goalId: toId, kind: 'transfer', amount: moved.toFixed(2), occurredAt, note: trimmedNote },
  ])
  await db.insert(goalTransfers).values({
    fromGoalId: fromId,
    toGoalId: toId,
    amount: moved.toFixed(2),
    kind,
    occurredAt,
    note: trimmedNote,
  })
  return moved
}

/** Outstanding amount still owed back to a lender goal (Σ borrow − Σ repay). */
async function outstandingOwedTo(lenderId: number): Promise<number> {
  const rows = await db
    .select({ kind: goalTransfers.kind, amount: goalTransfers.amount, fromGoalId: goalTransfers.fromGoalId, toGoalId: goalTransfers.toGoalId })
    .from(goalTransfers)
  let owed = 0
  for (const r of rows) {
    if (r.kind === 'borrow' && r.fromGoalId === lenderId) owed += Number(r.amount)
    else if (r.kind === 'repay' && r.toGoalId === lenderId) owed -= Number(r.amount)
  }
  return Math.max(0, Math.round(owed * 100) / 100)
}

/**
 * Transfer money from one savings goal to another. `borrowed` records it as a debt
 * the source goal is owed back (repay it later with repayGoalBorrow); otherwise it
 * is a permanent rebalance. No notification, no transaction.
 */
export async function transferBetweenGoals(input: {
  fromGoalId: number
  toGoalId: number
  amount: number
  borrowed?: boolean
  note?: string
}): Promise<void> {
  await requireAuth()
  await moveBetweenGoals(
    input.fromGoalId,
    input.toGoalId,
    input.amount,
    input.borrowed ? 'borrow' : 'transfer',
    input.note,
  )
  revalidateGoals()
}

/**
 * Repay a borrow: move money from the borrower goal back to the lender, reducing
 * the lender's outstanding "owed back" figure. Capped at both the borrower's value
 * and the amount actually owed. No notification, no transaction.
 */
export async function repayGoalBorrow(input: {
  fromGoalId: number // borrower
  toGoalId: number // lender
  amount: number
  note?: string
}): Promise<void> {
  await requireAuth()
  const owed = await outstandingOwedTo(input.toGoalId)
  if (owed <= 0) return
  const capped = Math.min(Math.round(input.amount * 100) / 100, owed)
  await moveBetweenGoals(input.fromGoalId, input.toGoalId, capped, 'repay', input.note)
  revalidateGoals()
}

/** Reconcile a savings goal to a new market value (stocks move up/down). */
export async function adjustValue(input: {
  goalId: number
  newValue: number
  occurredAt?: string
  note?: string
}): Promise<void> {
  await requireAuth()
  const newValue = Math.round(input.newValue * 100) / 100
  if (!Number.isFinite(newValue)) return
  const [goal] = await db.select().from(goals).where(eq(goals.id, input.goalId)).limit(1)
  if (!goal || goal.kind !== 'savings') return
  const before = await currentSavingsValue(goal.id)
  const delta = Math.round((newValue - before) * 100) / 100
  if (delta === 0) return
  await db.insert(goalEntries).values({
    goalId: goal.id,
    kind: 'adjustment',
    amount: delta.toFixed(2),
    occurredAt: input.occurredAt || todayIso(),
    note: input.note?.trim() || 'Market value adjustment',
  })
  await notifyGoalChange(goal, before, newValue)
  revalidateGoals()
}

/**
 * Record a new mortgage balance from a statement. Back-solves the implied annual
 * rate from the previous snapshot + the payments since, so the next projection
 * is sharper (the "smart" piece). Lower balance = progress.
 */
export async function updateMortgageBalance(input: {
  goalId: number
  newBalance: number
  occurredAt?: string
}): Promise<void> {
  await requireAuth()
  const newBalance = Math.round(input.newBalance * 100) / 100
  if (!Number.isFinite(newBalance) || newBalance < 0) return
  const [goal] = await db.select().from(goals).where(eq(goals.id, input.goalId)).limit(1)
  if (!goal || goal.kind !== 'mortgage') return
  const occurredAt = input.occurredAt || todayIso()

  // Previous balance snapshot, for the rate back-solve + the notification delta.
  const prior = await db
    .select({ amount: goalEntries.amount, occurredAt: goalEntries.occurredAt })
    .from(goalEntries)
    .where(and(eq(goalEntries.goalId, goal.id), eq(goalEntries.kind, 'balance')))
    .orderBy(asc(goalEntries.occurredAt))
  const prev = prior.length ? prior[prior.length - 1] : null

  await db.insert(goalEntries).values({
    goalId: goal.id,
    kind: 'balance',
    amount: newBalance.toFixed(2),
    occurredAt,
    note: 'Statement balance',
  })

  if (prev) {
    const flows = await loadAllFlows()
    const between = mortgagePayments(flows)
      .filter((p) => p.ym > prev.occurredAt.slice(0, 7) && p.ym <= occurredAt.slice(0, 7))
      .map((p) => p.regular + p.extra)
    const rate = inferRate(Number(prev.amount), newBalance, between)
    if (rate !== null) await db.update(goals).set({ annualRate: rate.toFixed(4) }).where(eq(goals.id, goal.id))
    await notifyGoalChange(goal, Number(prev.amount), newBalance)
  }
  revalidateGoals()
}

export type ReviewAllocation = { goalId: number; amount: number }

/** Tag goal allocations to a transaction. `sign` = +1 grows goals (outbound
 *  contribution), −1 reduces them (inbound spend). Returns nothing. */
async function allocateToGoals(
  allocations: ReviewAllocation[],
  txn: { id: number; txnDate: string },
  sign: 1 | -1,
  note: string,
): Promise<void> {
  const valid = allocations.filter((a) => a.amount > 0 && Number.isInteger(a.goalId))
  for (const a of valid) {
    const [goal] = await db.select().from(goals).where(eq(goals.id, a.goalId)).limit(1)
    if (!goal || goal.kind !== 'savings') continue
    const before = await currentSavingsValue(goal.id)
    const delta = sign * (Math.round(a.amount * 100) / 100)
    await db.insert(goalEntries).values({
      goalId: goal.id,
      kind: 'contribution',
      amount: delta.toFixed(2),
      transactionId: txn.id,
      occurredAt: txn.txnDate,
      note,
    })
    await notifyGoalChange(goal, before, before + delta)
  }
}

/**
 * Resolve a dashboard transfer review.
 *
 * Outbound ('out' — money moving to investments):
 *  - 'expense'  → keep it an Investment expense; tag the allocations to goals.
 *  - 'neutral'  → re-flag as a transfer (better-interest move; leaves analytics);
 *                 still tag the allocations so the goal value grows.
 *  - 'mortgage' → not a goal: recategorize to Home / Mortgage (extra principal).
 *
 * Inbound ('in' — money returning from investments):
 *  - 'goal'     → keep it income (category Goal Spend) so it offsets the real
 *                 purchase; tag the allocations to REDUCE those goals.
 *  - 'income'   → keep it as plain Other Income, not tied to any goal.
 *  - 'ignore'   → re-flag as a transfer (an investment move we don't track).
 *
 * Both: 'dismiss' → leave the transaction as-is.
 */
export async function resolveTransferReview(input: {
  reviewId: number
  treatment: 'expense' | 'neutral' | 'mortgage' | 'goal' | 'income' | 'ignore' | 'transfer' | 'dismiss'
  allocations?: ReviewAllocation[]
  /** Outbound only: tag this transfer as a contribution to a TFSA/RESP account so
   *  its contribution room / grant recalculates. A pure overlay — does not change
   *  the transaction's flow or category. */
  registeredAccountId?: number | null
}): Promise<void> {
  await requireAuth()
  const [review] = await db.select().from(transferReviews).where(eq(transferReviews.id, input.reviewId)).limit(1)
  if (!review || review.status !== 'pending') return
  const [txn] = await db.select().from(transactions).where(eq(transactions.id, review.transactionId)).limit(1)
  if (!txn) return

  const resolve = (status: 'resolved' | 'dismissed') =>
    db.update(transferReviews).set({ status, resolvedAt: new Date() }).where(eq(transferReviews.id, review.id))

  if (input.treatment === 'dismiss') {
    await resolve('dismissed')
    revalidateGoals()
    return
  }

  // Plain internal transfer between the owner's own accounts (either leg) — not
  // income, not a goal. flow=transfer keeps it out of spend/runway/safe-to-move
  // while the Emergency Fund still moves the account balance (it ignores flow).
  if (input.treatment === 'transfer') {
    const transferId = await categoryIdByName('Transfer')
    await db.update(transactions).set({ flow: 'transfer', categoryId: transferId }).where(eq(transactions.id, txn.id))
    await resolve('resolved')
    revalidateGoals()
    return
  }

  if (review.direction === 'in') {
    if (input.treatment === 'goal') {
      const goalSpendId = await categoryIdByName('Goal Spend')
      await db.update(transactions).set({ flow: 'income', categoryId: goalSpendId }).where(eq(transactions.id, txn.id))
      await allocateToGoals(input.allocations ?? [], txn, -1, 'Goal spend')
    } else if (input.treatment === 'ignore') {
      const transferId = await categoryIdByName('Transfer')
      await db.update(transactions).set({ flow: 'transfer', categoryId: transferId }).where(eq(transactions.id, txn.id))
    } else {
      // 'income' → keep it as plain Other Income, not tied to a goal.
      const otherId = await categoryIdByName('Other Income')
      await db.update(transactions).set({ flow: 'income', categoryId: otherId }).where(eq(transactions.id, txn.id))
    }
    await resolve('resolved')
    revalidateGoals()
    return
  }

  // Outbound.
  if (input.treatment === 'mortgage') {
    const homeId = await categoryIdByName('Home')
    const merchantId = await merchantIdByName('Mortgage', 'Home')
    await db
      .update(transactions)
      .set({ flow: 'expense', categoryId: homeId, merchantId })
      .where(eq(transactions.id, txn.id))
    await resolve('resolved')
    revalidateGoals()
    return
  }

  // expense | neutral
  if (input.treatment === 'neutral') {
    const transferId = await categoryIdByName('Transfer')
    await db.update(transactions).set({ flow: 'transfer', categoryId: transferId }).where(eq(transactions.id, txn.id))
  } else {
    const investId = await categoryIdByName('Investment')
    await db.update(transactions).set({ flow: 'expense', categoryId: investId }).where(eq(transactions.id, txn.id))
  }
  await allocateToGoals(input.allocations ?? [], txn, 1, 'From transfer')
  // Tag the transfer to a registered account (TFSA/RESP) if chosen, so the
  // contribution room / grant recalculates. Pure overlay — flow/category above
  // are unchanged. Uses the transfer's absolute amount (outbound is stored +).
  if (input.registeredAccountId && Number.isInteger(input.registeredAccountId)) {
    await recordTransferContribution({
      accountId: input.registeredAccountId,
      transactionId: txn.id,
      amount: Math.abs(Number(txn.amount)),
      occurredAt: txn.txnDate,
    })
  }
  await resolve('resolved')
  revalidateGoals()
}
