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
 * The only always-fixed categories. Everything else "unavoidable" (Hydro, Water,
 * Belair, Scholars, subscriptions) is a per-merchant projected bill — see
 * app/lib/projection.ts and the Settings page.
 */
export const FIXED_CATEGORIES = ['Mortgage', 'Property Tax']
/** Categories whose suggested goal defaults to ~$0 (an explicit lever to pull). */
const ZERO_DEFAULT_CATEGORIES = ['Travel', 'Investment']

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
 * The AI suggestion: fixed categories at their average; Travel/Investment at 0;
 * remaining discretionary categories at their average, proportionally haircut so
 * the discretionary total never exceeds what the monthly cap `B` allows after
 * the fixed lines. Pure so the client can re-run it on "Reset to suggested".
 */
export function suggestGoals(
  cats: { name: string; fixed: boolean; avg: number }[],
  B: number
): Map<string, number> {
  const out = new Map<string, number>()
  const fixedTotal = sum(cats.filter((c) => c.fixed).map((c) => c.avg))
  const discretionary = cats.filter((c) => !c.fixed && !ZERO_DEFAULT_CATEGORIES.includes(c.name))
  const discAvgTotal = sum(discretionary.map((c) => c.avg))
  const poolCap = B - fixedTotal // Travel/Investment default to 0, so they don't consume the pool.
  const factor = discAvgTotal > 0 ? Math.min(1, Math.max(0, poolCap / discAvgTotal)) : 0

  for (const c of cats) {
    if (c.fixed) out.set(c.name, round2(c.avg))
    else if (ZERO_DEFAULT_CATEGORIES.includes(c.name)) out.set(c.name, 0)
    else out.set(c.name, round2(c.avg * factor))
  }
  return out
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function computeBudget(
  all: EnrichedTxn[],
  categoriesMeta: CategoryMeta[],
  opts: { targetNet: number; periodMode: PeriodMode; savedGoals: Map<number, number>; rules?: ProjectionRule[] }
): BudgetData {
  const { targetNet, periodMode, rules = [] } = opts
  const anchor = anchorMonth(all)
  if (!anchor) {
    return {
      hasData: false, anchor: null, year: '', monthsRemaining: 0, periodMode, targetNet,
      income: 0, completedBaseline: 0, ytdNet: 0, categories: [],
      monthly: { labels: [], realSpend: [], cumulativeNet: [] }, currentMonthIndex: 0,
      monthlyCap: 0, unavoidable: { total: 0, lines: [] },
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
  const expenseCats = categoriesMeta.filter((c) => c.kind === 'expense')
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
  }
}
