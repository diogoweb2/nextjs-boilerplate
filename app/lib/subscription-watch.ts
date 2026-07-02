/**
 * Subscription & bill price-creep watchdog (CONSULTANT_REPORT A4). Pure &
 * db-free like projection.ts — operates on rows from `loadAllFlows` so it can
 * be shared by the dashboard insight, the daily digest and /reports/subscriptions.
 *
 * Alert rule (deterministic, BUSINESS_RULES §18):
 *  - a subscription is any merchant with recurring-flagged expense charges;
 *  - its charge history is the per-month positive expense total (one occurrence
 *    per posting month, cents-exact);
 *  - the price is "stable" when the occurrences immediately before the latest
 *    one all posted the SAME amount — 3 in a row for monthly/quarterly/periodic
 *    cadences, 2 (or all history if only 1 prior charge exists) for annual;
 *  - an alert fires only when a stable price CHANGES on the latest charge.
 *    Variable-priced subscriptions never build a stable streak, so they never
 *    alert. The alert clears on its own once the next charge confirms the new
 *    price (the streak restarts at the new amount).
 */
import type { EnrichedTxn } from '@/app/lib/analytics'

export type SubCadence = 'monthly' | 'quarterly' | 'annual' | 'periodic'

export type PricePoint = { ym: string; amount: number }

export type PriceAlert = {
  merchantId: number
  name: string
  cadence: SubCadence
  /** The stable price before the change. */
  previous: number
  /** The latest charged amount. */
  current: number
  delta: number
  pctDelta: number
  /** delta × charges/year — the number that makes people act. */
  annualizedDelta: number
  /** Month (YYYY-MM) the new price first posted. */
  sinceYm: string
}

export type SubscriptionRow = {
  merchantId: number
  name: string
  category: string
  color: string
  cadence: SubCadence
  /** Inferred months between charges (1, 3, 12, or the median gap). */
  gapMonths: number
  /** Latest charged amount. */
  current: number
  monthlyEquivalent: number
  annualCost: number
  history: PricePoint[]
  firstSeen: string
  lastSeen: string
  occurrences: number
  /** Seen within one cadence gap of the newest data month. */
  active: boolean
  /** Consecutive identical charges before the latest one. */
  stableStreak: number
  /** No stable baseline exists (price moves charge-to-charge, e.g. FX-priced). */
  variable: boolean
  alert: PriceAlert | null
}

export type SubscriptionWatch = {
  hasData: boolean
  anchor: string | null
  /** Active first, then by monthly-equivalent cost, descending. */
  rows: SubscriptionRow[]
  /** Alerts on active subscriptions only, biggest annualized delta first. */
  alerts: PriceAlert[]
  /** Σ monthly-equivalent of active subscriptions. */
  monthlyLoad: number
  annualLoad: number
  activeCount: number
  inactiveCount: number
  /** Actual recurring-merchant spend per month, oldest→newest (last 12 months). */
  monthlyTotals: PricePoint[]
  /** Price changes (up or down) whose new price first posted in the last 12 months. */
  changes12mo: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function monthKey(d: string): string {
  return d.slice(0, 7)
}

function monthDiff(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number)
  const [yb, mb] = b.split('-').map(Number)
  return yb * 12 + mb - (ya * 12 + ma)
}

function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

/** Median gap (in months) between consecutive occurrence months. */
function inferGap(occ: string[]): number {
  if (occ.length < 2) return 1
  const diffs: number[] = []
  for (let i = 1; i < occ.length; i++) diffs.push(monthDiff(occ[i - 1], occ[i]))
  diffs.sort((a, b) => a - b)
  return Math.max(1, diffs[Math.floor(diffs.length / 2)])
}

function cadenceForGap(gap: number): SubCadence {
  if (gap === 1) return 'monthly'
  if (gap === 3) return 'quarterly'
  if (gap >= 11) return 'annual'
  return 'periodic'
}

/**
 * Consecutive identical amounts immediately before the latest charge. E.g.
 * [16.99, 16.99, 16.99, 20.99] → streak 3 at 16.99; [12, 15, 15, 20] → streak 2.
 */
function stableStreakBefore(history: PricePoint[]): { streak: number; baseline: number | null } {
  if (history.length < 2) return { streak: 0, baseline: null }
  const prior = history[history.length - 2].amount
  let streak = 0
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].amount === prior) streak++
    else break
  }
  return { streak, baseline: prior }
}

/** Charges the price change confirms as stable-then-changed (see file header). */
function requiredStreak(cadence: SubCadence, priorOccurrences: number): number {
  if (cadence === 'annual') return Math.min(2, priorOccurrences)
  return 3
}

export function buildSubscriptionWatch(all: EnrichedTxn[]): SubscriptionWatch {
  // Candidate set: merchants "marked as subscription" — any recurring-flagged
  // expense charge (per-txn override or the merchant's default flag).
  type Agg = {
    name: string
    category: string
    color: string
    /** Owner declared "bills once a year" — overrides the inferred cadence. */
    annual: boolean
    months: Map<string, number>
  }
  const byMerchant = new Map<number, Agg>()
  const recurringIds = new Set(
    all.filter((t) => t.flow === 'expense' && t.isRecurring).map((t) => t.merchantId)
  )
  let anchor: string | null = null
  for (const t of all) {
    if (t.flow !== 'expense' || t.amount <= 0) continue
    const ym = monthKey(t.txnDate)
    if (anchor === null || ym > anchor) anchor = ym
    if (!recurringIds.has(t.merchantId)) continue
    let a = byMerchant.get(t.merchantId)
    if (!a) {
      a = { name: t.merchantName, category: t.categoryName, color: t.categoryColor, annual: false, months: new Map() }
      byMerchant.set(t.merchantId, a)
    }
    a.annual = a.annual || t.recurringAnnual
    a.months.set(ym, (a.months.get(ym) ?? 0) + t.amount)
  }

  if (!anchor || byMerchant.size === 0) {
    return {
      hasData: false,
      anchor,
      rows: [],
      alerts: [],
      monthlyLoad: 0,
      annualLoad: 0,
      activeCount: 0,
      inactiveCount: 0,
      monthlyTotals: [],
      changes12mo: 0,
    }
  }

  const rows: SubscriptionRow[] = []
  let changes12mo = 0
  for (const [merchantId, a] of byMerchant) {
    const history: PricePoint[] = [...a.months.entries()]
      .map(([ym, amount]) => ({ ym, amount: round2(amount) }))
      .sort((x, y) => (x.ym < y.ym ? -1 : 1))
    const occ = history.map((p) => p.ym)
    // Owner-declared yearly billing beats inference: with a single charge (or a
    // couple of same-month renewals a year apart) the inferred gap is wrong and
    // the sub would look lapsed after a month.
    const gap = a.annual ? 12 : inferGap(occ)
    const cadence = a.annual ? 'annual' : cadenceForGap(gap)
    const latest = history[history.length - 1]
    const { streak, baseline } = stableStreakBefore(history)
    const priorCount = history.length - 1

    const required = requiredStreak(cadence, priorCount)
    const changed =
      baseline !== null && priorCount >= 1 && streak >= required && latest.amount !== baseline
    // Count price changes even on now-inactive subs for the 12-month stat.
    if (changed && monthDiff(latest.ym, anchor) < 12) changes12mo++

    const active = monthDiff(latest.ym, anchor) <= gap
    const alert: PriceAlert | null =
      changed && active
        ? {
            merchantId,
            name: a.name,
            cadence,
            previous: baseline!,
            current: latest.amount,
            delta: round2(latest.amount - baseline!),
            pctDelta: Math.round(((latest.amount - baseline!) / baseline!) * 100),
            annualizedDelta: round2((latest.amount - baseline!) * (12 / gap)),
            sinceYm: latest.ym,
          }
        : null

    rows.push({
      merchantId,
      name: a.name,
      category: a.category,
      color: a.color,
      cadence,
      gapMonths: gap,
      current: latest.amount,
      monthlyEquivalent: round2(latest.amount / gap),
      annualCost: round2(latest.amount * (12 / gap)),
      history,
      firstSeen: occ[0],
      lastSeen: latest.ym,
      occurrences: history.length,
      active,
      stableStreak: streak,
      variable: priorCount >= 2 && streak < 2,
      alert,
    })
  }

  rows.sort((x, y) =>
    x.active !== y.active ? (x.active ? -1 : 1) : y.monthlyEquivalent - x.monthlyEquivalent
  )
  const activeRows = rows.filter((r) => r.active)
  const alerts = activeRows
    .map((r) => r.alert)
    .filter((al): al is PriceAlert => al !== null)
    .sort((x, y) => Math.abs(y.annualizedDelta) - Math.abs(x.annualizedDelta))

  // Trailing 12 months of actual subscription spend (all recurring merchants).
  const monthlyTotals: PricePoint[] = []
  for (let i = 11; i >= 0; i--) {
    const ym = addMonths(anchor, -i)
    let amount = 0
    for (const a of byMerchant.values()) amount += a.months.get(ym) ?? 0
    monthlyTotals.push({ ym, amount: round2(amount) })
  }

  return {
    hasData: true,
    anchor,
    rows,
    alerts,
    monthlyLoad: round2(activeRows.reduce((s, r) => s + r.monthlyEquivalent, 0)),
    annualLoad: round2(activeRows.reduce((s, r) => s + r.annualCost, 0)),
    activeCount: activeRows.length,
    inactiveCount: rows.length - activeRows.length,
    monthlyTotals,
    changes12mo,
  }
}
