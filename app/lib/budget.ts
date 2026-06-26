/**
 * Budget analytics for the /budget page. Pure & db-free (operates on the rows
 * from `loadAllFlows`) so it can be unit-tested and its types/helpers imported
 * by the client planner. See BUSINESS_RULES.md §Budget.
 *
 * Goal of the page: tell the user how much they can spend this month — excluding
 * unavoidable bills — to finish the calendar year at a chosen net (default 0).
 *
 * Headline figures, all derived here:
 *  - I  = expected monthly income (avg of last 3 complete months excl. Insurance,
 *         plus the trailing-12-month average of Insurance, which is lumpy).
 *  - completedBaseline = net (income − spend) over the year's completed months.
 *  - B  = I + (completedBaseline − targetNet) / monthsRemaining  → monthly cap.
 *  - F  = Σ averages of the fixed/required categories.
 *  - X  = B − F  → the "ideal discretionary spend this month" headline.
 */
import type { EnrichedTxn } from '@/app/lib/analytics'
import { monthlyUnavoidable, type ProjectionRule, type Unavoidable } from '@/app/lib/projection'

export type PeriodMode = 'year' | '12mo'

/**
 * The only always-fixed category. "Home" consolidates the unavoidable house
 * costs (Mortgage, Property Tax, Toronto Hydro, Toronto Water), so it is treated
 * as fully fixed. Everything else "unavoidable" (Belair, Scholars, Koodo,
 * subscriptions) is a per-merchant projected bill — see app/lib/projection.ts
 * and the Settings page. Hydro/Water have NO projection rule (they would
 * double-count against the fixed Home total).
 */
export const FIXED_CATEGORIES = ['Home']
/** Categories whose suggested goal defaults to ~$0 (an explicit lever to pull). */
const ZERO_DEFAULT_CATEGORIES = ['Travel', 'Investment']
/**
 * Financial / transfer-like categories that are NOT discretionary budget lines:
 * untracked credit-card payments, ABM cash, bank fees. They still count toward
 * net/spend (via the un-categorized `spendOver` totals), but budgeting a goal —
 * let alone a *seasonal* one — for "paying your credit card" is meaningless and
 * pollutes the category list, so they're excluded from the goals & proposal.
 * (Transfer is `kind: 'neutral'`, already excluded by the expense-kind filter.)
 */
const NON_BUDGET_CATEGORIES = ['CC Payment', 'Cash', 'Bank Fees']

// Month helpers duplicated from analytics.ts so this file stays db-free (the
// same pattern custom-reports.ts uses).
function monthKey(d: string): string {
  return d.slice(0, 7)
}
function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}`
}
function anchorMonth(txns: EnrichedTxn[]): string | null {
  if (txns.length === 0) return null
  return txns.reduce((max, t) => (t.txnDate > max ? t.txnDate : max), txns[0].txnDate).slice(0, 7)
}
function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0)
}

export type CategoryMeta = { id: number; name: string; color: string; kind: string }

export type SeasonalProposalLine = {
  categoryId: number
  name: string
  /** Seasonally-adjusted proposed goal fitted to the monthly cap. */
  proposed: number
  /** Regular (non-seasonal) suggested goal for comparison. */
  regular: number
  /** Human-readable reason for the seasonal adjustment (empty if no adjustment). */
  reason: string
}

export type SeasonalProposal = {
  month: string // YYYY-MM
  lines: SeasonalProposalLine[]
  /** Key bullet points to surface in the UI reasoning box. */
  summaryPoints: string[]
}

export type BudgetCategory = {
  categoryId: number
  name: string
  color: string
  fixed: boolean
  /** Mean monthly spend over completed months — calendar-year and trailing-12. */
  avgYear: number
  avg12: number
  /** AI-suggested goal for the current settings (avg-based, fitted to the cap). */
  suggestedGoal: number
  /** Saved override if present, else the suggestion. The editable value. */
  goal: number
  /** This (anchor) month's spend so far in the category. */
  currentMonthActual: number
}

export type BudgetData = {
  hasData: boolean
  anchor: string | null
  year: string
  /** Whole months from the anchor through December inclusive. */
  monthsRemaining: number
  periodMode: PeriodMode
  targetNet: number
  /** Expected monthly income. */
  income: number
  /** Net over completed months of the year (locked baseline). */
  completedBaseline: number
  /** Full year-to-date net incl. the partial anchor month (familiar headline). */
  ytdNet: number
  categories: BudgetCategory[]
  /** Budget-vs-real chart data over the calendar year (Jan..Dec). */
  monthly: { labels: string[]; realSpend: number[]; cumulativeNet: (number | null)[] }
  /** 0-based index of the anchor month within the year (Jun = 5). */
  currentMonthIndex: number
  /** Monthly all-in cap B (income + (completedBaseline − target)/monthsRemaining). */
  monthlyCap: number
  /** This-month unavoidable spend (fixed cats + projected bills + subscriptions). */
  unavoidable: Unavoidable
  /** Seasonally-aware budget proposal for the current month with reasoning. */
  seasonalProposal: SeasonalProposal
  /** Anchor month the budget was last auto-proposed for (null = never). Drives
   *  the "new month → auto-adopt the proposal" behaviour on the client. */
  budgetedMonth: string | null
}

/** Sum income (stored negative) for a flow=income predicate over given months. */
function incomeOver(all: EnrichedTxn[], months: Set<string>, pred: (t: EnrichedTxn) => boolean): number {
  return -sum(all.filter((t) => t.flow === 'income' && pred(t) && months.has(monthKey(t.txnDate))).map((t) => t.amount))
}
/** Sum positive expense spend over given months for an optional category. */
function spendOver(all: EnrichedTxn[], months: Set<string>, catName?: string): number {
  return sum(
    all
      .filter(
        (t) =>
          t.flow === 'expense' &&
          t.amount > 0 &&
          months.has(monthKey(t.txnDate)) &&
          (catName === undefined || t.categoryName === catName)
      )
      .map((t) => t.amount)
  )
}

/**
 * The AI suggestion: fixed categories at their average; zero-default categories
 * (Travel/Investment by default) at 0; remaining discretionary categories at
 * their average, proportionally haircut so the discretionary total never exceeds
 * what the monthly cap `B` allows after the fixed lines. Pure so the client can
 * re-run it on "Reset to suggested".
 *
 * `zeroCats` overrides which names are forced to 0 — the seasonal proposal passes
 * an empty set so a category like Travel can be lifted by a seasonal signal
 * (summer camping) while still being fitted to the pool.
 */
export function suggestGoals(
  cats: { name: string; fixed: boolean; avg: number }[],
  B: number,
  zeroCats: Set<string> = new Set(ZERO_DEFAULT_CATEGORIES)
): Map<string, number> {
  const out = new Map<string, number>()
  const fixedTotal = sum(cats.filter((c) => c.fixed).map((c) => c.avg))
  const discretionary = cats.filter((c) => !c.fixed && !zeroCats.has(c.name))
  const discAvgTotal = sum(discretionary.map((c) => c.avg))
  const poolCap = B - fixedTotal // zero-default cats default to 0, so they don't consume the pool.
  const factor = discAvgTotal > 0 ? Math.min(1, Math.max(0, poolCap / discAvgTotal)) : 0

  for (const c of cats) {
    if (c.fixed) out.set(c.name, round2(c.avg))
    else if (zeroCats.has(c.name)) out.set(c.name, 0)
    else out.set(c.name, round2(c.avg * factor))
  }
  return out
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export type NetZeroProjection = {
  /** Cumulative net (income − spend) for the year through `asOfYm`. */
  currentNet: number
  /** Already at/above $0 for the year. */
  reached: boolean
  /**
   * Absolute month-index float (`year*12 + (month-1)`, fractional) where the
   * running net is projected to hit $0 at the latest month's pace; null when it's
   * unreachable (flat or worsening while still negative). Comparing this across
   * two as-of months yields "how many days earlier / later" the crossing moved.
   */
  crossingIndexFloat: number | null
  /** ISO date (YYYY-MM-DD) of the projected crossing, or null. */
  crossingDate: string | null
}

/**
 * Project when the year's cumulative net crosses $0, as of the end of `asOfYm`.
 * Mirrors the "At this pace → net $0 by …" math in NetBudgetTrajectory: pace is
 * the latest month's net (the last month-over-month step of the cumulative line).
 * Pure (db-free) so the monthly report can run it for two consecutive as-of
 * months and diff the result.
 */
export function projectNetZeroDate(all: EnrichedTxn[], asOfYm: string): NetZeroProjection {
  const year = asOfYm.slice(0, 4)
  const anchorMonthNum = Number(asOfYm.slice(5, 7))
  const asOfIndex = Number(year) * 12 + (anchorMonthNum - 1)

  let currentNet = 0
  for (let m = 1; m <= anchorMonthNum; m++) {
    const ym = `${year}-${String(m).padStart(2, '0')}`
    currentNet += incomeOver(all, new Set([ym]), () => true) - spendOver(all, new Set([ym]))
  }
  currentNet = round2(currentNet)
  // Pace = the last month's net (the final step of the cumulative line).
  const pace = round2(incomeOver(all, new Set([asOfYm]), () => true) - spendOver(all, new Set([asOfYm])))

  if (currentNet >= -0.005) {
    return { currentNet, reached: true, crossingIndexFloat: asOfIndex, crossingDate: isoFromMonthFloat(asOfIndex) }
  }
  if (pace > 0) {
    const monthsToZero = -currentNet / pace
    if (monthsToZero <= 600) {
      const idx = asOfIndex + monthsToZero
      return { currentNet, reached: false, crossingIndexFloat: idx, crossingDate: isoFromMonthFloat(idx) }
    }
  }
  return { currentNet, reached: false, crossingIndexFloat: null, crossingDate: null }
}

/** Absolute month-index float → an ISO date (the fractional part places the day). */
function isoFromMonthFloat(idx: number): string {
  const whole = Math.floor(idx)
  const frac = idx - whole
  const cy = Math.floor(whole / 12)
  const cm = (whole % 12) + 1 // 1-based
  const dim = new Date(cy, cm, 0).getDate()
  const day = Math.min(dim, Math.max(1, Math.round(frac * dim) || 1))
  return `${cy}-${String(cm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export type NetTrajectoryPoint = { date: string; net: number }

export type NetTrajectory = {
  hasData: boolean
  year: string
  targetNet: number
  /** Daily cumulative net (income − spend) for the calendar year, one point per
   *  day that has activity. The final point equals `ytdNet`. */
  points: NetTrajectoryPoint[]
  /** Jan 1 of the year and the latest transaction date — the plotted x-range. */
  startDate: string
  endDate: string
  /** Latest cumulative net (matches the YTD-net headline). */
  currentNet: number
  /** Highest and lowest the running net reached this year. */
  peak: number
  trough: number
  /** Per-month net (income − spend), best first — the months you saved most. */
  monthlyNet: { ym: string; net: number }[]
}

/**
 * Day-by-day cumulative net (income − spend) across the current calendar year,
 * for the Overview "Year-end net goal" progression chart. Uses the same income/
 * spend definition as `ytdNet` above, so the last point matches that headline.
 * No future projection — it only plots what's happened year-to-date.
 */
export function computeNetTrajectory(all: EnrichedTxn[], targetNet: number): NetTrajectory {
  const anchor = anchorMonth(all)
  const empty: NetTrajectory = {
    hasData: false, year: '', targetNet, points: [], startDate: '', endDate: '',
    currentNet: 0, peak: 0, trough: 0, monthlyNet: [],
  }
  if (!anchor) return empty
  const year = anchor.slice(0, 4)

  // Per-day net delta (income stored negative → −amount is the inflow; positive
  // expenses subtract). Mirrors incomeOver/spendOver so the total ties to ytdNet.
  const dayDelta = new Map<string, number>()
  for (const t of all) {
    if (t.txnDate.slice(0, 4) !== year) continue
    let delta = 0
    if (t.flow === 'income') delta = -t.amount
    else if (t.flow === 'expense' && t.amount > 0) delta = -t.amount
    else continue
    dayDelta.set(t.txnDate, (dayDelta.get(t.txnDate) ?? 0) + delta)
  }
  const dates = [...dayDelta.keys()].sort()
  if (dates.length === 0) return empty

  let running = 0
  let peak = 0
  let trough = 0
  const points = dates.map((date) => {
    running += dayDelta.get(date)!
    peak = Math.max(peak, running)
    trough = Math.min(trough, running)
    return { date, net: round2(running) }
  })

  // Per-month net (income − spend), most-saved first.
  const monthSums = new Map<string, number>()
  for (const [date, delta] of dayDelta) {
    const ym = date.slice(0, 7)
    monthSums.set(ym, (monthSums.get(ym) ?? 0) + delta)
  }
  const monthlyNet = [...monthSums.entries()]
    .map(([ym, net]) => ({ ym, net: round2(net) }))
    .sort((a, b) => b.net - a.net)

  return {
    hasData: true,
    year,
    targetNet,
    points,
    startDate: `${year}-01-01`,
    endDate: dates[dates.length - 1],
    currentNet: round2(running),
    peak: round2(peak),
    trough: round2(trough),
    monthlyNet,
  }
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A material seasonal swing needs BOTH a ≥10% and a ≥$25 deviation (avoids noise
 *  on tiny categories) — except a category that normally sits near $0 (e.g. Travel
 *  out of season) only needs the $25 absolute move so summer camping still shows. */
const SEASONAL_MIN_PCT = 0.1
const SEASONAL_MIN_ABS = 25

/**
 * Build a seasonally-adjusted budget proposal for `anchor`. Per category the
 * "seasonal average" is:
 *  - Groceries → 3-month rolling average (captures steadily rising prices);
 *  - everything else → the same-calendar-month average across prior years, when
 *    ≥2 prior years exist and the swing vs the category's own average is material.
 * Crucially, a normally-zeroed category (Travel) CAN be lifted by a strong
 * seasonal signal — that's the "summer camping / Kids summer camp / extra fuel"
 * case the owner described. Investment stays a deliberate $0 lever. Categories
 * with no signal fall back to exactly their regular suggestion, so the proposal
 * differs from "Reset to suggested" only where history justifies it.
 *
 * The chosen averages are fitted to the monthly cap B via `suggestGoals` (empty
 * zero-list, since zeroing is already baked into the chosen averages), so the
 * proposal as a whole still respects the year-end net goal.
 */
function proposeSeasonal(
  all: EnrichedTxn[],
  kept: Array<{ meta: CategoryMeta; avgYear: number; avg12: number; fixed: boolean }>,
  anchor: string,
  year: string,
  mn: number,
  B: number,
  periodMode: PeriodMode,
  regularSuggestions: Map<string, number>
): SeasonalProposal {
  const monthName = MONTH_NAMES[mn - 1]
  const catInputs: { name: string; fixed: boolean; avg: number; reason: string }[] = []

  for (const d of kept) {
    const name = d.meta.name
    const baseAvg = periodMode === 'year' ? d.avgYear : d.avg12
    // No-signal default mirrors the regular suggestion's pre-haircut input:
    // zero-default cats start at 0, everything else at its average.
    const isZeroDefault = ZERO_DEFAULT_CATEGORIES.includes(name)
    let avg = isZeroDefault ? 0 : baseAvg
    let reason = ''
    // Investment is a deliberate "pause investing" lever, never lifted by history.
    const canLift = !d.fixed && name !== 'Investment'

    if (canLift && name === 'Groceries') {
      const last3 = new Set([1, 2, 3].map((i) => addMonths(anchor, -i)))
      const last3Avg = spendOver(all, last3, name) / 3
      const pct = baseAvg > 0 ? (last3Avg - baseAvg) / baseAvg : 0
      if (last3Avg > 0 && Math.abs(last3Avg - baseAvg) > 15) {
        avg = round2(last3Avg)
        reason = `3-month rolling avg (${pct > 0 ? '+' : ''}${Math.round(pct * 100)}% vs yearly avg) — tracks rising grocery prices`
      }
    } else if (canLift) {
      // Same-calendar-month history from prior years (up to 5).
      const sameMonthSpends: number[] = []
      for (let y = 1; y <= 5; y++) {
        const s = spendOver(all, new Set([`${Number(year) - y}-${String(mn).padStart(2, '0')}`]), name)
        if (s > 0) sameMonthSpends.push(s)
      }
      if (sameMonthSpends.length >= 2) {
        const sameMonthMean = sum(sameMonthSpends) / sameMonthSpends.length
        const absDiff = Math.abs(sameMonthMean - baseAvg)
        const relDiff = baseAvg > 0 ? absDiff / baseAvg : Infinity
        if (sameMonthMean > 0 && absDiff > SEASONAL_MIN_ABS && relDiff > SEASONAL_MIN_PCT) {
          avg = round2(sameMonthMean)
          reason =
            baseAvg > 20
              ? `${monthName} historically runs ${sameMonthMean > baseAvg ? '+' : ''}${Math.round(
                  (sameMonthMean / baseAvg - 1) * 100
                )}% vs your average`
              : `${monthName} historically averages about $${Math.round(sameMonthMean)} (seasonal spike)`
        }
      }
    }

    catInputs.push({ name, fixed: d.fixed, avg, reason })
  }

  // Empty zero-list: the chosen averages already encode the zeroing, and Travel
  // may now carry a seasonal average we want to keep.
  const seasonalMap = suggestGoals(
    catInputs.map((c) => ({ name: c.name, fixed: c.fixed, avg: c.avg })),
    B,
    new Set()
  )

  const summaryPoints: string[] = []
  const lines: SeasonalProposalLine[] = kept.map((d, i) => {
    const regular = round2(regularSuggestions.get(d.meta.name) ?? 0)
    const proposed = round2(seasonalMap.get(d.meta.name) ?? 0)
    // Only surface a reason where the seasonal signal actually moved the goal.
    const material = !!catInputs[i].reason && Math.abs(proposed - regular) > 2
    if (material) summaryPoints.push(`${d.meta.name}: ${catInputs[i].reason}`)
    return {
      categoryId: d.meta.id,
      name: d.meta.name,
      proposed,
      regular,
      reason: material ? catInputs[i].reason : '',
    }
  })

  // If a seasonal lift forced the pool haircut to trim other flexible lines,
  // say so — otherwise the offsetting decreases look unexplained.
  const lifted = lines.some((l) => l.reason && l.proposed > l.regular)
  const trimmed = lines.some((l, i) => !kept[i].fixed && !l.reason && l.regular - l.proposed > 2)
  if (lifted && trimmed) {
    summaryPoints.push('Other flexible categories were trimmed slightly to keep the plan within your year-end net goal.')
  }

  return { month: anchor, lines, summaryPoints }
}

export function computeBudget(
  all: EnrichedTxn[],
  categoriesMeta: CategoryMeta[],
  opts: {
    targetNet: number
    periodMode: PeriodMode
    savedGoals: Map<number, number>
    rules?: ProjectionRule[]
    budgetedMonth?: string | null
  }
): BudgetData {
  const { targetNet, periodMode, rules = [], budgetedMonth = null } = opts
  const anchor = anchorMonth(all)
  if (!anchor) {
    return {
      hasData: false, anchor: null, year: '', monthsRemaining: 0, periodMode, targetNet,
      income: 0, completedBaseline: 0, ytdNet: 0, categories: [],
      monthly: { labels: [], realSpend: [], cumulativeNet: [] }, currentMonthIndex: 0,
      monthlyCap: 0, unavoidable: { total: 0, lines: [] },
      seasonalProposal: { month: '', lines: [], summaryPoints: [] }, budgetedMonth,
    }
  }
  const year = anchor.slice(0, 4)
  const anchorMonthNum = Number(anchor.slice(5, 7))
  const monthsRemaining = 12 - anchorMonthNum + 1 // anchor..Dec inclusive

  // --- Month windows (averages use COMPLETE months: exclude the partial anchor) ---
  const last3 = new Set([1, 2, 3].map((i) => addMonths(anchor, -i)))
  const last12 = new Set(Array.from({ length: 12 }, (_, i) => addMonths(anchor, -(i + 1))))
  const yearAll = new Set<string>() // year months present, incl. anchor (for ytdNet)
  const yearCompleted = new Set<string>() // year months strictly before anchor
  for (const t of all) {
    const ym = monthKey(t.txnDate)
    if (ym.slice(0, 4) !== year) continue
    yearAll.add(ym)
    if (ym < anchor) yearCompleted.add(ym)
  }
  const completedCount = Math.max(1, yearCompleted.size)

  // --- Expected monthly income I ---
  const inc3total = incomeOver(all, last3, () => true)
  const inc3insurance = incomeOver(all, last3, (t) => t.categoryName === 'Insurance')
  const insurance12 = incomeOver(all, last12, (t) => t.categoryName === 'Insurance')
  const income = round2((inc3total - inc3insurance) / 3 + insurance12 / 12)

  // --- Baselines ---
  const completedBaseline = round2(incomeOver(all, yearCompleted, () => true) - spendOver(all, yearCompleted))
  const ytdNet = round2(incomeOver(all, yearAll, () => true) - spendOver(all, yearAll))

  // --- Monthly cap B ---
  const B = income + (completedBaseline - targetNet) / monthsRemaining

  // --- Per-category figures (expense categories only) ---
  const anchorSet = new Set([anchor])
  const expenseCats = categoriesMeta.filter(
    (c) => c.kind === 'expense' && !NON_BUDGET_CATEGORIES.includes(c.name)
  )
  const draft = expenseCats.map((c) => {
    const avgYear = round2(spendOver(all, yearCompleted, c.name) / completedCount)
    const avg12 = round2(spendOver(all, last12, c.name) / 12)
    const currentMonthActual = round2(spendOver(all, anchorSet, c.name))
    const fixed = FIXED_CATEGORIES.includes(c.name)
    return { meta: c, avgYear, avg12, currentMonthActual, fixed }
  })
  // Keep categories that matter: any spend signal or a fixed/required line.
  const kept = draft.filter((d) => d.fixed || d.avgYear > 0 || d.avg12 > 0 || d.currentMonthActual > 0)

  const avgFor = (d: (typeof kept)[number]) => (periodMode === 'year' ? d.avgYear : d.avg12)
  const suggestions = suggestGoals(
    kept.map((d) => ({ name: d.meta.name, fixed: d.fixed, avg: avgFor(d) })),
    B
  )

  const categories: BudgetCategory[] = kept
    .map((d) => {
      const suggestedGoal = suggestions.get(d.meta.name) ?? 0
      const saved = opts.savedGoals.get(d.meta.id)
      return {
        categoryId: d.meta.id,
        name: d.meta.name,
        color: d.meta.color,
        fixed: d.fixed,
        avgYear: d.avgYear,
        avg12: d.avg12,
        suggestedGoal,
        goal: saved ?? suggestedGoal,
        currentMonthActual: d.currentMonthActual,
      }
    })
    // Fixed first, then by the active-period average descending.
    .sort((a, b) => {
      if (a.fixed !== b.fixed) return a.fixed ? -1 : 1
      const av = periodMode === 'year' ? a.avgYear : a.avg12
      const bv = periodMode === 'year' ? b.avgYear : b.avg12
      return bv - av
    })

  // --- Charts: calendar-year Jan..Dec real spend + cumulative net trajectory ---
  const labels = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
  const realSpend = labels.map((ym) => round2(spendOver(all, new Set([ym]))))
  let running = 0
  const cumulativeNet = labels.map((ym, i) => {
    if (i > anchorMonthNum - 1) return null // future months
    const net = incomeOver(all, new Set([ym]), () => true) - spendOver(all, new Set([ym]))
    running += net
    return round2(running)
  })

  // This-month unavoidable spend, projected from history (actual once posted).
  const unavoidable = monthlyUnavoidable(all, rules, anchor, FIXED_CATEGORIES)

  // Seasonally-aware budget proposal (compares same-month history to regular avg).
  const seasonalProposal = proposeSeasonal(all, kept, anchor, year, anchorMonthNum, B, periodMode, suggestions)

  return {
    hasData: true,
    anchor,
    year,
    monthsRemaining,
    periodMode,
    targetNet,
    income,
    completedBaseline,
    ytdNet,
    categories,
    monthly: { labels, realSpend, cumulativeNet },
    currentMonthIndex: anchorMonthNum - 1,
    monthlyCap: round2(B),
    unavoidable,
    seasonalProposal,
    budgetedMonth,
  }
}
