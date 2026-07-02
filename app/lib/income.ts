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
  net: IncomeLine
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

  // Net = income − spending per month.
  const netValues = labels.map((_, i) => totalIncome.values[i] - spending.values[i])
  const net: IncomeLine = { name: 'Net', color: '#0ea5e9', values: netValues, total: sum(netValues) }

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
    totalIncomeSum: totalIncome.total,
    totalSpendSum: spending.total,
    netSum: net.total,
    avgIncome,
    avgSpend,
    savingsRate: totalIncome.total ? net.total / totalIncome.total : 0,
    best,
    worst,
    bySource,
  }
}
