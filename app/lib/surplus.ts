import { netOverRange, type EnrichedTxn } from '@/app/lib/analytics'
import { paydayContext } from '@/app/lib/income'

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

export type EligibleGoal = { id: number; autoContribute: number | null }

/**
 * Preselected savings-goal percentages for the monthly prompt, honoring per-goal
 * auto-contribute rules. Auto goals (in the given priority order, = goal sortOrder)
 * are pre-filled their fixed dollar amount first, each capped at the surplus left;
 * then any leftover is split across the NON-auto goals using last month's
 * percentages, scaled down proportionally to fit. Returns FRACTIONAL percents of
 * `net` ({ "<goalId>": pct }) so the dollar slider UI round-trips exactly. Net-Zero
 * stays the implicit remainder (100 − Σ). See BUSINESS_RULES §10b.
 */
export function autoContributePreselect(
  net: number,
  goalsInPriority: EligibleGoal[],
  prevPercents: Record<string, number> | null,
): Record<string, number> {
  if (!(net > 0) || goalsInPriority.length === 0) return {}
  const dollars: Record<string, number> = {}
  let remaining = net

  // 1) Auto rules first, in priority order, each capped at what's left.
  const autoIds = new Set<number>()
  for (const g of goalsInPriority) {
    const amt = g.autoContribute ?? 0
    if (!(amt > 0)) continue
    autoIds.add(g.id)
    const give = Math.min(round2(amt), remaining)
    if (give > 0) {
      dollars[String(g.id)] = round2(give)
      remaining = round2(remaining - give)
    }
  }

  // 2) Split the leftover across non-auto goals by last month's percentages.
  if (remaining > 0 && prevPercents) {
    const desired = goalsInPriority
      .filter((g) => !autoIds.has(g.id))
      .map((g) => ({ id: g.id, want: round2((net * (prevPercents[String(g.id)] ?? 0)) / 100) }))
      .filter((d) => d.want > 0)
    const totalWant = desired.reduce((s, d) => s + d.want, 0)
    const scale = totalWant > remaining ? remaining / totalWant : 1
    for (const d of desired) {
      const give = round2(d.want * scale)
      if (give > 0) dollars[String(d.id)] = round2((dollars[String(d.id)] ?? 0) + give)
    }
  }

  // Convert dollars → fractional percents of net.
  const out: Record<string, number> = {}
  for (const [id, amt] of Object.entries(dollars)) {
    if (amt > 0) out[id] = (amt / net) * 100
  }
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

/**
 * The in-progress month's surplus — money that isn't allocated yet and that the
 * surplus prompt will offer to give a job the moment the month closes.
 *
 * The dashboard's Net-trajectory (Year) chart answers "how far off the Dec 31
 * target are we?"; this answers "and what have we got in hand to close it?".
 * Nothing here is committed: the owner may send it to Net-Zero (shrinking the
 * year's gap) or to any savings goal (leaving the gap where it is).
 */
export type PendingSurplus = {
  /** The in-progress month, YYYY-MM. */
  month: string
  /** Income − spend so far this month. Negative = no surplus to give away yet. */
  net: number
  /** Days until the month closes and the prompt fires (0 = closes tonight). */
  daysToClose: number
  /** Still needed to reach the Dec 31 target (0 once the target is met). */
  gapToTarget: number
  /** What the gap becomes if the whole surplus goes to Net-Zero. */
  gapIfAllocated: number
  /**
   * The slice this month must leave for Net-Zero to stay on the required-path
   * slope (`-completedBaseline / monthsRemaining`), matching the dashed line on
   * the trajectory chart. Null when the year is already in the black.
   */
  minForTarget: number | null
  /** Value of this month's extra paycheque (0 in a normal 2-cheque month). */
  extraCheque: number
  /**
   * Net excluding the extra cheque entirely — what an actual **2-paycheque**
   * month looks like. Deliberately NOT the Income page's levelled figure, which
   * credits every month 26/12 = 2.179 cheques so months compare fairly. Here the
   * question is "how much can I give away and still cover a lean month?", so the
   * conservative whole-cheque figure is the right one. The two differ by ~0.18 of
   * a cheque; see BUSINESS_RULES §10b.
   */
  typicalNet: number | null
}

export function computePendingSurplus(
  flows: EnrichedTxn[],
  anchor: string | null,
  opts: {
    /** YYYY-MM-DD today — dates the countdown. */
    todayIso: string
    /** Year-to-date net (the trajectory chart's "current net"). */
    ytdNet: number
    targetNet: number
    /** Net over the year's *completed* months, and months left including this one. */
    completedBaseline: number
    monthsRemaining: number
  },
): PendingSurplus | null {
  if (!anchor) return null
  const net = netOverRange(flows, anchor, anchor)

  const [y, m] = anchor.split('-').map(Number)
  const lastDay = new Date(y, m, 0).getDate()
  const today = opts.todayIso.slice(0, 7) === anchor ? Number(opts.todayIso.slice(8, 10)) : lastDay
  const daysToClose = Math.max(0, lastDay - today)

  const gapToTarget = Math.max(0, round2(opts.targetNet - opts.ytdNet))
  const gapIfAllocated = Math.max(0, round2(gapToTarget - Math.max(0, net)))

  let minForTarget: number | null = null
  if (opts.monthsRemaining > 0 && opts.completedBaseline < 0) {
    minForTarget = round2(-opts.completedBaseline / opts.monthsRemaining)
  }

  // A 3-cheque month's surplus isn't repeatable capacity — it's what funds the
  // 2-cheque months around it. Say so rather than levelling the headline, which
  // would leave the extra cheque with no prompt and no job.
  const pay = paydayContext(flows, anchor)
  const extraCheque = pay && pay.paydays > pay.typicalPaydays ? pay.extraCheque : 0
  const typicalNet = extraCheque > 0 ? round2(net - extraCheque) : null

  return {
    month: anchor,
    net,
    daysToClose,
    gapToTarget,
    gapIfAllocated,
    minForTarget,
    extraCheque: round2(extraCheque),
    typicalNet,
  }
}
