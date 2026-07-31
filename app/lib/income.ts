/**
 * Income analytics for the Income page. Pure & db-free (operates on the rows
 * loaded by `loadAllFlows`) so it can be unit-tested and its types imported by
 * client components. See BUSINESS_RULES.md §Income.
 *
 * Income is stored with a negative amount (money in); we surface positive
 * numbers here. Spending is the sum of `expense`-flow purchases. The Net line is
 * income − spending per month — the headline "are we ahead?" signal.
 */
import type { EnrichedTxn, ImportSource } from '@/app/lib/analytics'
import { monthsForRange, type ReportRange } from '@/app/lib/custom-reports'

export type IncomeAccount = 'all' | 'tangerine' | 'scotia'

export type IncomeOptions = {
  account?: IncomeAccount
  excludeSpecial?: boolean
}

export type IncomeLine = { name: string; color: string; values: number[]; total: number }

export type IncomeData = {
  hasData: boolean
  labels: string[]
  /** Per-source income lines (self salary, partner salary, family, …). */
  incomeLines: IncomeLine[]
  totalIncome: IncomeLine
  spending: IncomeLine
  /** Net with salary levelled to its monthly equivalent (see `levelSalary`). */
  net: IncomeLine
  /** Net on raw income, matching the bank statement. */
  netActual: IncomeLine
  /** Months that received more salary deposits than the norm (3-cheque months). */
  extraPayMonths: string[]
  totalIncomeSum: number
  totalSpendSum: number
  netSum: number
  /** Mean monthly income/spend over complete (non-anchor) months. */
  avgIncome: number
  avgSpend: number
  savingsRate: number // netSum / totalIncomeSum
  best: { ym: string; net: number } | null
  worst: { ym: string; net: number } | null
  bySource: { name: string; color: string; amount: number; pct: number }[]
}

const SOURCE_COLORS: Record<string, string> = {
  family: '#f59e0b',
  insurance: '#8b5cf6',
  benefits: '#14b8a6',
  goal: '#34d399',
  other: '#94a3b8',
}
const SELF_COLOR = '#22c55e'
const PARTNER_COLOR = '#3b82f6'
export const TOTAL_COLOR = '#16a34a'
export const SPEND_COLOR = '#ef4444'

function monthKey(d: string) {
  return d.slice(0, 7)
}
function sum(ns: number[]) {
  return ns.reduce((a, b) => a + b, 0)
}
/** Mean days per month over a year — converts a pay cadence into pays/month. */
const DAYS_PER_MONTH = 30.436875

function median(ns: number[]): number {
  if (!ns.length) return 0
  const s = [...ns].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000)
}

/**
 * A paycheque source: deposits that arrive on a **sub-monthly cadence** with a
 * **steady amount**. Income rows are largely uncategorised in practice, so this
 * is detected structurally rather than from a "Salary" category.
 *
 *  - cadence 6–16 days → weekly / biweekly / semi-monthly. Monthly sources (child
 *    benefit, interest) are excluded: they already land once per month, so they
 *    cause no sawtooth and need no levelling.
 *  - amount CV ≤ 0.35 → a paycheque is roughly the same every time. Insurance
 *    reimbursements (CV > 2) and one-off deposits fail this.
 *  - ≥ 6 deposits → enough history for the cadence to mean anything.
 *
 * On real data this selects exactly the two payroll sources and nothing else.
 */
const PAY_MIN_GAP = 6
const PAY_MAX_GAP = 16
const PAY_MAX_CV = 0.35
const PAY_MIN_COUNT = 6
/** A real cheque is at least this share of the source's typical deposit. */
const PAY_MIN_SHARE = 0.5

/**
 * Levels paycheque income to its monthly equivalent. Biweekly pay means 26
 * cheques a year, so **most months get 2 and a few get 3** — and a 3-cheque month
 * shows up as a huge fake surplus while its neighbours look like losses. That
 * sawtooth is payroll's calendar, not the family's behaviour.
 *
 * Everything that isn't a paycheque — tax refunds, child benefit, insurance
 * reimbursements, family support, goal offsets — is lumpy *in reality*, so it
 * stays exactly as it posted.
 *
 * Each month with a deposit is credited `avg(recent cheque) × cheques-per-month`.
 * A trailing average (rather than the window total) means a raise flows through
 * within a cheque or two instead of smearing backwards over the whole chart.
 */
type Pay = { date: string; amount: number }
type PaySource = { merchantId: number; pays: Pay[]; paysPerMonth: number }

/**
 * The income merchants that qualify as paycheque sources, with their inferred
 * cadence. Single source of truth for both the levelling and the "extra
 * paycheque" flag, so the two can never disagree.
 */
function paySources(rows: EnrichedTxn[]): PaySource[] {
  const byMerchant = new Map<number, Pay[]>()
  for (const t of rows) {
    if (t.flow !== 'income') continue
    const amount = -t.amount // income stored negative
    if (amount <= 0) continue
    const list = byMerchant.get(t.merchantId) ?? []
    list.push({ date: t.txnDate, amount })
    byMerchant.set(t.merchantId, list)
  }

  const out: PaySource[] = []
  for (const [merchantId, pays] of byMerchant) {
    pays.sort((a, b) => (a.date < b.date ? -1 : 1))
    // Two deposits on one day are one payday split in two (a split direct
    // deposit) — merge before measuring the cadence.
    const merged: Pay[] = []
    for (const p of pays) {
      const last = merged[merged.length - 1]
      if (last && last.date === p.date) last.amount += p.amount
      else merged.push({ ...p })
    }
    if (merged.length < PAY_MIN_COUNT) continue

    // Employers occasionally post a small one-off under the same name (a $27
    // adjustment among $2,900 cheques). Left in, it fakes an extra payday and
    // corrupts the cadence, so drop anything well under a normal cheque.
    const typical = median(merged.map((p) => p.amount))
    const cheques = merged.filter((p) => p.amount >= typical * PAY_MIN_SHARE)
    if (cheques.length < PAY_MIN_COUNT) continue

    const gaps: number[] = []
    for (let i = 1; i < cheques.length; i++) gaps.push(daysBetween(cheques[i - 1].date, cheques[i].date))
    const cadence = median(gaps)
    if (cadence < PAY_MIN_GAP || cadence > PAY_MAX_GAP) continue

    const amounts = cheques.map((p) => p.amount)
    const mean = sum(amounts) / amounts.length
    if (mean <= 0) continue
    const sd = Math.sqrt(sum(amounts.map((a) => (a - mean) ** 2)) / amounts.length)
    if (sd / mean > PAY_MAX_CV) continue

    out.push({ merchantId, pays: cheques, paysPerMonth: DAYS_PER_MONTH / cadence })
  }
  return out
}

/** ym → levelled paycheque income for that month. */
function levelSalary(sources: PaySource[], labels: string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const src of sources) {
    // A month is only levelled once it holds a *full* complement of cheques.
    // This keeps the edges honest: the first month of imported history and the
    // in-progress current month often hold one cheque, and crediting them a full
    // month's equivalent would invent income that hasn't arrived.
    const minPays = Math.floor(src.paysPerMonth)
    for (const ym of labels) {
      const inMonth = src.pays.filter((p) => monthKey(p.date) === ym).length
      if (inMonth < minPays) {
        // Leave it as posted.
        const actual = sum(src.pays.filter((p) => monthKey(p.date) === ym).map((p) => p.amount))
        if (actual) out.set(ym, (out.get(ym) ?? 0) + actual)
        continue
      }
      // Trailing average of the last 3 cheques up to and including this month.
      const upTo = src.pays.filter((p) => monthKey(p.date) <= ym).slice(-3)
      const avgPay = sum(upTo.map((p) => p.amount)) / upTo.length
      out.set(ym, (out.get(ym) ?? 0) + avgPay * src.paysPerMonth)
    }
  }
  return out
}

/**
 * Map an income transaction to its chart line. Salary is split by account
 * (Tangerine = self / BGRS-Sirva, Scotia = partner / payroll); the rest group by
 * category. `self`/`partner` are display names from .env (privacy-safe).
 */
export function incomeSourceOf(t: EnrichedTxn, self: string, partner: string): { key: string; name: string; color: string } {
  if (t.categoryName === 'Salary') {
    return t.source === 'tangerine'
      ? { key: 'self', name: `${self} salary`, color: SELF_COLOR }
      : { key: 'partner', name: `${partner} salary`, color: PARTNER_COLOR }
  }
  if (t.categoryName === 'Family Support') return { key: 'family', name: 'Family', color: SOURCE_COLORS.family }
  if (t.categoryName === 'Insurance') return { key: 'insurance', name: 'Insurance', color: SOURCE_COLORS.insurance }
  if (t.categoryName === 'Benefits') return { key: 'benefits', name: 'Benefits', color: SOURCE_COLORS.benefits }
  // A goal-spend offset — the plain "Goal Spend" bucket, or one "applied to" an
  // expense category (e.g. Home) to cover that purchase. Either way it's a wash,
  // not real income, so it stays in the hidden goal bucket rather than "Other".
  if (t.categoryName === 'Goal Spend' || t.categoryKind === 'expense')
    return { key: 'goal', name: 'Goal Spend', color: SOURCE_COLORS.goal }
  return { key: 'other', name: 'Other', color: SOURCE_COLORS.other }
}

/** Earliest month at which BOTH bank accounts have data (keeps Net comparable). */
function commonStart(all: EnrichedTxn[]): string | null {
  const earliest = new Map<ImportSource, string>()
  for (const t of all) {
    if (t.flow === 'transfer') continue
    const ym = monthKey(t.txnDate)
    const cur = earliest.get(t.source)
    if (!cur || ym < cur) earliest.set(t.source, ym)
  }
  const tang = earliest.get('tangerine')
  const sco = earliest.get('scotia')
  if (tang && sco) return tang > sco ? tang : sco
  return tang ?? sco ?? null
}

export function buildIncome(
  all: EnrichedTxn[],
  range: ReportRange,
  opts: IncomeOptions = {},
  names: { self: string; partner: string } = { self: 'Me', partner: 'Partner' }
): IncomeData {
  const account = opts.account ?? 'all'
  let rows = all.filter((t) => t.flow === 'income' || t.flow === 'expense')
  if (opts.excludeSpecial) rows = rows.filter((t) => !t.isSpecial)
  if (account !== 'all') rows = rows.filter((t) => t.source === account)

  const hasData = rows.some((t) => t.flow === 'income')

  let labels = monthsForRange(rows, range)
  const start = account === 'all' ? commonStart(all) : null
  if (start) labels = labels.filter((ym) => ym >= start)
  const idx = new Map(labels.map((ym, i) => [ym, i]))
  const zeros = () => new Array(labels.length).fill(0)

  // Per-source income lines.
  const lineMap = new Map<string, IncomeLine>()
  const totalIncome: IncomeLine = { name: 'Total income', color: TOTAL_COLOR, values: zeros(), total: 0 }
  for (const t of rows) {
    if (t.flow !== 'income') continue
    const i = idx.get(monthKey(t.txnDate))
    if (i === undefined) continue
    const amt = -t.amount // income stored negative
    const src = incomeSourceOf(t, names.self, names.partner)
    const line = lineMap.get(src.key) ?? { name: src.name, color: src.color, values: zeros(), total: 0 }
    line.values[i] += amt
    line.total += amt
    lineMap.set(src.key, line)
    totalIncome.values[i] += amt
    totalIncome.total += amt
  }
  const ORDER = ['self', 'partner', 'family', 'insurance', 'benefits', 'other']
  const incomeLines = ORDER.filter((k) => lineMap.has(k)).map((k) => lineMap.get(k)!)

  // Spending line (expense purchases only).
  const spending: IncomeLine = { name: 'Spending', color: SPEND_COLOR, values: zeros(), total: 0 }
  for (const t of rows) {
    if (t.flow !== 'expense' || t.amount <= 0) continue
    const i = idx.get(monthKey(t.txnDate))
    if (i === undefined) continue
    spending.values[i] += t.amount
    spending.total += t.amount
  }

  // Salary levelled to its monthly equivalent, so 3-paycheque months stop
  // reading as windfalls. Non-salary income is left exactly as it posted.
  const sources = paySources(rows)
  const levelled = levelSalary(sources, labels)
  // Only the cheques themselves are swapped for their levelled equivalent — any
  // stray deposit under the same employer stays in the actuals untouched.
  const actualSalary = zeros()
  for (const src of sources) {
    for (const p of src.pays) {
      const i = idx.get(monthKey(p.date))
      if (i !== undefined) actualSalary[i] += p.amount
    }
  }
  const levelledIncome = labels.map(
    (ym, i) => totalIncome.values[i] - actualSalary[i] + (levelled.get(ym) ?? 0)
  )

  // Net = income − spending per month, on the levelled income.
  const netValues = labels.map((_, i) => levelledIncome[i] - spending.values[i])
  const net: IncomeLine = { name: 'Net', color: '#0ea5e9', values: netValues, total: sum(netValues) }
  // The same net on raw, unlevelled income — what the bank statement says.
  const netActualValues = labels.map((_, i) => totalIncome.values[i] - spending.values[i])
  const netActual: IncomeLine = {
    name: 'Net (as posted)',
    color: '#0ea5e9',
    values: netActualValues,
    total: sum(netActualValues),
  }
  // Months with more paydays than the norm — the bars worth explaining. Counted
  // in *paydays* (not deposits), so two employers paying on the same Thursday
  // count once.
  const payCounts = labels.map((ym) => {
    const days = new Set<string>()
    for (const src of sources) for (const p of src.pays) if (monthKey(p.date) === ym) days.add(p.date)
    return days.size
  })
  const normalPays = median(payCounts.filter((n) => n > 0))
  const extraPayMonths = labels.filter((_, i) => payCounts[i] > normalPays)

  // Best/worst & averages over complete (non-anchor) months when possible.
  const completeCount = labels.length > 1 ? labels.length - 1 : labels.length
  const complete = labels.slice(0, completeCount)
  let best: IncomeData['best'] = null
  let worst: IncomeData['worst'] = null
  complete.forEach((ym, i) => {
    const n = netValues[i]
    if (!best || n > best.net) best = { ym, net: n }
    if (!worst || n < worst.net) worst = { ym, net: n }
  })
  const avgIncome = completeCount ? sum(totalIncome.values.slice(0, completeCount)) / completeCount : 0
  const avgSpend = completeCount ? sum(spending.values.slice(0, completeCount)) / completeCount : 0

  const bySource = incomeLines
    .map((l) => ({
      name: l.name,
      color: l.color,
      amount: l.total,
      pct: totalIncome.total ? l.total / totalIncome.total : 0,
    }))
    .sort((a, b) => b.amount - a.amount)

  return {
    hasData,
    labels,
    incomeLines,
    totalIncome,
    spending,
    net,
    netActual,
    extraPayMonths,
    totalIncomeSum: totalIncome.total,
    totalSpendSum: spending.total,
    // Headline totals stay on real money — levelling is a per-month display aid,
    // and over a window it drifts (12 × 2.17 cheques ≠ the 26 actually banked).
    netSum: netActual.total,
    avgIncome,
    avgSpend,
    savingsRate: totalIncome.total ? netActual.total / totalIncome.total : 0,
    best,
    worst,
    bySource,
  }
}

/**
 * Paycheque timing for one month. Biweekly pay gives most months 2 cheques and a
 * few 3 — and a 3-cheque month's surplus is not repeatable capacity, it's the
 * buffer that funds the 2-cheque months either side of it.
 *
 * The surplus card uses this to say so out loud, rather than levelling the
 * figure: allocation moves real dollars, so the headline must stay as-posted or
 * the extra cheque would never get a job.
 */
export type PaydayContext = {
  /** Distinct paydays landing in this month. */
  paydays: number
  /** The usual count for this pay cadence (2 for biweekly). */
  typicalPaydays: number
  /** Value of the surplus cheque(s) beyond the usual count — 0 in normal months. */
  extraCheque: number
}

export function paydayContext(all: EnrichedTxn[], ym: string): PaydayContext | null {
  const rows = all.filter((t) => t.flow === 'income')
  const sources = paySources(rows)
  if (!sources.length) return null

  const days = new Set<string>()
  let extraCheque = 0
  let typicalPaydays = 0
  for (const src of sources) {
    const inMonth = src.pays.filter((p) => monthKey(p.date) === ym)
    for (const p of inMonth) days.add(p.date)
    const typical = Math.floor(src.paysPerMonth)
    typicalPaydays = Math.max(typicalPaydays, typical)
    const surplusCheques = inMonth.length - typical
    if (surplusCheques > 0) {
      // Value the extra at this source's recent cheque, not the month's average.
      const recent = src.pays.filter((p) => monthKey(p.date) <= ym).slice(-3)
      extraCheque += (sum(recent.map((p) => p.amount)) / recent.length) * surplusCheques
    }
  }
  return { paydays: days.size, typicalPaydays, extraCheque: Math.round(extraCheque * 100) / 100 }
}
