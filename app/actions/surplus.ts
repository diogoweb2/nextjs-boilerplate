'use server'

import { revalidatePath } from 'next/cache'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { goals, goalEntries, monthAllocations } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { isDemoSession } from '@/app/lib/demo'
import { loadAllFlows, anchorMonth, netOverRange } from '@/app/lib/analytics'
import {
  completedNetPositiveMonths,
  defaultPercents,
  autoContributePreselect,
  allocationAmounts,
  totalPercent,
  isLastDayOfMonth,
  SURPLUS_START_MONTH,
} from '@/app/lib/surplus'
import { addContribution } from '@/app/actions/goals'
import { savingsValue } from '@/app/lib/goals'
import { paydayContext } from '@/app/lib/income'

const EPS = 0.005

export type SurplusPrompt = {
  /** The completed (source) month, YYYY-MM. */
  month: string
  /** Net (income − spend) for that month — the surplus to give a job. */
  net: number
  /** Whether a Net-Zero goal exists (then it's the implicit remainder bucket). */
  hasNetZero: boolean
  /** Display label for the Net-Zero remainder row, e.g. "Net-Zero 2026". */
  netZeroLabel: string | null
  /**
   * Minimum dollars to leave for Net-Zero this month to stay on the Dec 31
   * required-path slope: (-completedBaseline / monthsRemaining). Null when
   * there is no Net-Zero goal or the year is already in the black.
   */
  minNetZero: number | null
  /** Eligible savings goals to allocate to (mortgage & net-zero excluded), in
   *  priority order (goal sortOrder). `autoContribute` is the fixed monthly rule. */
  goals: {
    id: number
    name: string
    emoji: string
    color: string
    autoContribute: number | null
    /** Current balance and target, so a slice can be shown as progress. */
    saved: number
    target: number | null
  }[]
  /** Preselected savings-goal percentages ({ "<goalId>": pct }, may be fractional). */
  preselect: Record<string, number>
  /**
   * Decision context — a 3-paycheque month's surplus is not repeatable capacity.
   * `typicalNet` is the month's net minus the whole extra cheque (what a normal
   * 2-cheque month nets); both are null in an ordinary month. See §10b.
   */
  extraCheque: number
  typicalNet: number | null
}

function lastDayOf(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  // Day 0 of the next month = the last day of month `m` (1-based).
  const d = new Date(y, m, 0).getDate()
  return `${ym}-${String(d).padStart(2, '0')}`
}

/** Local (not UTC) today as YYYY-MM-DD — the prompt fires on the last local day. */
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function revalidate() {
  revalidatePath('/')
  revalidatePath('/goals')
}

async function eligibleGoals() {
  return db
    .select({
      id: goals.id,
      name: goals.name,
      emoji: goals.emoji,
      color: goals.color,
      autoContribute: goals.autoContribute,
      targetAmount: goals.targetAmount,
    })
    .from(goals)
    .where(and(eq(goals.kind, 'savings'), eq(goals.archived, false)))
    .orderBy(asc(goals.sortOrder), asc(goals.createdAt))
}

/**
 * Current balance per savings goal, so the prompt can show what a slice actually
 * does ("$1,200 of $5,000 → $1,900"). Deciding where money goes is much easier
 * when each goal's distance from its target is visible at the point of decision.
 */
async function goalBalances(ids: number[]): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ goalId: goalEntries.goalId, kind: goalEntries.kind, amount: goalEntries.amount, occurredAt: goalEntries.occurredAt })
    .from(goalEntries)
    .where(inArray(goalEntries.goalId, ids))
  const byGoal = new Map<number, { kind: string; amount: number; occurredAt: string }[]>()
  for (const r of rows) {
    const list = byGoal.get(r.goalId) ?? []
    list.push({ kind: r.kind, amount: Number(r.amount), occurredAt: r.occurredAt })
    byGoal.set(r.goalId, list)
  }
  const out = new Map<number, number>()
  for (const [id, list] of byGoal) out.set(id, savingsValue(list as Parameters<typeof savingsValue>[0]))
  return out
}

async function activeNetZero() {
  const [g] = await db
    .select({ id: goals.id, name: goals.name })
    .from(goals)
    .where(and(eq(goals.kind, 'netzero'), eq(goals.archived, false)))
    .limit(1)
  return g ?? null
}

async function actionedMonths(): Promise<Set<string>> {
  const rows = await db.select({ month: monthAllocations.month }).from(monthAllocations)
  return new Set(rows.map((r) => r.month))
}

async function prevAllocatedPercents(): Promise<Record<string, number> | null> {
  const [row] = await db
    .select({ percents: monthAllocations.percents })
    .from(monthAllocations)
    .where(eq(monthAllocations.status, 'allocated'))
    .orderBy(desc(monthAllocations.month))
    .limit(1)
  return row?.percents ?? null
}

/**
 * When a Net-Zero goal exists, auto-resolve every net-positive completed month
 * that ISN'T the most recent open one to "all to Net-Zero" (a dismissed row with
 * empty percents). This implements "forget to allocate → it just goes to
 * Net-Zero," keeps only the latest month prompting, and stops old months
 * resurfacing if Net-Zero later disappears. Idempotent. With no Net-Zero goal,
 * nothing is auto-resolved — months stack as separate prompts.
 */
export async function reconcileSurplusAllocations(): Promise<void> {
  const nz = await activeNetZero()
  if (!nz) return
  const flows = await loadAllFlows()
  const anchor = anchorMonth(flows.filter((t) => t.flow === 'expense'))
  const candidates = completedNetPositiveMonths(flows, anchor, SURPLUS_START_MONTH, todayIso())
  if (candidates.length === 0) return
  const actioned = await actionedMonths()
  const open = candidates.filter((c) => !actioned.has(c.ym)) // newest first
  // Keep the most recent open prompt; auto-dismiss the rest to Net-Zero.
  for (const c of open.slice(1)) {
    await db
      .insert(monthAllocations)
      .values({ month: c.ym, status: 'dismissed', percents: {} })
      .onConflictDoNothing({ target: monthAllocations.month })
  }
}

/** Surplus-allocation prompts to render at the top of the dashboard. */
export async function loadSurplusPrompts(): Promise<SurplusPrompt[]> {
  if (await isDemoSession()) {
    const { demoSurplusPrompts } = await import('@/app/lib/demo-data')
    return demoSurplusPrompts()
  }
  await reconcileSurplusAllocations()

  const flows = await loadAllFlows()
  const anchor = anchorMonth(flows.filter((t) => t.flow === 'expense'))
  const candidates = completedNetPositiveMonths(flows, anchor, SURPLUS_START_MONTH, todayIso())
  if (candidates.length === 0) return []

  if (!anchor) return []
  const actioned = await actionedMonths()
  const open = candidates.filter((c) => !actioned.has(c.ym)) // newest first
  if (open.length === 0) return []

  const [elig, nz, prev] = await Promise.all([
    eligibleGoals(),
    activeNetZero(),
    prevAllocatedPercents(),
  ])
  const balances = await goalBalances(elig.map((g) => g.id))
  const hasNetZero = nz !== null
  // With Net-Zero, only the most recent month prompts; otherwise all stack.
  const months = hasNetZero ? open.slice(0, 1) : open
  const eligibleIds = elig.map((g) => g.id)
  // Auto-contribute switches off once the goal hits its target — no target means
  // the rule never self-disables.
  const activeAuto = (g: (typeof elig)[number]): number | null => {
    const target = g.targetAmount === null ? null : Number(g.targetAmount)
    if (target !== null && (balances.get(g.id) ?? 0) >= target) return null
    return g.autoContribute === null ? null : Number(g.autoContribute)
  }
  // Priority order (= goal sortOrder, already applied) with the auto-contribute rule.
  const priority = elig.map((g) => ({
    id: g.id,
    autoContribute: activeAuto(g),
  }))
  const goalsView = elig.map((g) => ({
    id: g.id,
    name: g.name,
    emoji: g.emoji,
    color: g.color,
    autoContribute: activeAuto(g),
    saved: balances.get(g.id) ?? 0,
    target: g.targetAmount === null ? null : Number(g.targetAmount),
  }))

  // For the Net-Zero on-track indicator: the required monthly improvement is the
  // dashed-line slope = -completedBaseline / monthsRemaining (same formula as the
  // trajectory chart). Deficit carries automatically when the goal doesn't archive.
  const yearStart = `${anchor.slice(0, 4)}-01`
  const anchorNum = parseInt(anchor.slice(5, 7))
  const monthsRemaining = 12 - anchorNum + 1 // anchor month through December, inclusive

  // Preselect is per-month: auto-contribute amounts depend on each month's surplus.
  // Falls back to the equal-split / last-month default when no rule applies.
  return months.map((m) => {
    const autoSel = autoContributePreselect(m.net, priority, prev)
    const preselect =
      Object.keys(autoSel).length > 0 ? autoSel : defaultPercents(eligibleIds, prev, hasNetZero)

    let minNetZero: number | null = null
    if (hasNetZero && monthsRemaining > 0) {
      const baseline = netOverRange(flows, yearStart, m.ym)
      if (baseline < 0) {
        minNetZero = Math.round((-baseline / monthsRemaining) * 100) / 100
      }
    }

    // A 3-cheque month's surplus is the buffer for the 2-cheque months around
    // it, so the prompt shows what a normal month nets alongside the headline.
    const pay = paydayContext(flows, m.ym)
    const extra = pay && pay.paydays > pay.typicalPaydays ? pay.extraCheque : 0

    return {
      month: m.ym,
      net: m.net,
      hasNetZero,
      netZeroLabel: nz?.name ?? null,
      minNetZero,
      goals: goalsView,
      preselect,
      extraCheque: Math.round(extra * 100) / 100,
      typicalNet: extra > 0 ? Math.round((m.net - extra) * 100) / 100 : null,
    }
  })
}

/** Shared write path: carve savings slices for a month as Investment/Savings
 *  contributions dated to that month, then record the marker. */
async function applyAllocation(
  month: string,
  net: number,
  percents: Record<string, number>,
  status: 'allocated' | 'dismissed',
): Promise<void> {
  const occurredAt = lastDayOf(month)
  for (const a of allocationAmounts(net, percents)) {
    await addContribution({
      goalId: a.goalId,
      amount: a.amount,
      asExpense: true,
      occurredAt,
      note: `Surplus allocation ${month}`,
    })
  }
  await db
    .insert(monthAllocations)
    .values({ month, status, percents })
    .onConflictDoNothing({ target: monthAllocations.month })
}

/** Validate a month is a completed, net-positive, not-yet-actioned candidate.
 *  Returns its net, or null if it shouldn't be actioned. */
async function validatedMonth(month: string): Promise<number | null> {
  if (!/^\d{4}-\d{2}$/.test(month)) return null
  if (month < SURPLUS_START_MONTH) return null
  const actioned = await actionedMonths()
  if (actioned.has(month)) return null
  const flows = await loadAllFlows()
  const anchor = anchorMonth(flows.filter((t) => t.flow === 'expense'))
  // The anchor (in-progress) month is actionable on its last day only — the
  // one-day-early prompt.
  if (!anchor || month > anchor) return null
  if (month === anchor && !isLastDayOfMonth(anchor, todayIso())) return null
  const net = netOverRange(flows, month, month)
  return net > EPS ? net : null
}

/**
 * Confirm a surplus allocation. `percents` are the savings-goal shares; Net-Zero
 * is the implicit remainder, so it needs no write — the carved slices become
 * Investment/Savings contributions that lower the month's net by exactly their
 * total, leaving the rest to keep reducing the year's deficit.
 */
export async function confirmAllocation(input: {
  month: string
  percents: Record<string, number>
}): Promise<void> {
  await requireAuth()
  const net = await validatedMonth(input.month)
  if (net === null) return

  // Keep only positive shares for goals that still exist & are eligible.
  const elig = new Set((await eligibleGoals()).map((g) => g.id))
  const clean: Record<string, number> = {}
  for (const [idStr, pct] of Object.entries(input.percents)) {
    if (elig.has(Number(idStr)) && pct > 0) clean[idStr] = pct
  }
  const total = totalPercent(clean)
  if (total > 100 + EPS) return
  // No Net-Zero sink → every dollar must get a job (Σ = 100).
  const hasNetZero = (await activeNetZero()) !== null
  if (!hasNetZero && total < 100 - EPS) return

  await applyAllocation(input.month, net, clean, 'allocated')
  revalidate()
}

/**
 * Dismiss a month's prompt.
 *  - Net-Zero exists → send it all there (record dismissed, no writes; the
 *    surplus already counts toward Net-Zero via cumulative net).
 *  - No Net-Zero → auto-split by the previous month's allocation (or an equal
 *    split), since every dollar still needs a job.
 */
export async function dismissAllocation(input: { month: string }): Promise<void> {
  await requireAuth()
  const net = await validatedMonth(input.month)
  if (net === null) return

  const nz = await activeNetZero()
  if (nz) {
    await db
      .insert(monthAllocations)
      .values({ month: input.month, status: 'dismissed', percents: {} })
      .onConflictDoNothing({ target: monthAllocations.month })
    revalidate()
    return
  }

  const elig = (await eligibleGoals()).map((g) => g.id)
  const prev = await prevAllocatedPercents()
  const percents = defaultPercents(elig, prev, false)
  await applyAllocation(input.month, net, percents, 'allocated')
  revalidate()
}
