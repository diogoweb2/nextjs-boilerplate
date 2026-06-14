import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { transactions, merchants, categories } from '@/db/schema'
import { formatMonth } from '@/app/lib/format'

export type ImportSource = 'master' | 'amex' | 'tangerine' | 'scotia'
export type Flow = 'expense' | 'income' | 'transfer'

export type EnrichedTxn = {
  id: number
  source: ImportSource
  flow: Flow
  txnDate: string
  rawDescription: string
  amount: number
  merchantId: number
  merchantName: string
  categoryId: number | null
  categoryName: string
  categoryColor: string
  isRecurring: boolean
  isSpecial: boolean
  batchId: number | null
}

const NO_CATEGORY = { name: 'Uncategorized', color: '#94a3b8' }

/**
 * Load every non-payment transaction (all flows), joined with its merchant and
 * effective category. Card payments are always excluded. The dataset is small
 * (hundreds of rows/year) so we aggregate in JS for flexibility.
 */
export async function loadAllFlows(): Promise<EnrichedTxn[]> {
  const cats = await db.select().from(categories)
  const catMap = new Map(cats.map((c) => [c.id, c]))

  const rows = await db
    .select({
      id: transactions.id,
      source: transactions.source,
      flow: transactions.flow,
      txnDate: transactions.txnDate,
      rawDescription: transactions.rawDescription,
      amount: transactions.amount,
      isPayment: transactions.isPayment,
      txnCategoryId: transactions.categoryId,
      txnRecurring: transactions.isRecurring,
      txnSpecial: transactions.isSpecial,
      batchId: transactions.batchId,
      merchantId: merchants.id,
      merchantName: merchants.name,
      merchantCategoryId: merchants.categoryId,
      merchantRecurring: merchants.defaultRecurring,
      merchantSpecial: merchants.defaultSpecial,
    })
    .from(transactions)
    .innerJoin(merchants, eq(transactions.merchantId, merchants.id))

  return rows
    .filter((r) => !r.isPayment)
    .map((r) => {
      const effectiveCatId = r.txnCategoryId ?? r.merchantCategoryId ?? null
      const cat = effectiveCatId != null ? catMap.get(effectiveCatId) : undefined
      return {
        id: r.id,
        source: r.source,
        flow: r.flow,
        txnDate: r.txnDate,
        rawDescription: r.rawDescription,
        amount: Number(r.amount),
        merchantId: r.merchantId,
        merchantName: r.merchantName,
        categoryId: effectiveCatId,
        categoryName: cat?.name ?? NO_CATEGORY.name,
        categoryColor: cat?.color ?? NO_CATEGORY.color,
        isRecurring: r.txnRecurring ?? r.merchantRecurring,
        isSpecial: r.txnSpecial ?? r.merchantSpecial,
        batchId: r.batchId,
      }
    })
}

/**
 * Spending dataset: only `expense`-flow rows. Income and inter-account/ignored
 * transfers are excluded so all the existing spend pages (Overview, Trends,
 * Custom, Insights) keep working — they now also include bank expenses
 * (mortgage, hydro, …) automatically.
 */
export async function loadEnriched(): Promise<EnrichedTxn[]> {
  const all = await loadAllFlows()
  return all.filter((t) => t.flow === 'expense')
}

// ---------- period helpers ----------

export function monthKey(dateIso: string): string {
  return dateIso.slice(0, 7)
}

export function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}`
}

/** Sorted list of YYYY-MM strings present in the dataset, most recent first. */
export function availableMonths(txns: EnrichedTxn[]): string[] {
  const set = new Set(txns.map((t) => t.txnDate.slice(0, 7)))
  return Array.from(set).sort().reverse()
}

export function anchorMonth(txns: EnrichedTxn[]): string | null {
  if (txns.length === 0) return null
  return txns.reduce((max, t) => (t.txnDate > max ? t.txnDate : max), txns[0].txnDate).slice(0, 7)
}

/** Inclusive [start, end] month window for the current period of `months` length. */
export function periodWindow(anchor: string, months: number) {
  const end = anchor
  const start = addMonths(anchor, -(months - 1))
  return { start, end }
}

function inWindow(t: EnrichedTxn, start: string, end: string): boolean {
  const ym = monthKey(t.txnDate)
  return ym >= start && ym <= end
}

const WEEKDAY_COUNT = 7

function weekdayOf(dateIso: string): number {
  return new Date(`${dateIso}T00:00:00`).getDay()
}

// ---------- aggregations ----------

export type Overview = {
  hasData: boolean
  anchor: string | null
  periodLabel: string
  months: number
  gross: number
  net: number
  refunds: number
  count: number
  avg: number
  prevGross: number
  largest: { merchant: string; amount: number; date: string; category: string } | null
  byCategory: { name: string; color: string; amount: number; pct: number }[]
  topMerchants: { id: number; name: string; amount: number; count: number }[]
  topTransactions: {
    id: number
    merchant: string
    amount: number
    date: string
    category: string
  }[]
  byWeekday: { weekday: number; amount: number }[]
  weekendShare: number
  concentration: { topShare: number; names: string[] }
  monthly: { ym: string; amount: number }[]
  recurring: { name: string; amount: number; count: number }[]
}

export function buildOverview(
  all: EnrichedTxn[],
  months: number,
  excludeSpecial: boolean,
  exactMonth?: string | null
): Overview {
  const anchor = anchorMonth(all)
  if (!anchor) {
    return emptyOverview(months)
  }
  const filtered = excludeSpecial ? all.filter((t) => !t.isSpecial) : all

  let start: string, end: string
  if (exactMonth) {
    start = exactMonth
    end = exactMonth
  } else {
    ;({ start, end } = periodWindow(anchor, months))
  }
  const cur = filtered.filter((t) => inWindow(t, start, end))

  const prevEnd = addMonths(start, -1)
  const prevStart = exactMonth ? prevEnd : addMonths(prevEnd, -(months - 1))
  const prev = filtered.filter((t) => inWindow(t, prevStart, prevEnd))

  const purchases = cur.filter((t) => t.amount > 0)
  const gross = sum(purchases.map((t) => t.amount))
  const refunds = sum(cur.filter((t) => t.amount < 0).map((t) => t.amount))
  const net = gross + refunds
  const count = purchases.length
  const avg = count ? gross / count : 0
  const prevGross = sum(prev.filter((t) => t.amount > 0).map((t) => t.amount))

  // Category breakdown (gross purchases only).
  const catTotals = new Map<string, { color: string; amount: number }>()
  for (const t of purchases) {
    const e = catTotals.get(t.categoryName) ?? { color: t.categoryColor, amount: 0 }
    e.amount += t.amount
    catTotals.set(t.categoryName, e)
  }
  const byCategory = [...catTotals.entries()]
    .map(([name, v]) => ({ name, color: v.color, amount: v.amount, pct: gross ? v.amount / gross : 0 }))
    .sort((a, b) => b.amount - a.amount)

  // Merchant breakdown.
  const merchTotals = new Map<number, { name: string; amount: number; count: number }>()
  for (const t of purchases) {
    const e = merchTotals.get(t.merchantId) ?? { name: t.merchantName, amount: 0, count: 0 }
    e.amount += t.amount
    e.count++
    merchTotals.set(t.merchantId, e)
  }
  const merchSorted = [...merchTotals.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.amount - a.amount)
  const topMerchants = merchSorted.slice(0, 8)

  const top3 = merchSorted.slice(0, 3)
  const concentration = {
    topShare: gross ? sum(top3.map((m) => m.amount)) / gross : 0,
    names: top3.map((m) => m.name),
  }

  const topTransactions = [...purchases]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8)
    .map((t) => ({
      id: t.id,
      merchant: t.merchantName,
      amount: t.amount,
      date: t.txnDate,
      category: t.categoryName,
    }))

  const largest = topTransactions[0]
    ? {
        merchant: topTransactions[0].merchant,
        amount: topTransactions[0].amount,
        date: topTransactions[0].date,
        category: topTransactions[0].category,
      }
    : null

  // Weekday distribution.
  const weekdayTotals = Array.from({ length: WEEKDAY_COUNT }, (_, i) => ({ weekday: i, amount: 0 }))
  for (const t of purchases) weekdayTotals[weekdayOf(t.txnDate)].amount += t.amount
  const weekendAmount = weekdayTotals[0].amount + weekdayTotals[6].amount
  const weekendShare = gross ? weekendAmount / gross : 0

  // Recurring (subscriptions) in the period.
  const recurringMap = new Map<string, { amount: number; count: number }>()
  for (const t of purchases.filter((t) => t.isRecurring)) {
    const e = recurringMap.get(t.merchantName) ?? { amount: 0, count: 0 }
    e.amount += t.amount
    e.count++
    recurringMap.set(t.merchantName, e)
  }
  const recurring = [...recurringMap.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.amount - a.amount)

  // 12-month spend series for sparkline/trends.
  const monthly = monthlySeries(filtered, anchor, 12)

  return {
    hasData: true,
    anchor,
    periodLabel: exactMonth ? formatMonth(exactMonth) : months === 1 ? 'This month' : `Last ${months} months`,
    months,
    gross,
    net,
    refunds,
    count,
    avg,
    prevGross,
    largest,
    byCategory,
    topMerchants,
    topTransactions,
    byWeekday: weekdayTotals,
    weekendShare,
    concentration,
    monthly,
    recurring,
  }
}

export function monthlySeries(
  txns: EnrichedTxn[],
  anchor: string,
  months: number
): { ym: string; amount: number }[] {
  const out: { ym: string; amount: number }[] = []
  for (let i = months - 1; i >= 0; i--) {
    const ym = addMonths(anchor, -i)
    const amount = sum(
      txns.filter((t) => t.amount > 0 && monthKey(t.txnDate) === ym).map((t) => t.amount)
    )
    out.push({ ym, amount })
  }
  return out
}

export type Trends = {
  hasData: boolean
  anchor: string | null
  months: number
  total: { ym: string; amount: number }[]
  categories: { name: string; color: string; categoryId: number | null; series: number[]; total: number }[]
  months_labels: string[]
}

export function buildTrends(
  all: EnrichedTxn[],
  months: number,
  excludeSpecial: boolean,
  exactMonth?: string | null
): Trends {
  const anchor = anchorMonth(all)
  if (!anchor) return { hasData: false, anchor: null, months, total: [], categories: [], months_labels: [] }
  const filtered = excludeSpecial ? all.filter((t) => !t.isSpecial) : all

  const labels: string[] = []
  if (exactMonth) {
    labels.push(exactMonth)
  } else {
    for (let i = months - 1; i >= 0; i--) labels.push(addMonths(anchor, -i))
  }

  const total = labels.map((ym) => ({
    ym,
    amount: sum(filtered.filter((t) => t.amount > 0 && monthKey(t.txnDate) === ym).map((t) => t.amount)),
  }))

  // Per-category series.
  const catMeta = new Map<string, { color: string; id: number | null }>()
  for (const t of filtered) {
    if (!catMeta.has(t.categoryName)) catMeta.set(t.categoryName, { color: t.categoryColor, id: t.categoryId })
  }

  const categories = [...catMeta.entries()]
    .map(([name, meta]) => {
      const series = labels.map((ym) =>
        sum(
          filtered
            .filter((t) => t.amount > 0 && t.categoryName === name && monthKey(t.txnDate) === ym)
            .map((t) => t.amount)
        )
      )
      return { name, color: meta.color, categoryId: meta.id, series, total: sum(series) }
    })
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total)

  return { hasData: true, anchor, months, total, categories, months_labels: labels }
}

function emptyOverview(months: number): Overview {
  return {
    hasData: false,
    anchor: null,
    periodLabel: months === 1 ? 'This month' : `Last ${months} months`,
    months,
    gross: 0,
    net: 0,
    refunds: 0,
    count: 0,
    avg: 0,
    prevGross: 0,
    largest: null,
    byCategory: [],
    topMerchants: [],
    topTransactions: [],
    byWeekday: Array.from({ length: WEEKDAY_COUNT }, (_, i) => ({ weekday: i, amount: 0 })),
    weekendShare: 0,
    concentration: { topShare: 0, names: [] },
    monthly: [],
    recurring: [],
  }
}

function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0)
}
