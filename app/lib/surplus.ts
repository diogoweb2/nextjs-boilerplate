import { netOverRange, type EnrichedTxn } from '@/app/lib/analytics'

/**
 * Pure helpers for the monthly surplus-allocation prompt (the dashboard
 * "give every dollar a job" box). See BUSINESS_RULES.md §10b.
 *
 * The owner splits a completed net-positive month's surplus across savings
 * goals by percentage. Net-Zero is never an explicit share — it's the implicit
 * remainder (whatever isn't carved out keeps reducing the year's deficit via
 * cumulative net). So everything here works in terms of the SAVINGS-goal
 * percentages only; `percents` maps goalId → pct.
 */

const EPS = 0.005

/**
 * The feature starts with June 2026 — the first month whose surplus is allocated
 * (when July's data lands). Anything before this is ignored entirely: no prompt,
 * no auto-file. Bump this only if the owner wants an even later start.
 */
export const SURPLUS_START_MONTH = '2026-06'

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export type SurplusMonth = { ym: string; net: number }

/**
 * Completed months (≥ `minMonth`, strictly before the in-progress `anchor`)
 * whose net (income − spend) is positive. Newest first. These are the
 * candidates that may need a surplus-allocation decision.
 */
export function completedNetPositiveMonths(
  flows: EnrichedTxn[],
  anchor: string | null,
  minMonth: string = SURPLUS_START_MONTH,
): SurplusMonth[] {
  if (!anchor) return []
  const months = new Set<string>()
  for (const t of flows) {
    const ym = t.txnDate.slice(0, 7)
    if (ym >= minMonth && ym < anchor) months.add(ym)
  }
  return Array.from(months)
    .map((ym) => ({ ym, net: netOverRange(flows, ym, ym) }))
    .filter((m) => m.net > EPS)
    .sort((a, b) => (a.ym < b.ym ? 1 : -1))
}

/**
 * Preselected savings-goal percentages for a new prompt:
 *  - the previous allocated month's split, if any (filtered to goals that still
 *    exist), else
 *  - {} (→ 100% Net-Zero) when a Net-Zero goal exists, else
 *  - an equal split across the eligible goals summing to 100 (every dollar a job).
 */
export function defaultPercents(
  eligibleGoalIds: number[],
  prevPercents: Record<string, number> | null,
  hasNetZero: boolean,
): Record<string, number> {
  if (prevPercents) {
    const kept: Record<string, number> = {}
    for (const id of eligibleGoalIds) {
      const p = prevPercents[String(id)]
      if (p && p > 0) kept[String(id)] = p
    }
    if (Object.keys(kept).length > 0) return kept
  }
  if (hasNetZero || eligibleGoalIds.length === 0) return {}
  // Equal split that still sums to exactly 100 (remainder on the first goal).
  const n = eligibleGoalIds.length
  const base = Math.floor(100 / n)
  const out: Record<string, number> = {}
  eligibleGoalIds.forEach((id, i) => {
    out[String(id)] = base + (i === 0 ? 100 - base * n : 0)
  })
  return out
}

/** Convert savings-goal percentages into dollar amounts for a month's net. */
export function allocationAmounts(
  net: number,
  percents: Record<string, number>,
): { goalId: number; amount: number }[] {
  const out: { goalId: number; amount: number }[] = []
  for (const [idStr, pct] of Object.entries(percents)) {
    const goalId = Number(idStr)
    if (!Number.isInteger(goalId) || !(pct > 0)) continue
    const amount = round2((net * pct) / 100)
    if (amount > 0) out.push({ goalId, amount })
  }
  return out
}

/** Sum of a percents map (savings-goal shares only; Net-Zero = 100 − this). */
export function totalPercent(percents: Record<string, number>): number {
  return Object.values(percents).reduce((s, p) => s + (p > 0 ? p : 0), 0)
}
