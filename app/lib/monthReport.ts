/**
 * Monthly recap builder — the data behind the standalone 80s-themed `/report`
 * page and the month-settled push notification. It's a *progress* report: it grades the
 * month on effort vs. the month before, then surfaces a handful of glanceable
 * headlines. Fully deterministic (no AI — see BUSINESS_RULES.md §Monthly report)
 * and reuses the same analytics the dashboard/budget render, so every number ties
 * out with the rest of the app.
 *
 * Loads from the db (flows + goal contributions), so it's a server module like
 * app/lib/digest.ts — not the pure, db-free app/lib/budget.ts.
 */
import { inArray } from 'drizzle-orm'
import { db } from '@/db'
import { goals, goalEntries } from '@/db/schema'
import {
  loadAllFlows,
  anchorMonth,
  availableMonths,
  addMonths,
  monthKey,
  netOverRange,
  buildOverview,
  categoryCredits,
  type EnrichedTxn,
} from '@/app/lib/analytics'
import { projectNetZeroDate, FIXED_CATEGORIES } from '@/app/lib/budget'
import { formatCurrency, formatMonth, formatPercentDelta } from '@/app/lib/format'
import { quoteForMonth, type Quote } from '@/app/lib/reportQuotes'
import { isDemoSession } from '@/app/lib/demo'
import { loadNetWorth } from '@/app/actions/networth'

/**
 * Categories kept OUT of the best/worst-category comparison and the discretionary
 * spend signal: fixed bills (Home/mortgage), transfer-like financial lines, and
 * Investment (those are savings transfers, not a budget overrun) — so "best/worst"
 * reflects genuine discretionary effort.
 */
const DISCRETIONARY_EXCLUDE = new Set([
  ...FIXED_CATEGORIES,
  'CC Payment',
  'Cash',
  'Bank Fees',
  'Investment',
  'Transfer',
  'Uncategorized',
])

export type CategoryDelta = {
  name: string
  color: string
  amount: number
  prevAmount: number
  deltaDollars: number
  deltaPct: number
  /** No spend in the prior month → a brand-new line (pct is not meaningful). */
  isNew: boolean
}

export type Grade = {
  letter: string
  /** 0–100 composite. */
  score: number
  /** Per-signal 0–1 sub-scores, for transparency / tuning. */
  breakdown: { net: number; trajectory: number; goals: number; discretionary: number; black: number }
}

export type MonthReport = {
  month: string // YYYY-MM
  monthLabel: string
  prevMonth: string
  prevMonthLabel: string
  grade: Grade
  quote: Quote

  /** Month net (income − spend, mortgage included) + change vs last month. */
  net: number
  prevNet: number
  netDeltaDollars: number
  netDeltaPct: { text: string; direction: 'up' | 'down' | 'flat' } | null

  /** Year-to-date cumulative net (the "net 0 for the year" lens). */
  yearNet: number
  yearNetPositive: boolean

  /** Savings-goal contributions this month vs last. */
  movedToGoals: number
  movedToGoalsPrev: number

  /** Discretionary best (biggest drop = win) and worst (biggest rise) vs last month. */
  bestCategory: CategoryDelta | null
  worstCategory: CategoryDelta | null

  /** Projected net-$0 crossing vs last month. +days = earlier (good), −days = later. */
  netZeroReached: boolean
  netZeroDate: string | null
  netZeroLabel: string
  netZeroShiftDays: number | null

  /** Net worth = chequing + investments − mortgage at month-end. */
  netWorth: number
  prevNetWorth: number
  netWorthDeltaPct: { text: string; direction: 'up' | 'down' | 'flat' } | null
  netWorthBreakdown: { chequing: number; investments: number; mortgage: number } | null

  // --- lighter "fun" extras ---
  noSpendDays: number
  topMerchant: { name: string; amount: number } | null
  netPositiveStreak: number
  shareLine: string
}

export type ReportResult = {
  report: MonthReport | null
  /** All months available for the picker (most recent first). */
  months: string[]
  /** The month actually rendered (resolved default when none/invalid requested). */
  month: string | null
}

const DAYS_PER_MONTH = 30.4375

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

// --- grade tuning knobs (retune after a few real months) ---
const NET_SWING_SCALE = 1500 // $ MoM net improvement that earns a full mark
const ZERO_SHIFT_SCALE = 30 // days the net-$0 date must move earlier for a full mark
const NET_LEVEL_SCALE = 2000 // how deep in the red zeroes out the "in the black" bonus
const WEIGHTS = { net: 30, trajectory: 25, goals: 20, discretionary: 15, black: 10 }

/** Composite 0–100 → letter. Each threshold is a named edge for easy retuning. */
function letterFor(score: number): string {
  if (score >= 95) return 'A+'
  if (score >= 88) return 'A'
  if (score >= 82) return 'A-'
  if (score >= 76) return 'B+'
  if (score >= 70) return 'B'
  if (score >= 64) return 'B-'
  if (score >= 58) return 'C+'
  if (score >= 52) return 'C'
  if (score >= 46) return 'C-'
  if (score >= 38) return 'D'
  return 'F'
}

/** Savings-goal contributions (positive contributions only) per YYYY-MM. */
async function movedToGoalsByMonth(months: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(months.map((m) => [m, 0]))
  // Demo sessions must never touch the real goals/goal_entries tables (would leak
  // real contribution amounts into the synthetic showcase) — report $0 moved.
  if (await isDemoSession()) return out
  const goalRows = await db.select({ id: goals.id, kind: goals.kind }).from(goals)
  // Include both savings and mortgage goals — matches how loadGoalsData counts monthStats.
  const savingsIds = goalRows.filter((g) => g.kind === 'savings' || g.kind === 'mortgage').map((g) => g.id)
  if (savingsIds.length === 0) return out
  const entries = await db.select().from(goalEntries).where(inArray(goalEntries.goalId, savingsIds))
  for (const e of entries) {
    if (e.kind !== 'contribution') continue
    const amt = Number(e.amount)
    if (amt <= 0) continue
    const ym = e.occurredAt.slice(0, 7)
    if (out.has(ym)) out.set(ym, round2((out.get(ym) ?? 0) + amt))
  }
  return out
}

function discretionaryTotal(byCategory: { name: string; amount: number }[]): number {
  return round2(
    byCategory.filter((c) => !DISCRETIONARY_EXCLUDE.has(c.name)).reduce((s, c) => s + c.amount, 0)
  )
}

/** Best (biggest drop) and worst (biggest rise) discretionary category vs last month. */
function categoryDeltas(
  cur: { name: string; color: string; amount: number }[],
  prev: { name: string; color: string; amount: number }[]
): { best: CategoryDelta | null; worst: CategoryDelta | null } {
  const curMap = new Map(cur.map((c) => [c.name, c]))
  const prevMap = new Map(prev.map((c) => [c.name, c]))
  const names = new Set([...curMap.keys(), ...prevMap.keys()])
  const deltas: CategoryDelta[] = []
  for (const name of names) {
    if (DISCRETIONARY_EXCLUDE.has(name)) continue
    const amount = curMap.get(name)?.amount ?? 0
    const prevAmount = prevMap.get(name)?.amount ?? 0
    if (amount <= 0 && prevAmount <= 0) continue
    const deltaDollars = round2(amount - prevAmount)
    if (Math.abs(deltaDollars) < 0.005) continue
    deltas.push({
      name,
      color: curMap.get(name)?.color ?? prevMap.get(name)?.color ?? '#94a3b8',
      amount: round2(amount),
      prevAmount: round2(prevAmount),
      deltaDollars,
      deltaPct: prevAmount > 0 ? round2(((amount - prevAmount) / prevAmount) * 100) : 100,
      isNew: prevAmount <= 0,
    })
  }
  const drops = deltas.filter((d) => d.deltaDollars < 0).sort((a, b) => a.deltaDollars - b.deltaDollars)
  const rises = deltas.filter((d) => d.deltaDollars > 0).sort((a, b) => b.deltaDollars - a.deltaDollars)
  return { best: drops[0] ?? null, worst: rises[0] ?? null }
}

function netPositiveStreak(flows: EnrichedTxn[], endYm: string): number {
  const earliest = flows.reduce<string | null>((min, t) => {
    const ym = monthKey(t.txnDate)
    return min === null || ym < min ? ym : min
  }, null)
  if (!earliest) return 0
  let streak = 0
  let ym = endYm
  while (ym >= earliest) {
    if (netOverRange(flows, ym, ym) < -0.005) break
    streak++
    ym = addMonths(ym, -1)
  }
  return streak
}

function gradeMonth(args: {
  net: number
  prevNet: number
  netZeroReached: boolean
  netZeroShiftDays: number | null
  netZeroReachable: boolean
  netZeroReachablePrev: boolean
  movedToGoals: number
  movedToGoalsPrev: number
  curDisc: number
  prevDisc: number
}): Grade {
  const improvement = args.net - args.prevNet
  const sNet = clamp01(0.5 + improvement / (2 * NET_SWING_SCALE))

  let sTraj: number
  if (args.netZeroReached) sTraj = 1
  else if (args.netZeroShiftDays !== null)
    sTraj = clamp01(0.5 + args.netZeroShiftDays / (2 * ZERO_SHIFT_SCALE))
  else if (args.netZeroReachable && !args.netZeroReachablePrev) sTraj = 0.75 // back on a path
  else if (!args.netZeroReachable && args.netZeroReachablePrev) sTraj = 0.25 // path stalled
  else sTraj = 0.5

  let sGoals = 0.2
  if (args.movedToGoals > 0) sGoals = 0.7
  if (args.movedToGoals > 0 && args.movedToGoals >= args.movedToGoalsPrev) sGoals = 0.9
  if (args.movedToGoals > args.movedToGoalsPrev) sGoals = 1

  const sDisc =
    args.prevDisc > 0 ? clamp01(0.5 + (args.prevDisc - args.curDisc) / args.prevDisc) : 0.5

  const sBlack = args.net >= 0 ? 1 : clamp01(0.5 + args.net / (2 * NET_LEVEL_SCALE))

  const score =
    WEIGHTS.net * sNet +
    WEIGHTS.trajectory * sTraj +
    WEIGHTS.goals * sGoals +
    WEIGHTS.discretionary * sDisc +
    WEIGHTS.black * sBlack

  const rounded = Math.round(score)
  return {
    letter: letterFor(rounded),
    score: rounded,
    breakdown: { net: sNet, trajectory: sTraj, goals: sGoals, discretionary: sDisc, black: sBlack },
  }
}

function noSpendDays(flows: EnrichedTxn[], ym: string, isCurrentMonth: boolean): number {
  const [y, m] = ym.split('-').map(Number)
  const monthDays = new Date(y, m, 0).getDate()
  const daysWith = new Set<string>()
  let maxDay = 0
  for (const t of flows) {
    if (t.flow !== 'expense' || t.amount <= 0 || monthKey(t.txnDate) !== ym) continue
    daysWith.add(t.txnDate)
    maxDay = Math.max(maxDay, Number(t.txnDate.slice(8, 10)))
  }
  const elapsed = isCurrentMonth ? maxDay : monthDays
  return Math.max(0, elapsed - daysWith.size)
}

/**
 * Build the recap for `targetYm`. When `targetYm` is null/invalid it defaults to
 * the previous completed month (the month before the in-progress anchor). Returns
 * the report plus the picker's month list, loading the dataset once.
 */
export async function buildMonthReport(targetYm?: string | null): Promise<ReportResult> {
  const flows = await loadAllFlows()
  const months = availableMonths(flows)
  if (months.length === 0) return { report: null, months, month: null }

  const anchor = anchorMonth(flows.filter((t) => t.flow === 'expense')) ?? months[0]
  const valid = (m: string | null | undefined): m is string => !!m && months.includes(m)
  // Default: previous completed month if we have it, else the most recent month.
  const fallback = months.includes(addMonths(anchor, -1)) ? addMonths(anchor, -1) : months[0]
  const month = valid(targetYm) ? targetYm : fallback
  const prevMonth = addMonths(month, -1)
  const year = month.slice(0, 4)

  const net = netOverRange(flows, month, month)
  const prevNet = netOverRange(flows, prevMonth, prevMonth)
  const yearNet = netOverRange(flows, `${year}-01`, month)

  const [goalMap, nwData] = await Promise.all([
    movedToGoalsByMonth([month, prevMonth]),
    loadNetWorth([prevMonth, month]),
  ])
  const nwCurrent = nwData.series.find((s) => s.ym === month)
  const nwPrev = nwData.series.find((s) => s.ym === prevMonth)
  const netWorth = nwCurrent?.value ?? 0
  const prevNetWorth = nwPrev?.value ?? 0
  const movedToGoals = goalMap.get(month) ?? 0
  const movedToGoalsPrev = goalMap.get(prevMonth) ?? 0

  const credits = categoryCredits(flows)
  const curOv = buildOverview(flows, 1, false, month, credits)
  const prevOv = buildOverview(flows, 1, false, prevMonth, credits)
  const { best, worst } = categoryDeltas(curOv.byCategory, prevOv.byCategory)
  const curDisc = discretionaryTotal(curOv.byCategory)
  const prevDisc = discretionaryTotal(prevOv.byCategory)

  // Net-$0 trajectory: project the crossing as of this month and last month, diff.
  const proj = projectNetZeroDate(flows, month)
  const projPrev = projectNetZeroDate(flows, prevMonth)
  const reachable = proj.crossingIndexFloat !== null
  const reachablePrev = projPrev.crossingIndexFloat !== null
  let netZeroShiftDays: number | null = null
  if (!proj.reached && reachable && reachablePrev && !projPrev.reached) {
    const monthsDiff = (projPrev.crossingIndexFloat as number) - (proj.crossingIndexFloat as number)
    netZeroShiftDays = Math.round(monthsDiff * DAYS_PER_MONTH)
  }
  const netZeroLabel = proj.reached
    ? 'In the black — net $0 cleared 🎉'
    : proj.crossingDate
      ? `On pace for net $0 by ${formatMonth(proj.crossingDate.slice(0, 7))}`
      : 'No pace to net $0 yet — a positive month starts the climb'

  const grade = gradeMonth({
    net,
    prevNet,
    netZeroReached: proj.reached,
    netZeroShiftDays,
    netZeroReachable: reachable,
    netZeroReachablePrev: reachablePrev,
    movedToGoals,
    movedToGoalsPrev,
    curDisc,
    prevDisc,
  })

  const topMerchant = curOv.topMerchants[0]
    ? { name: curOv.topMerchants[0].name, amount: round2(curOv.topMerchants[0].amount) }
    : null

  const netDeltaPct = formatPercentDelta(net, prevNet)
  const monthLabel = formatMonth(month)
  const prevMonthLabel = formatMonth(prevMonth)
  const shareLine =
    `${monthLabel}: graded ${grade.letter}. Net ${formatCurrency(net)}` +
    `${netDeltaPct ? ` (${netDeltaPct.text} vs ${prevMonthLabel})` : ''}` +
    `${movedToGoals > 0 ? `, ${formatCurrency(movedToGoals)} to goals` : ''}.`

  const report: MonthReport = {
    month,
    monthLabel,
    prevMonth,
    prevMonthLabel,
    grade,
    quote: quoteForMonth(month),
    net,
    prevNet,
    netDeltaDollars: round2(net - prevNet),
    netDeltaPct,
    yearNet,
    yearNetPositive: yearNet >= -0.005,
    movedToGoals,
    movedToGoalsPrev,
    bestCategory: best,
    worstCategory: worst,
    netZeroReached: proj.reached,
    netZeroDate: proj.crossingDate,
    netZeroLabel,
    netZeroShiftDays,
    netWorth,
    prevNetWorth,
    netWorthDeltaPct: formatPercentDelta(netWorth, prevNetWorth),
    netWorthBreakdown: nwCurrent
      ? { chequing: nwCurrent.chequing, investments: nwCurrent.investments, mortgage: nwCurrent.mortgage }
      : null,
    noSpendDays: noSpendDays(flows, month, month === anchor),
    topMerchant,
    netPositiveStreak: netPositiveStreak(flows, month),
    shareLine,
  }
  return { report, months, month }
}

const GRADE_EMOJI: Record<string, string> = {
  'A+': '🏆',
  A: '🌟',
  'A-': '🌟',
  'B+': '🕺',
  B: '🕺',
  'B-': '🪩',
  'C+': '🪩',
  C: '🎧',
  'C-': '🎧',
  D: '📼',
  F: '💾',
}

/** Fun, motivational push payload for the month-settled recap notification. */
export function buildReportNotification(report: MonthReport): { title: string; body: string; url: string } {
  const emoji = GRADE_EMOJI[report.grade.letter] ?? '🪩'
  const bits: string[] = []
  if (report.net >= 0) bits.push(`banked ${formatCurrency(report.net)}`)
  if (report.movedToGoals > 0) bits.push(`${formatCurrency(report.movedToGoals)} to goals`)
  const lead = bits.length ? `You ${bits.join(' + ')}. ` : ''
  return {
    title: `${emoji} ${report.grade.letter} for ${report.monthLabel}!`,
    body: `${lead}Tap for your synthwave money recap ▶`,
    url: `/report?month=${report.month}`,
  }
}
