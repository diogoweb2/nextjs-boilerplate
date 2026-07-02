/**
 * Goals — pure value/progress math over the goal_entries ledger. A savings goal's
 * current value is the running sum of its contribution + adjustment deltas; a
 * sparkline is that sum bucketed by month. Mortgage goals use app/lib/mortgage.ts
 * instead. See BUSINESS_RULES.md §10.
 */
import { addMonths, monthsBetween } from '@/app/lib/mortgage'

export type EntryLite = {
  kind: 'contribution' | 'adjustment' | 'balance' | 'transfer'
  amount: number
  occurredAt: string // YYYY-MM-DD
}

/** Kinds that move a savings goal's running value. */
function affectsValue(e: EntryLite): boolean {
  return e.kind === 'contribution' || e.kind === 'adjustment' || e.kind === 'transfer'
}

/**
 * Current value of a savings goal = Σ contributions + Σ adjustment deltas +
 * Σ transfer (rebalance) deltas. Transfers move value but aren't new savings.
 */
export function savingsValue(entries: EntryLite[]): number {
  return round2(entries.filter(affectsValue).reduce((s, e) => s + e.amount, 0))
}

/** Total money actually put in (positive contributions only). */
export function totalContributed(entries: EntryLite[]): number {
  return round2(
    entries.filter((e) => e.kind === 'contribution' && e.amount > 0).reduce((s, e) => s + e.amount, 0),
  )
}

/** 0–100 progress toward a target (clamped); null when there is no target. */
export function progressPct(value: number, target: number | null): number | null {
  if (!target || target <= 0) return null
  return Math.max(0, Math.min(100, (value / target) * 100))
}

/**
 * Running value bucketed by month, from the first entry's month through `asOfYm`,
 * for the sparkline. Each point is the cumulative value at that month's end.
 */
export function valueSeries(entries: EntryLite[], asOfYm: string): { ym: string; value: number }[] {
  const relevant = entries
    .filter(affectsValue)
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1))
  if (relevant.length === 0) return [{ ym: asOfYm, value: 0 }]

  const deltaByYm = new Map<string, number>()
  for (const e of relevant) {
    const ym = e.occurredAt.slice(0, 7)
    deltaByYm.set(ym, (deltaByYm.get(ym) ?? 0) + e.amount)
  }
  const startYm = relevant[0].occurredAt.slice(0, 7)
  const endYm = monthsBetween(startYm, asOfYm) >= 0 ? asOfYm : startYm

  const out: { ym: string; value: number }[] = []
  let running = 0
  for (let ym = startYm; monthsBetween(ym, endYm) >= 0; ym = addMonths(ym, 1)) {
    running += deltaByYm.get(ym) ?? 0
    out.push({ ym, value: round2(running) })
  }
  return out
}

/**
 * Monthly contribution pace = total contributions over the span of COMPLETED
 * months (first contribution month → the month before the in-progress anchor),
 * divided by the number of those months. Excluding the in-progress month stops
 * a partial month skewing it; dividing by the full span (zero months included)
 * stops a single seed deposit implying an unrealistically fast finish. We need
 * ≥2 completed months of history first — otherwise there's no real pattern to
 * project, so we return null. It sharpens each month as the pattern grows.
 */
export function contributionPace(entries: EntryLite[], asOfYm: string): number | null {
  const completed = entries.filter(
    (e) => e.kind === 'contribution' && e.amount > 0 && e.occurredAt.slice(0, 7) < asOfYm,
  )
  if (completed.length === 0) return null

  const firstYm = completed.reduce(
    (m, e) => (e.occurredAt.slice(0, 7) < m ? e.occurredAt.slice(0, 7) : m),
    completed[0].occurredAt.slice(0, 7),
  )
  // asOf is in progress, so months from firstYm up to it = the completed span.
  const monthsElapsed = monthsBetween(firstYm, asOfYm)
  if (monthsElapsed < 2) return null

  const pace = completed.reduce((s, e) => s + e.amount, 0) / monthsElapsed
  return pace > 0 ? pace : null
}

/** Estimated month the goal is reached, from your monthly contribution pace. */
export function projectedCompletionYm(
  entries: EntryLite[],
  target: number | null,
  asOfYm: string,
): string | null {
  if (!target || target <= 0) return null
  const value = savingsValue(entries)
  if (value >= target) return null

  const pace = contributionPace(entries, asOfYm)
  if (pace === null) return null
  const monthsLeft = Math.ceil((target - value) / pace)
  return addMonths(asOfYm, monthsLeft)
}

export type TargetPace = {
  /** Whole months from the anchor month to the target-date month (0 if past). */
  monthsLeft: number
  /** Contribution needed each remaining month to hit the target on time. */
  neededPerMonth: number
  /** Learned monthly pace (see contributionPace); null with <2 months history. */
  currentPace: number | null
  /** Pace ≥ needed? null when there's no pace to judge yet. */
  onTrack: boolean | null
}

/**
 * "Am I on pace, and what monthly contribution gets me there?" for a savings
 * goal with BOTH a target amount and a target date. Null when either is missing
 * or the goal is already reached. A target date in the past (or this month)
 * yields monthsLeft 0 and neededPerMonth = the full remaining gap.
 */
export function targetPace(
  entries: EntryLite[],
  target: number | null,
  targetDate: string | null,
  asOfYm: string,
): TargetPace | null {
  if (!target || target <= 0 || !targetDate) return null
  const value = savingsValue(entries)
  const remaining = round2(target - value)
  if (remaining <= 0) return null

  const monthsLeft = Math.max(0, monthsBetween(asOfYm, targetDate.slice(0, 7)))
  const neededPerMonth = round2(monthsLeft > 0 ? remaining / monthsLeft : remaining)
  const currentPace = contributionPace(entries, asOfYm)
  const onTrack =
    monthsLeft === 0 ? false : currentPace === null ? null : currentPace + 0.005 >= neededPerMonth
  return { monthsLeft, neededPerMonth, currentPace, onTrack }
}

/** A short, motivational line keyed to a progress percentage. */
export function milestoneMessage(pct: number | null): string {
  if (pct === null) return 'Every dollar counts — keep stacking. 💪'
  if (pct >= 100) return 'Goal smashed! Time to celebrate. 🎉'
  if (pct >= 75) return 'So close you can taste it — final push! 🔥'
  if (pct >= 50) return 'Over halfway there. Momentum is on your side. 🚀'
  if (pct >= 25) return "Quarter of the way — you're building real steam. 💫"
  if (pct > 0) return 'Off the starting line — every deposit adds up. 🌱'
  return 'Fresh start. The best time to begin was yesterday. 🌟'
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
