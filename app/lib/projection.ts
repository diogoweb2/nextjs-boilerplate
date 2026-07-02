/**
 * Projected recurring bills + the dashboard burn-down model. Pure & db-free
 * (operates on rows from `loadAllFlows`), like budget.ts / custom-reports.ts, so
 * it can be unit-tested and shared by the budget page, dashboard and Settings.
 * See BUSINESS_RULES.md §8b/§8c.
 *
 * Concept: only Mortgage & Property Tax are always-fixed categories. Everything
 * else "unavoidable" is a per-merchant *projected bill* (Toronto Water, Belair,
 * Scholars, Hydro …) that may not hit every month. We project its amount from
 * history and replace it with the ACTUAL once the real transaction posts.
 */
import type { EnrichedTxn } from '@/app/lib/analytics'

export type Cadence = 'monthly' | 'quarterly' | 'annual' | 'periodic'
export type AmountMode = 'seasonal' | 'average' | 'last' | 'fixed'

/**
 * Financial/transfer-like categories that are never "projected bills": card
 * payments, investing, cash, fees, transfers. Excluded from auto-suggestions so
 * the list stays bills the owner actually can't control.
 */
const EXCLUDED_CATEGORIES = ['CC Payment', 'Investment', 'Cash', 'Bank Fees', 'Transfer']

/** A confirmed projection rule (the lib's view of a `projection_rules` row). */
export type ProjectionRule = {
  merchantId: number
  merchantName: string
  label: string
  cadence: Cadence
  amountMode: AmountMode
  fixedAmount: number | null
}

export type UnavoidableLine = {
  merchantId: number | null
  label: string
  amount: number
  kind: 'fixed' | 'projected' | 'subscription'
  /** true when the figure is the month's real posted spend, not a projection. */
  actual: boolean
}

export type Unavoidable = { total: number; lines: UnavoidableLine[] }

/** Generic two-line burn-down series consumed by <BurndownTrajectory>. */
export type BurndownData = {
  /** Axis labels — day numbers ("1".."30") or month labels for multi-month. */
  labels: string[]
  granularity: 'day' | 'month'
  /** Discretionary money available for the window. */
  budget: number
  /** Straight goal line: budget → 0 across the window. */
  pace: (number | null)[]
  /** budget − cumulative discretionary spend, through `asOfIndex` then null. */
  remaining: (number | null)[]
  asOfIndex: number
  spentToDate: number
  /** remaining ≥ pace at the as-of point (spending slower than the burn). */
  onPace: boolean
}

/** great = comfortable cushion, close = ahead but near the line, below = behind. */
export type PaceLevel = 'great' | 'close' | 'below'
export type PaceStatus = { pct: number; level: PaceLevel }

/** Cushion below this share of budget (but still positive) counts as "close". */
const CLOSE_THRESHOLD = 5

/**
 * Headroom vs the even-pace line at the as-of point, as a signed % of the
 * discretionary budget. Positive means money to spare (above the burn line),
 * negative means overspending. Shared by the trajectory widget and the push
 * digest so both report the same number and color.
 */
export function pacePercent(data: BurndownData): PaceStatus {
  const remainingNow = data.remaining[data.asOfIndex] ?? data.budget
  const paceNow = data.pace[data.asOfIndex] ?? 0
  const pct = data.budget > 0 ? Math.round(((remainingNow - paceNow) / data.budget) * 100) : 0
  const level: PaceLevel = pct < 0 ? 'below' : pct < CLOSE_THRESHOLD ? 'close' : 'great'
  return { pct, level }
}

// --- tiny month/day helpers (duplicated to stay db-free, as budget.ts does) ---
function monthKey(d: string): string {
  return d.slice(0, 7)
}
function monthNum(ym: string): number {
  return Number(ym.slice(5, 7))
}
function dayOf(d: string): number {
  return Number(d.slice(8, 10))
}
export function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}`
}
function monthDiff(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number)
  const [yb, mb] = b.split('-').map(Number)
  return yb * 12 + mb - (ya * 12 + ma)
}
export function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m, 0).getDate()
}
function mean(ns: number[]): number {
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Positive expense spend per month for one merchant: Map<YYYY-MM, amount>. */
function merchantMonthlyTotals(all: EnrichedTxn[], merchantId: number): Map<string, number> {
  const out = new Map<string, number>()
  for (const t of all) {
    if (t.flow !== 'expense' || t.amount <= 0 || t.merchantId !== merchantId) continue
    const ym = monthKey(t.txnDate)
    out.set(ym, (out.get(ym) ?? 0) + t.amount)
  }
  return out
}

/** Median gap (in months) between consecutive occurrence months. */
export function inferGap(occ: string[]): number {
  if (occ.length < 2) return 12
  const diffs: number[] = []
  for (let i = 1; i < occ.length; i++) diffs.push(monthDiff(occ[i - 1], occ[i]))
  diffs.sort((a, b) => a - b)
  return Math.max(1, diffs[Math.floor(diffs.length / 2)])
}

function gapForCadence(cadence: Cadence, occ: string[]): number {
  if (cadence === 'monthly') return 1
  if (cadence === 'quarterly') return 3
  if (cadence === 'annual') return 12
  return inferGap(occ)
}

/**
 * The amount to project for `ym` when the real bill hasn't posted yet (per the
 * rule's amount mode). Falls back to the overall mean when a mode has no signal.
 */
function projectedAmount(rule: ProjectionRule, totals: Map<string, number>, ym: string): number {
  const occ = [...totals.entries()].filter(([, v]) => v > 0)
  if (rule.amountMode === 'fixed') return rule.fixedAmount ?? 0
  if (occ.length === 0) return rule.fixedAmount ?? 0
  if (rule.amountMode === 'last') {
    const lastKey = occ.map(([k]) => k).sort().pop()!
    return totals.get(lastKey) ?? 0
  }
  if (rule.amountMode === 'seasonal') {
    const mn = monthNum(ym)
    const sameMonth = occ.filter(([k]) => monthNum(k) === mn).map(([, v]) => v)
    return mean(sameMonth.length ? sameMonth : occ.map(([, v]) => v))
  }
  // average: mean of up to the 6 most recent occurrences
  const recent = occ
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, 6)
    .map(([, v]) => v)
  return mean(recent)
}

/**
 * Projected (or actual) amount for one rule in `ym`:
 *  1. real spend present → use it (actual replaces projection);
 *  2. else, if due this month per cadence → project the amount;
 *  3. else → 0.
 */
export function projectedAmountForMonth(
  rule: ProjectionRule,
  all: EnrichedTxn[],
  ym: string
): { amount: number; actual: boolean } {
  const totals = merchantMonthlyTotals(all, rule.merchantId)
  const real = totals.get(ym)
  if (real !== undefined && real > 0) return { amount: round2(real), actual: true }

  const occ = [...totals.keys()].filter((k) => (totals.get(k) ?? 0) > 0).sort()
  let due: boolean
  if (rule.cadence === 'monthly' || occ.length === 0) {
    due = rule.cadence === 'monthly'
  } else {
    const last = occ[occ.length - 1]
    const diff = monthDiff(last, ym)
    const gap = gapForCadence(rule.cadence, occ)
    due = diff > 0 && diff % gap === 0
  }
  if (!due) return { amount: 0, actual: false }
  return { amount: round2(projectedAmount(rule, totals, ym)), actual: false }
}

// ---------- unavoidable membership (shared by both builders) ----------

/** Merchant ids whose spend is unavoidable (so it's excluded from discretionary). */
export function unavoidableMerchantIds(
  all: EnrichedTxn[],
  rules: ProjectionRule[],
  fixedCats: string[]
): { merchantIds: Set<number>; fixedCats: Set<string> } {
  const merchantIds = new Set<number>()
  const fixedSet = new Set(fixedCats)
  for (const t of all) {
    if (t.flow === 'expense' && fixedSet.has(t.categoryName)) merchantIds.add(t.merchantId)
  }
  for (const r of rules) merchantIds.add(r.merchantId)
  return { merchantIds, fixedCats: fixedSet }
}

/** Sum (actual-or-average) for a fixed category in `ym`. */
function categoryAmountForMonth(all: EnrichedTxn[], cat: string, ym: string): { amount: number; actual: boolean } {
  const byMonth = new Map<string, number>()
  for (const t of all) {
    if (t.flow !== 'expense' || t.amount <= 0 || t.categoryName !== cat) continue
    byMonth.set(monthKey(t.txnDate), (byMonth.get(monthKey(t.txnDate)) ?? 0) + t.amount)
  }
  const real = byMonth.get(ym)
  if (real !== undefined && real > 0) return { amount: round2(real), actual: true }
  const others = [...byMonth.entries()].filter(([k]) => k !== ym).map(([, v]) => v)
  return { amount: round2(mean(others)), actual: false }
}

/**
 * The month's unavoidable spend: fixed categories + confirmed projected bills
 * (subscriptions are added as rules on Settings, not auto-included). Returns the
 * per-line breakdown. `kind: 'subscription'` is reserved for a rule the owner
 * labels as such but is treated identically to 'projected'.
 */
export function monthlyUnavoidable(
  all: EnrichedTxn[],
  rules: ProjectionRule[],
  ym: string,
  fixedCats: string[]
): Unavoidable {
  const lines: UnavoidableLine[] = []

  // 1. Fixed categories (Mortgage, Property Tax).
  for (const cat of fixedCats) {
    const { amount, actual } = categoryAmountForMonth(all, cat, ym)
    if (amount > 0) lines.push({ merchantId: null, label: cat, amount, kind: 'fixed', actual })
  }

  // 2. Confirmed projected bills.
  for (const r of rules) {
    const { amount, actual } = projectedAmountForMonth(r, all, ym)
    if (amount > 0) lines.push({ merchantId: r.merchantId, label: r.label, amount, kind: 'projected', actual })
  }

  lines.sort((a, b) => b.amount - a.amount)
  return { total: round2(lines.reduce((s, l) => s + l.amount, 0)), lines }
}

// ---------- burn-down builders ----------

/** Cumulative discretionary spend, bucketed by `keyFn`, over an ordered keyset. */
function cumulativeSpend(
  all: EnrichedTxn[],
  unavoidable: Set<number>,
  fixedCats: Set<string>,
  inWindow: (t: EnrichedTxn) => boolean,
  keyFn: (t: EnrichedTxn) => string,
  orderedKeys: string[]
): { cumulative: number[]; lastKeyWithData: string | null } {
  const perKey = new Map<string, number>()
  let lastKeyWithData: string | null = null
  for (const t of all) {
    if (t.flow !== 'expense' || t.amount <= 0 || !inWindow(t)) continue
    if (unavoidable.has(t.merchantId) || fixedCats.has(t.categoryName)) continue
    const k = keyFn(t)
    perKey.set(k, (perKey.get(k) ?? 0) + t.amount)
    if (lastKeyWithData === null || k > lastKeyWithData) lastKeyWithData = k
  }
  let running = 0
  const cumulative = orderedKeys.map((k) => {
    running += perKey.get(k) ?? 0
    return round2(running)
  })
  return { cumulative, lastKeyWithData }
}

/** Day-by-day burn-down for a single month against `monthBudget` discretionary. */
export function computeMonthBurndown(
  all: EnrichedTxn[],
  rules: ProjectionRule[],
  ym: string,
  monthBudget: number,
  fixedCats: string[]
): BurndownData {
  const { merchantIds, fixedCats: fixedSet } = unavoidableMerchantIds(all, rules, fixedCats)
  const days = daysInMonth(ym)
  const labels = Array.from({ length: days }, (_, i) => String(i + 1))

  // Bucket discretionary spend by day index.
  const perDay = new Array(days).fill(0)
  let lastDay = 0
  for (const t of all) {
    if (t.flow !== 'expense' || t.amount <= 0 || monthKey(t.txnDate) !== ym) continue
    if (merchantIds.has(t.merchantId) || fixedSet.has(t.categoryName)) continue
    const d = dayOf(t.txnDate)
    perDay[d - 1] += t.amount
    if (d > lastDay) lastDay = d
  }
  let running = 0
  const cumulative = perDay.map((v) => {
    running += v
    return round2(running)
  })

  // If the month is fully in the past (its last calendar day has data context),
  // plot the whole month; otherwise stop at the latest day with data.
  const asOfDay = lastDay > 0 ? lastDay : 1
  const asOfIndex = asOfDay - 1

  const pace = labels.map((_, i) => round2((monthBudget * (days - (i + 1))) / Math.max(1, days - 1)))
  const remaining = cumulative.map((c, i) => (i <= asOfIndex ? round2(monthBudget - c) : null))
  const spentToDate = cumulative[asOfIndex] ?? 0
  const onPace = (remaining[asOfIndex] ?? monthBudget) >= (pace[asOfIndex] ?? 0)

  return { labels, granularity: 'day', budget: round2(monthBudget), pace, remaining, asOfIndex, spentToDate, onPace }
}

/** Month-by-month burn-down across a multi-month window (3M/6M/12M fallback). */
export function computePeriodBurndown(
  all: EnrichedTxn[],
  rules: ProjectionRule[],
  startYm: string,
  endYm: string,
  monthBudget: number,
  fixedCats: string[]
): BurndownData {
  const { merchantIds, fixedCats: fixedSet } = unavoidableMerchantIds(all, rules, fixedCats)
  const labels: string[] = []
  for (let ym = startYm; ym <= endYm; ym = addMonths(ym, 1)) labels.push(ym)
  const n = labels.length
  const budget = round2(monthBudget * n)

  const { cumulative, lastKeyWithData } = cumulativeSpend(
    all,
    merchantIds,
    fixedSet,
    (t) => monthKey(t.txnDate) >= startYm && monthKey(t.txnDate) <= endYm,
    (t) => monthKey(t.txnDate),
    labels
  )
  const asOfIndex = lastKeyWithData ? Math.max(0, labels.indexOf(lastKeyWithData)) : n - 1
  const pace = labels.map((_, i) => round2((budget * (n - 1 - i)) / Math.max(1, n - 1)))
  const remaining = cumulative.map((c, i) => (i <= asOfIndex ? round2(budget - c) : null))
  const spentToDate = cumulative[asOfIndex] ?? 0
  const onPace = (remaining[asOfIndex] ?? budget) >= (pace[asOfIndex] ?? 0)

  return { labels, granularity: 'month', budget, pace, remaining, asOfIndex, spentToDate, onPace }
}

// ---------- auto-detect suggestions ----------

export type SuggestedRule = {
  merchantId: number
  merchantName: string
  label: string
  cadence: Cadence
  amountMode: AmountMode
  estimatedAmount: number
  occurrences: number
  category: string
}

/**
 * Scan history for uncontrolled recurring bills to suggest on Settings.
 * Heuristic: a *bill* posts ~once per active month (≤1.5 txns/active month — this
 * excludes supermarkets/restaurants which fire many times), recurs across ≥2
 * months, and isn't already a fixed category / ruled / dismissed.
 */
export function suggestProjectionRules(
  all: EnrichedTxn[],
  existingMerchantIds: Set<number>,
  dismissedIds: Set<number>,
  fixedCats: string[]
): SuggestedRule[] {
  const skipCats = new Set([...fixedCats, ...EXCLUDED_CATEGORIES])
  type Agg = { name: string; category: string; recurring: boolean; count: number; months: Map<string, number> }
  const byMerchant = new Map<number, Agg>()
  for (const t of all) {
    if (t.flow !== 'expense' || t.amount <= 0) continue
    if (skipCats.has(t.categoryName)) continue
    let a = byMerchant.get(t.merchantId)
    if (!a) {
      a = { name: t.merchantName, category: t.categoryName, recurring: t.isRecurring, count: 0, months: new Map() }
      byMerchant.set(t.merchantId, a)
    }
    a.count++
    a.recurring = a.recurring || t.isRecurring
    const ym = monthKey(t.txnDate)
    a.months.set(ym, (a.months.get(ym) ?? 0) + t.amount)
  }

  const out: SuggestedRule[] = []
  for (const [merchantId, a] of byMerchant) {
    if (existingMerchantIds.has(merchantId) || dismissedIds.has(merchantId)) continue
    const occ = [...a.months.keys()].sort()
    if (occ.length < 2) continue
    const txnsPerActiveMonth = a.count / occ.length
    // Recurring-flagged merchants pass even if slightly chatty; others must look bill-like.
    if (!a.recurring && txnsPerActiveMonth > 1.5) continue

    const gap = inferGap(occ)
    const cadence: Cadence = gap === 1 ? 'monthly' : gap === 3 ? 'quarterly' : gap >= 11 ? 'annual' : 'periodic'

    const vals = [...a.months.values()]
    const m = mean(vals)
    const variance = mean(vals.map((v) => (v - m) ** 2))
    const cv = m > 0 ? Math.sqrt(variance) / m : 0
    // Monthly bills with big month-to-month swings (Hydro) → seasonal.
    const amountMode: AmountMode = cadence === 'monthly' && cv > 0.25 ? 'seasonal' : 'average'

    const rule: ProjectionRule = { merchantId, merchantName: a.name, label: a.name, cadence, amountMode, fixedAmount: null }
    const next = addMonths(occ[occ.length - 1], gap)
    out.push({
      merchantId,
      merchantName: a.name,
      label: a.name,
      cadence,
      amountMode,
      estimatedAmount: round2(projectedAmount(rule, a.months, next)),
      occurrences: occ.length,
      category: a.category,
    })
  }
  return out.sort((a, b) => b.estimatedAmount - a.estimatedAmount)
}
