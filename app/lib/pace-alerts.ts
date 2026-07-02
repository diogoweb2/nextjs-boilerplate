/**
 * Mid-month category pace alerts (BUSINESS_RULES.md §B5-pace). Pure & db-free,
 * like projection.ts: operates on the already-computed BudgetData so the digest
 * and the dashboard modal report the exact same numbers.
 *
 * A category is "running hot" when its run-rate month-end projection overshoots
 * its goal by ≥ HOT_THRESHOLD % — a real blow-up, not a rounding wobble. Only
 * discretionary categories with a positive goal qualify; fixed categories
 * (Home) are bills, not behavior. The check is mid-month only: too early and
 * one grocery run dominates the run-rate, too late and it's not actionable.
 */
import type { BudgetData } from '@/app/lib/budget'

export type PaceAlert = {
  categoryId: number
  name: string
  color: string
  /** Monthly goal for the category. */
  goal: number
  /** Month-to-date net spend (out-of-pocket). */
  spent: number
  /** Run-rate month-end projection: spent / asOfDay × daysInMonth. */
  projected: number
  /** Projected overshoot as a % of the goal (≥ HOT_THRESHOLD when alerting). */
  overPct: number
  asOfDay: number
  daysInMonth: number
}

/** Projected month-end overshoot must reach this % of goal to count as hot. */
export const HOT_THRESHOLD = 20
/** Run-rate is meaningless in the first few days of the month. */
const MIN_DAY = 5
/** Past this day the month is nearly decided — the recap covers it better. */
const MAX_DAY = 27

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * All categories currently running hot for the anchor month, hottest first.
 * This is the *live* list (what the dashboard modal shows); the digest applies
 * the pace_alert_pushes hysteresis on top so the push doesn't nag daily.
 */
export function computePaceAlerts(budget: BudgetData): PaceAlert[] {
  if (!budget.hasData) return []
  const asOfDay = budget.anchorAsOfDay
  const days = budget.anchorDaysInMonth
  if (asOfDay < MIN_DAY || asOfDay > MAX_DAY || days <= 0) return []

  const out: PaceAlert[] = []
  for (const c of budget.categories) {
    if (c.fixed || c.goal <= 0 || c.currentMonthActual <= 0) continue
    const projected = round2((c.currentMonthActual / asOfDay) * days)
    const overPct = Math.round(((projected - c.goal) / c.goal) * 100)
    if (overPct < HOT_THRESHOLD) continue
    out.push({
      categoryId: c.categoryId,
      name: c.name,
      color: c.color,
      goal: c.goal,
      spent: round2(c.currentMonthActual),
      projected,
      overPct,
      asOfDay,
      daysInMonth: days,
    })
  }
  return out.sort((a, b) => b.overPct - a.overPct)
}
