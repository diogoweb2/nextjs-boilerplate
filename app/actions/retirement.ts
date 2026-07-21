'use server'

import { revalidatePath } from 'next/cache'
import { and, asc, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  holdingSnapshots,
  registeredAccounts,
  retirementSettings,
} from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { isDemoSession } from '@/app/lib/demo'
import {
  loadAllFlows,
  anchorMonth,
  monthKey,
  addMonths,
  type EnrichedTxn,
} from '@/app/lib/analytics'
import { loadMortgageProjection } from '@/app/actions/goals'
import {
  buildRetirementPlan,
  type RetirementInputs,
  type RetirementParams,
  type PlanResult,
} from '@/app/lib/retirement'
import {
  computeDefaults,
  type CategoryAverages,
  type DerivedForDefaults,
} from '@/app/lib/retirement-defaults'
import { grossUpFromNet } from '@/app/lib/canada-rules'

const round2 = (n: number) => Math.round(n * 100) / 100

// Neutral fallbacks only — real birthdates live in .env.local (gitignored).
const OWNER_BIRTHDATE = process.env.OWNER_BIRTHDATE || '1980-01-01'
const PARTNER_BIRTHDATE = process.env.PARTNER_BIRTHDATE || '1981-01-01'
const SELF_NAME = process.env.SELF_NAME || 'Me'
const PARTNER_NAME = process.env.PARTNER_NAME || 'Partner'
const KID1_NAME = process.env.KID1_NAME || 'your son'
const KID2_NAME = process.env.KID2_NAME || 'your other kid'

function birthYearOf(iso: string): number {
  return Number(iso.slice(0, 4)) || 1981
}

export type RetirementData = {
  inputs: RetirementInputs
  /** Full engine defaults (the consultant's numbers), pre-override. */
  defaults: RetirementParams
  /** The owner's saved overrides (subset of RetirementParams). */
  overrides: Partial<RetirementParams>
  /** defaults merged with overrides — the effective params. */
  params: RetirementParams
  /** A first plan render (the client recomputes live on slider changes). */
  plan: PlanResult
  /** RRSP balances shown as editable inputs. */
  rrsp: { self: number; partner: number; selfAsOf: string | null; partnerAsOf: string | null; partnerIsEstimate: boolean }
  /** Which inputs came from a live derived source (for the "live" dot). */
  derivedFlags: { selfSalary: boolean; partnerSalary: boolean; spend: boolean; tfsa: boolean }
  names: { self: string; partner: string; kid1: string; kid2: string }
  rulesLastVerified: string
}

/**
 * Assemble all derived inputs for the Retirement Consultant (RETIREMENT_PLAN §3),
 * run the engine once, and return everything the client needs. Read-only, recomputed
 * on every load (no cached projection) so importing better income silently updates
 * the plan. Robust to missing data via sensible fallbacks so the page always renders.
 */
export async function loadRetirementData(): Promise<RetirementData> {
  if (await isDemoSession()) {
    const { demoRetirementData } = await import('@/app/lib/demo-data')
    return demoRetirementData()
  }

  const [flows, mortgage, rrspRows, settingsRow] = await Promise.all([
    loadAllFlows(),
    loadMortgageProjection(),
    loadRrspAccounts(),
    db.select().from(retirementSettings).limit(1),
  ])

  const currentYear = new Date().getFullYear()
  const anchor = anchorMonth(flows) ?? `${currentYear}-01`

  // ── Salaries: net monthly from payroll deposits, grossed-up for CPP/HOOPP ──
  // Self salary = Tangerine 'Salary' income; partner = Scotia 'Salary' income.
  const { selfNetMonthly, partnerNetMonthly, hasSelf, hasPartner } = salaryMonthly(flows, anchor)
  const selfGross = grossUpFromNet(selfNetMonthly * 12)
  const partnerGross = grossUpFromNet(partnerNetMonthly * 12)

  // ── Spending baseline + category averages (trailing 12 complete months) ──
  const { categoryMonthly, totalMonthly, hasSpend } = categoryAveragesTrailing12(flows, anchor)
  const mortgagePortionMonthly = mortgage?.regularPayment ?? 0

  // ── Investments: TFSA + DC from holdings snapshots ──
  const { tfsaTotal, dcBalance } = await investmentBalances()

  // ── Mortgage payoff ──
  const mortgagePayoffYear = mortgage ? Number(mortgage.targetYm.slice(0, 4)) : currentYear + 5
  const monthlyMortgagePayment = mortgage?.regularPayment ?? mortgagePortionMonthly

  const inputs: RetirementInputs = {
    currentYear,
    self: {
      birthYear: birthYearOf(OWNER_BIRTHDATE),
      grossSalary: selfGross || 95000,
      realSalaryGrowth: 0, // owner's instruction: don't assume growth (§5.1)
      careerStartYear: 2010,
      careerStartSalary: 50000,
      arrivalYear: 2009,
    },
    partner: {
      birthYear: birthYearOf(PARTNER_BIRTHDATE),
      grossSalary: partnerGross || 80000,
      realSalaryGrowth: 0, // partner grows with inflation → flat in real terms
      careerStartYear: 2011,
      careerStartSalary: 35000,
      arrivalYear: 2010,
    },
    selfRrsp: rrspRows.self,
    partnerRrsp: rrspRows.partner,
    tfsaTotal,
    dcBalance,
    currentEquityFraction: 0.55,
    houseValue: 1200000,
    mortgagePayoffYear,
    monthlyMortgagePayment,
    currentMonthlySpend: totalMonthly || 8000,
    monthlyRrspContribution: categoryMonthly['Investment'] ? categoryMonthly['Investment'] * 0.6 : 900,
    monthlyTfsaContribution: categoryMonthly['Investment'] ? categoryMonthly['Investment'] * 0.4 : 300,
  }

  const derived: DerivedForDefaults = { inputs, categoryMonthly, mortgagePortionMonthly }
  const defaults = computeDefaults(derived)
  // Default retirement age = the engine's recommended (earliest funding) age.
  const recommended = buildRetirementPlan(inputs, defaults).recommendedRetireAge
  if (recommended) defaults.retirementAge = recommended

  const overrides = (settingsRow[0]?.overrides ?? {}) as Partial<RetirementParams>
  const params = mergeParams(defaults, overrides)
  const plan = buildRetirementPlan(inputs, params)

  return {
    inputs,
    defaults,
    overrides,
    params,
    plan,
    rrsp: {
      self: rrspRows.self,
      partner: rrspRows.partner,
      selfAsOf: rrspRows.selfAsOf,
      partnerAsOf: rrspRows.partnerAsOf,
      partnerIsEstimate: rrspRows.partnerIsEstimate,
    },
    derivedFlags: { selfSalary: hasSelf, partnerSalary: hasPartner, spend: hasSpend, tfsa: tfsaTotal > 0 },
    names: { self: SELF_NAME, partner: PARTNER_NAME, kid1: KID1_NAME, kid2: KID2_NAME },
    rulesLastVerified: '2026-07',
  }
}

/** Merge engine defaults with saved overrides (overrides win, key-by-key). */
function mergeParams(defaults: RetirementParams, overrides: Partial<RetirementParams>): RetirementParams {
  const merged: RetirementParams = { ...defaults }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === null) continue
    // tierMonthly is a nested object — shallow-merge it.
    if (k === 'tierMonthly' && typeof v === 'object') {
      merged.tierMonthly = { ...defaults.tierMonthly, ...(v as RetirementParams['tierMonthly']) }
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(merged as any)[k] = v
    }
  }
  return merged
}

/* ─────────────────────────── Derived assembly helpers ─────────────────────────── */

function salaryMonthly(flows: EnrichedTxn[], anchor: string) {
  // Trailing 12 complete months (exclude the in-progress anchor month).
  const start = addMonths(anchor, -12)
  const inWindow = (t: EnrichedTxn) => {
    const ym = monthKey(t.txnDate)
    return ym >= start && ym < anchor
  }
  let self = 0
  let partner = 0
  for (const t of flows) {
    if (t.flow !== 'income' || t.categoryName !== 'Salary' || !inWindow(t)) continue
    const amt = -t.amount // income is stored negative
    if (t.source === 'tangerine') self += amt
    else if (t.source === 'scotia') partner += amt
  }
  return {
    selfNetMonthly: round2(self / 12),
    partnerNetMonthly: round2(partner / 12),
    hasSelf: self > 0,
    hasPartner: partner > 0,
  }
}

function categoryAveragesTrailing12(flows: EnrichedTxn[], anchor: string): {
  categoryMonthly: CategoryAverages
  totalMonthly: number
  hasSpend: boolean
} {
  const start = addMonths(anchor, -12)
  const byCat: Record<string, number> = {}
  let total = 0
  let count = 0
  for (const t of flows) {
    if (t.flow !== 'expense' || t.isSpecial) continue
    const ym = monthKey(t.txnDate)
    if (ym < start || ym >= anchor) continue
    if (t.amount <= 0) continue // net refunds handled coarsely; positive = spend
    byCat[t.categoryName] = (byCat[t.categoryName] ?? 0) + t.amount
    total += t.amount
    count++
  }
  const categoryMonthly: CategoryAverages = {}
  for (const [k, v] of Object.entries(byCat)) categoryMonthly[k] = round2(v / 12)
  return { categoryMonthly, totalMonthly: round2(total / 12), hasSpend: count > 0 }
}

async function investmentBalances(): Promise<{ tfsaTotal: number; dcBalance: number }> {
  const rows = await db
    .select({
      kind: registeredAccounts.kind,
      total: holdingSnapshots.totalValueCad,
      occurredAt: holdingSnapshots.occurredAt,
      accountId: holdingSnapshots.accountId,
    })
    .from(holdingSnapshots)
    .innerJoin(registeredAccounts, eq(holdingSnapshots.accountId, registeredAccounts.id))
    .where(eq(registeredAccounts.archived, false))
    .orderBy(asc(holdingSnapshots.occurredAt))

  // Latest snapshot per account.
  const latestByAccount = new Map<number, { kind: string; total: number }>()
  for (const r of rows) latestByAccount.set(r.accountId, { kind: r.kind, total: Number(r.total) })
  let tfsa = 0
  let dc = 0
  for (const { kind, total } of latestByAccount.values()) {
    if (kind === 'tfsa') tfsa += total
    else if (kind === 'nonreg' || kind === 'fhsa') dc += total // DC/matched treated as non-registered growth
  }
  return { tfsaTotal: round2(tfsa), dcBalance: round2(dc) }
}

/** RRSP balances from registered_accounts (self/partner), latest holding snapshot. */
async function loadRrspAccounts(): Promise<{
  self: number
  partner: number
  selfAsOf: string | null
  partnerAsOf: string | null
  partnerIsEstimate: boolean
}> {
  const accounts = await db
    .select()
    .from(registeredAccounts)
    .where(and(eq(registeredAccounts.kind, 'rrsp'), eq(registeredAccounts.archived, false)))

  let self = 0
  let partner = 0
  let selfAsOf: string | null = null
  let partnerAsOf: string | null = null
  let partnerIsEstimate = true

  for (const acc of accounts) {
    const [snap] = await db
      .select()
      .from(holdingSnapshots)
      .where(eq(holdingSnapshots.accountId, acc.id))
      .orderBy(desc(holdingSnapshots.occurredAt))
      .limit(1)
    const val = snap ? Number(snap.totalValueCad) : 0
    if (acc.owner === 'partner') {
      partner += val
      partnerAsOf = snap?.occurredAt ?? null
      // A note in the account name flags the estimate; owner will confirm.
      partnerIsEstimate = /estimate/i.test(acc.name)
    } else {
      self += val
      selfAsOf = snap?.occurredAt ?? null
    }
  }
  return { self: round2(self), partner: round2(partner), selfAsOf, partnerAsOf, partnerIsEstimate }
}

/* ─────────────────────────── Mutations ─────────────────────────── */

/** Save a subset of parameter overrides (play-mode Save). Overrides only. */
export async function saveParams(overrides: Partial<RetirementParams>): Promise<void> {
  await requireAuth()
  const [existing] = await db.select().from(retirementSettings).limit(1)
  const clean = sanitizeOverrides(overrides)
  if (existing) {
    await db
      .update(retirementSettings)
      .set({ overrides: clean, updatedAt: new Date() })
      .where(eq(retirementSettings.id, existing.id))
  } else {
    await db.insert(retirementSettings).values({ overrides: clean })
  }
  revalidatePath('/accounts/retirement')
}

/** Restore defaults = delete overrides so future default improvements flow through. */
export async function resetParams(): Promise<void> {
  await requireAuth()
  const [existing] = await db.select().from(retirementSettings).limit(1)
  if (existing) {
    await db
      .update(retirementSettings)
      .set({ overrides: {}, updatedAt: new Date() })
      .where(eq(retirementSettings.id, existing.id))
  }
  revalidatePath('/accounts/retirement')
}

/**
 * Set an RRSP balance for self/partner. Reuses registered_accounts (kind 'rrsp')
 * + a manual holding_snapshots row (totalValueCad only, no positions) — so future
 * T4/statement ingestion and the net-worth card get RRSP for free.
 */
export async function saveRrspBalance(
  owner: 'self' | 'partner',
  amount: number
): Promise<void> {
  await requireAuth()
  if (!Number.isFinite(amount) || amount < 0) return
  const value = String(round2(amount))
  const [acc] = await db
    .select()
    .from(registeredAccounts)
    .where(and(eq(registeredAccounts.kind, 'rrsp'), eq(registeredAccounts.owner, owner)))
    .limit(1)

  let accountId: number
  if (acc) {
    accountId = acc.id
  } else {
    const name = owner === 'partner' ? `${PARTNER_NAME} RRSP (estimate)` : `${SELF_NAME} RRSP`
    const [created] = await db
      .insert(registeredAccounts)
      .values({ kind: 'rrsp', name, owner, currency: 'CAD' })
      .returning({ id: registeredAccounts.id })
    accountId = created.id
  }

  const today = new Date().toISOString().slice(0, 10)
  await db.insert(holdingSnapshots).values({
    accountId,
    occurredAt: today,
    fxUsdCad: '1',
    totalValueCad: value,
  })
  revalidatePath('/accounts/retirement')
  revalidatePath('/accounts/networth')
}

function sanitizeOverrides(o: Partial<RetirementParams>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const numeric = new Set<keyof RetirementParams>([
    'retirementAge', 'partnerRetirementAgeOffset', 'inflation', 'equityReturn', 'bondReturn',
    'fees', 'postMortgageRedirect', 'extraMonthlySavings', 'selfCppAge', 'partnerCppAge',
    'selfOasAge', 'partnerOasAge', 'hooppServiceStartYear', 'hooppIndexingOfCpi', 'glideBase',
    'glideEquityFloor', 'deriskStartYearsBeforeRetire', 'tfsaFloorMonths', 'tfsaFloorMonthsPostMortgage',
    'sellHouseAge', 'houseAppreciation', 'crisisEveryYears', 'crisisEquityDrop', 'crisisRecoveryYears',
    'rdspAnnualContribution', 'planToAge',
  ])
  for (const key of numeric) {
    const v = o[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
  }
  if (o.lifestyle === 'essentials' || o.lifestyle === 'today' || o.lifestyle === 'snowbird') out.lifestyle = o.lifestyle
  if (typeof o.sellHouse === 'boolean') out.sellHouse = o.sellHouse
  if (typeof o.crisisEnabled === 'boolean') out.crisisEnabled = o.crisisEnabled
  if (typeof o.rdspOpen === 'boolean') out.rdspOpen = o.rdspOpen
  if (o.tierMonthly && typeof o.tierMonthly === 'object') {
    const t: Record<string, number> = {}
    for (const tier of ['essentials', 'today', 'snowbird'] as const) {
      const v = o.tierMonthly[tier]
      if (typeof v === 'number' && Number.isFinite(v)) t[tier] = v
    }
    if (Object.keys(t).length) out.tierMonthly = t
  }
  return out
}
