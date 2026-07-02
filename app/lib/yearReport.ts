/**
 * Year in Review builder — the data behind the `/report/year` page and the
 * year-settled push notification (§B1 of the consultant report). It's the annual
 * "special edition" of the monthly recap (app/lib/monthReport.ts): same 80s
 * chassis, same deterministic rules (no AI — see BUSINESS_RULES.md §Year in
 * Review), and the same analytics primitives, so every number ties out with the
 * dashboard, Budget and Goals pages.
 *
 * A year is *final* by the same argument as months (app/lib/reportSchedule.ts):
 * the moment a transaction dated in the new year lands, every prior-year charge
 * has necessarily posted. Server module (loads from the db) like monthReport.
 */
import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { goals, goalEntries, registeredAccounts, registeredContributions } from '@/db/schema'
import {
  loadAllFlows,
  anchorMonth,
  availableMonths,
  netOverRange,
  categoryCredits,
  isExcludedFromBiggest,
  type EnrichedTxn,
} from '@/app/lib/analytics'
import {
  DISCRETIONARY_EXCLUDE,
  letterFor,
  type CategoryDelta,
  type Grade,
} from '@/app/lib/monthReport'
import { formatCurrency, formatMonth } from '@/app/lib/format'
import { quoteForYear, type Quote } from '@/app/lib/reportQuotes'
import { isDemoSession } from '@/app/lib/demo'
import { loadNetWorth } from '@/app/actions/networth'

export type YearMonthNet = { ym: string; label: string; net: number }

export type MerchantTotal = { id: number; name: string; amount: number; count: number }

export type YearReport = {
  year: string // YYYY
  prevYear: string | null // previous year, when it has data (all YoY deltas need it)
  /** True when the year is the anchor year — numbers are year-to-date, not final. */
  inProgress: boolean
  /** Last month with data inside the year (caps the monthly strip & no-spend math). */
  lastDataMonth: string
  grade: YearGrade
  quote: Quote

  totalIncome: number
  totalSpend: number
  net: number
  prevNet: number | null
  prevIncome: number | null
  prevSpend: number | null

  /** Net per calendar month of the year (only months with data). */
  monthlyNets: YearMonthNet[]
  bestMonth: YearMonthNet | null
  worstMonth: YearMonthNet | null
  monthsInBlack: number

  /** Discretionary categories, biggest YoY improvements (drops) and slips (rises). */
  categoryWins: CategoryDelta[]
  categorySlips: CategoryDelta[]

  topMerchants: MerchantTotal[]
  biggestPurchase: { merchant: string; amount: number; date: string; category: string } | null
  subscriptionsTotal: number
  noSpendDays: number

  /** Savings + mortgage goal contributions in the year (and the YoY reference). */
  movedToGoals: number
  movedToGoalsPrev: number | null
  /** Mortgage-goal contributions only — "principal killed". */
  mortgagePrincipal: number
  tfsaContributed: number
  respContributed: number

  /** Net worth at year end vs. end of the previous year (null when unknown). */
  netWorthEnd: number | null
  netWorthStart: number | null

  shareLine: string
}

export type YearGrade = Omit<Grade, 'breakdown'> & {
  breakdown: { black: number; yoy: number; goals: number; discretionary: number; consistency: number }
}

export type YearReportResult = {
  report: YearReport | null
  /** All years with data, most recent first (for the picker). */
  years: string[]
  year: string | null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

// --- year-grade tuning knobs (annual scale of the monthReport knobs) ---
const YEAR_NET_SWING_SCALE = 12000 // $ YoY net improvement that earns a full mark
const YEAR_NET_LEVEL_SCALE = 15000 // how deep in the red zeroes the "in the black" score
export const YEAR_WEIGHTS = { black: 25, yoy: 25, goals: 20, discretionary: 15, consistency: 15 }

/** Gross purchases per category over `year`, net of goal-spend credits (matches buildOverview). */
function categoryTotals(
  flows: EnrichedTxn[],
  credits: EnrichedTxn[],
  year: string
): Map<string, { color: string; amount: number }> {
  const inYear = (t: EnrichedTxn) => t.txnDate.slice(0, 4) === year
  const out = new Map<string, { color: string; amount: number }>()
  for (const t of flows) {
    if (t.flow !== 'expense' || t.amount <= 0 || !inYear(t)) continue
    const e = out.get(t.categoryName) ?? { color: t.categoryColor, amount: 0 }
    e.amount += t.amount
    out.set(t.categoryName, e)
  }
  for (const t of credits) {
    if (!inYear(t)) continue
    const e = out.get(t.categoryName)
    if (e) e.amount = Math.max(0, e.amount - Math.abs(t.amount))
  }
  return out
}

/** All discretionary YoY deltas, wins (drops) and slips (rises) sorted biggest-first. */
function yearCategoryDeltas(
  cur: Map<string, { color: string; amount: number }>,
  prev: Map<string, { color: string; amount: number }>
): { wins: CategoryDelta[]; slips: CategoryDelta[] } {
  const names = new Set([...cur.keys(), ...prev.keys()])
  const deltas: CategoryDelta[] = []
  for (const name of names) {
    if (DISCRETIONARY_EXCLUDE.has(name)) continue
    const amount = cur.get(name)?.amount ?? 0
    const prevAmount = prev.get(name)?.amount ?? 0
    if (amount <= 0 && prevAmount <= 0) continue
    const deltaDollars = round2(amount - prevAmount)
    if (Math.abs(deltaDollars) < 0.005) continue
    deltas.push({
      name,
      color: cur.get(name)?.color ?? prev.get(name)?.color ?? '#94a3b8',
      amount: round2(amount),
      prevAmount: round2(prevAmount),
      deltaDollars,
      deltaPct: prevAmount > 0 ? round2(((amount - prevAmount) / prevAmount) * 100) : 100,
      isNew: prevAmount <= 0,
    })
  }
  const wins = deltas.filter((d) => d.deltaDollars < 0).sort((a, b) => a.deltaDollars - b.deltaDollars)
  const slips = deltas.filter((d) => d.deltaDollars > 0).sort((a, b) => b.deltaDollars - a.deltaDollars)
  return { wins: wins.slice(0, 3), slips: slips.slice(0, 3) }
}

function discretionaryTotal(totals: Map<string, { amount: number }>): number {
  let s = 0
  for (const [name, v] of totals) if (!DISCRETIONARY_EXCLUDE.has(name)) s += v.amount
  return round2(s)
}

/** Days in the year (through `lastDataMonth`'s last spend day) with zero expense charges. */
function yearNoSpendDays(flows: EnrichedTxn[], year: string): number {
  const daysWith = new Set<string>()
  let maxDate = ''
  for (const t of flows) {
    if (t.flow !== 'expense' || t.amount <= 0 || t.txnDate.slice(0, 4) !== year) continue
    daysWith.add(t.txnDate)
    if (t.txnDate > maxDate) maxDate = t.txnDate
  }
  if (!maxDate) return 0
  const start = new Date(`${year}-01-01T00:00:00`)
  const end = new Date(`${maxDate}T00:00:00`)
  const elapsed = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
  return Math.max(0, elapsed - daysWith.size)
}

/** Goal contributions in a year: total (savings+mortgage) and the mortgage-only slice. */
async function goalContributions(year: string): Promise<{ total: number; mortgage: number }> {
  // Demo sessions never touch real goal tables (see movedToGoalsByMonth).
  if (await isDemoSession()) return { total: 0, mortgage: 0 }
  const goalRows = await db.select({ id: goals.id, kind: goals.kind }).from(goals)
  const tracked = goalRows.filter((g) => g.kind === 'savings' || g.kind === 'mortgage')
  if (tracked.length === 0) return { total: 0, mortgage: 0 }
  const mortgageIds = new Set(tracked.filter((g) => g.kind === 'mortgage').map((g) => g.id))
  const entries = await db
    .select()
    .from(goalEntries)
    .where(inArray(goalEntries.goalId, tracked.map((g) => g.id)))
  let total = 0
  let mortgage = 0
  for (const e of entries) {
    const amt = Number(e.amount)
    if (e.kind !== 'contribution' || amt <= 0 || e.occurredAt.slice(0, 4) !== year) continue
    total += amt
    if (mortgageIds.has(e.goalId)) mortgage += amt
  }
  return { total: round2(total), mortgage: round2(mortgage) }
}

/** TFSA / RESP contributions (money in, not net of withdrawals) in a year. */
async function registeredByKind(year: string): Promise<{ tfsa: number; resp: number }> {
  if (await isDemoSession()) return { tfsa: 0, resp: 0 }
  const rows = await db
    .select({ kind: registeredAccounts.kind, amount: registeredContributions.amount, occurredAt: registeredContributions.occurredAt })
    .from(registeredContributions)
    .innerJoin(registeredAccounts, eq(registeredContributions.accountId, registeredAccounts.id))
    .where(eq(registeredContributions.kind, 'contribution'))
  let tfsa = 0
  let resp = 0
  for (const r of rows) {
    if (r.occurredAt.slice(0, 4) !== year) continue
    if (r.kind === 'tfsa') tfsa += Number(r.amount)
    else if (r.kind === 'resp') resp += Number(r.amount)
  }
  return { tfsa: round2(tfsa), resp: round2(resp) }
}

function gradeYear(args: {
  net: number
  prevNet: number | null
  movedToGoals: number
  movedToGoalsPrev: number | null
  curDisc: number
  prevDisc: number | null
  monthsInBlack: number
  monthsWithData: number
}): YearGrade {
  const sBlack = args.net >= 0 ? 1 : clamp01(0.5 + args.net / (2 * YEAR_NET_LEVEL_SCALE))

  const sYoY =
    args.prevNet === null ? 0.5 : clamp01(0.5 + (args.net - args.prevNet) / (2 * YEAR_NET_SWING_SCALE))

  let sGoals = 0.2
  if (args.movedToGoals > 0) sGoals = 0.7
  if (args.movedToGoalsPrev !== null && args.movedToGoals > 0 && args.movedToGoals >= args.movedToGoalsPrev)
    sGoals = 0.9
  if (args.movedToGoalsPrev !== null && args.movedToGoals > args.movedToGoalsPrev) sGoals = 1

  const sDisc =
    args.prevDisc !== null && args.prevDisc > 0
      ? clamp01(0.5 + (args.prevDisc - args.curDisc) / args.prevDisc)
      : 0.5

  const sConsistency = args.monthsWithData > 0 ? args.monthsInBlack / args.monthsWithData : 0

  const score =
    YEAR_WEIGHTS.black * sBlack +
    YEAR_WEIGHTS.yoy * sYoY +
    YEAR_WEIGHTS.goals * sGoals +
    YEAR_WEIGHTS.discretionary * sDisc +
    YEAR_WEIGHTS.consistency * sConsistency

  const rounded = Math.round(score)
  return {
    letter: letterFor(rounded),
    score: rounded,
    breakdown: { black: sBlack, yoy: sYoY, goals: sGoals, discretionary: sDisc, consistency: sConsistency },
  }
}

/** Distinct years with data, most recent first. */
export function availableYears(months: string[]): string[] {
  return [...new Set(months.map((m) => m.slice(0, 4)))].sort().reverse()
}

/**
 * Build the review for `targetYear`. When null/invalid it defaults to the most
 * recent *completed* year (strictly before the anchor's), else the latest year.
 */
export async function buildYearReport(targetYear?: string | null): Promise<YearReportResult> {
  const flows = await loadAllFlows()
  const months = availableMonths(flows)
  if (months.length === 0) return { report: null, years: [], year: null }
  const years = availableYears(months)

  const anchor = anchorMonth(flows) ?? months[0]
  const anchorYear = anchor.slice(0, 4)
  const completed = years.filter((y) => y < anchorYear)
  const valid = (y: string | null | undefined): y is string => !!y && years.includes(y)
  const year = valid(targetYear) ? targetYear : (completed[0] ?? years[0])
  const inProgress = year === anchorYear

  const prevYearCandidate = String(Number(year) - 1)
  const prevYear = years.includes(prevYearCandidate) ? prevYearCandidate : null

  const yearMonths = months.filter((m) => m.slice(0, 4) === year).sort()
  const lastDataMonth = yearMonths[yearMonths.length - 1]

  // Income / spend totals (netOverRange semantics: income negated, positive
  // expenses incl. mortgage; refunds/payments/transfers excluded).
  let totalIncome = 0
  let totalSpend = 0
  for (const t of flows) {
    if (t.txnDate.slice(0, 4) !== year) continue
    if (t.flow === 'income') totalIncome += -t.amount
    else if (t.flow === 'expense' && t.amount > 0) totalSpend += t.amount
  }
  totalIncome = round2(totalIncome)
  totalSpend = round2(totalSpend)
  const net = round2(totalIncome - totalSpend)

  let prevIncome: number | null = null
  let prevSpend: number | null = null
  let prevNet: number | null = null
  if (prevYear) {
    let pi = 0
    let ps = 0
    for (const t of flows) {
      if (t.txnDate.slice(0, 4) !== prevYear) continue
      if (t.flow === 'income') pi += -t.amount
      else if (t.flow === 'expense' && t.amount > 0) ps += t.amount
    }
    prevIncome = round2(pi)
    prevSpend = round2(ps)
    prevNet = round2(pi - ps)
  }

  // Month-by-month nets → best/worst month and the consistency signal.
  const monthlyNets: YearMonthNet[] = yearMonths.map((ym) => ({
    ym,
    label: formatMonth(ym),
    net: netOverRange(flows, ym, ym),
  }))
  const settled = monthlyNets.filter((m) => !(inProgress && m.ym === anchor))
  const byNet = [...settled].sort((a, b) => b.net - a.net)
  const bestMonth = byNet[0] ?? null
  const worstMonth = byNet.length > 1 ? byNet[byNet.length - 1] : null
  const monthsInBlack = settled.filter((m) => m.net >= -0.005).length

  // Category YoY winners/losers (discretionary only, credits netted out).
  const credits = categoryCredits(flows)
  const curCats = categoryTotals(flows, credits, year)
  const prevCats = prevYear ? categoryTotals(flows, credits, prevYear) : new Map<string, { color: string; amount: number }>()
  const { wins, slips } = prevYear ? yearCategoryDeltas(curCats, prevCats) : { wins: [], slips: [] }

  // Top merchants & biggest single purchase of the year.
  const merchTotals = new Map<number, MerchantTotal>()
  let biggest: YearReport['biggestPurchase'] = null
  let subscriptionsTotal = 0
  for (const t of flows) {
    if (t.flow !== 'expense' || t.amount <= 0 || t.txnDate.slice(0, 4) !== year) continue
    const e = merchTotals.get(t.merchantId) ?? { id: t.merchantId, name: t.merchantName, amount: 0, count: 0 }
    e.amount += t.amount
    e.count++
    merchTotals.set(t.merchantId, e)
    if (t.isRecurring) subscriptionsTotal += t.amount
    if (!isExcludedFromBiggest(t) && (!biggest || t.amount > biggest.amount)) {
      biggest = { merchant: t.merchantName, amount: t.amount, date: t.txnDate, category: t.categoryName }
    }
  }
  const topMerchants = [...merchTotals.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)
    .map((m) => ({ ...m, amount: round2(m.amount) }))

  const [goalCur, goalPrev, registered, nwData] = await Promise.all([
    goalContributions(year),
    prevYear ? goalContributions(prevYear) : Promise.resolve(null),
    registeredByKind(year),
    loadNetWorth([...(prevYear ? [`${prevYear}-12`] : []), inProgress ? anchor : `${year}-12`]),
  ])
  const nwEnd = nwData.series.find((s) => s.ym === (inProgress ? anchor : `${year}-12`))
  const nwStart = prevYear ? nwData.series.find((s) => s.ym === `${prevYear}-12`) : undefined

  const grade = gradeYear({
    net,
    prevNet,
    movedToGoals: goalCur.total,
    movedToGoalsPrev: goalPrev?.total ?? null,
    curDisc: discretionaryTotal(curCats),
    prevDisc: prevYear ? discretionaryTotal(prevCats) : null,
    monthsInBlack,
    monthsWithData: settled.length,
  })

  const shareLine =
    `${year}: graded ${grade.letter}. Net ${net >= 0 ? '+' : ''}${formatCurrency(net)}` +
    `${prevNet !== null ? ` (${prevNet <= net ? 'up' : 'down'} ${formatCurrency(Math.abs(net - prevNet))} vs ${prevYear})` : ''}` +
    `${goalCur.total > 0 ? `, ${formatCurrency(goalCur.total)} to goals` : ''}.`

  const report: YearReport = {
    year,
    prevYear,
    inProgress,
    lastDataMonth,
    grade,
    quote: quoteForYear(Number(year)),
    totalIncome,
    totalSpend,
    net,
    prevNet,
    prevIncome,
    prevSpend,
    monthlyNets,
    bestMonth,
    worstMonth,
    monthsInBlack,
    categoryWins: wins,
    categorySlips: slips,
    topMerchants,
    biggestPurchase: biggest ? { ...biggest, amount: round2(biggest.amount) } : null,
    subscriptionsTotal: round2(subscriptionsTotal),
    noSpendDays: yearNoSpendDays(flows, year),
    movedToGoals: goalCur.total,
    movedToGoalsPrev: goalPrev?.total ?? null,
    mortgagePrincipal: goalCur.mortgage,
    tfsaContributed: registered.tfsa,
    respContributed: registered.resp,
    netWorthEnd: nwEnd?.value ?? null,
    netWorthStart: nwStart?.value ?? null,
    shareLine,
  }
  return { report, years, year }
}

/** Push payload for the year-settled Year-in-Review notification. */
export function buildYearReportNotification(report: YearReport): {
  title: string
  body: string
  url: string
} {
  const netBit = `Net ${report.net >= 0 ? '+' : ''}${formatCurrency(report.net)} for the year`
  const goalBit = report.movedToGoals > 0 ? ` · ${formatCurrency(report.movedToGoals)} to goals` : ''
  return {
    title: `🎉 Your ${report.year} Year in Review is ready!`,
    body: `Graded ${report.grade.letter}. ${netBit}${goalBit}. Tap for the full rewind ⏪`,
    url: `/report/year?year=${report.year}`,
  }
}
