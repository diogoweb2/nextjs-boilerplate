import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { transactions, merchants, categories } from '@/db/schema'
import { formatMonth } from '@/app/lib/format'
import { isDemoSession } from '@/app/lib/demo'

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
  categoryKind: 'expense' | 'income' | 'neutral' | null
  isRecurring: boolean
  /** Owner-declared yearly billing for this merchant (see merchants.recurringAnnual). */
  recurringAnnual: boolean
  isSpecial: boolean
  batchId: number | null
  categorizeDismissed?: boolean
}

const NO_CATEGORY = { name: 'Uncategorized', color: '#94a3b8' }

/**
 * Load every non-payment transaction (all flows), joined with its merchant and
 * effective category. Card payments are always excluded. The dataset is small
 * (hundreds of rows/year) so we aggregate in JS for flexibility.
 */
export async function loadAllFlows(): Promise<EnrichedTxn[]> {
  if (await isDemoSession()) {
    const { demoAllFlows } = await import('@/app/lib/demo-data')
    return demoAllFlows()
  }
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
      categorizeDismissed: transactions.categorizeDismissed,
      batchId: transactions.batchId,
      merchantId: merchants.id,
      merchantName: merchants.name,
      merchantCategoryId: merchants.categoryId,
      merchantRecurring: merchants.defaultRecurring,
      merchantAnnual: merchants.recurringAnnual,
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
        categoryKind: cat?.kind ?? null,
        isRecurring: r.txnRecurring ?? r.merchantRecurring,
        recurringAnnual: r.merchantAnnual,
        isSpecial: r.txnSpecial ?? r.merchantSpecial,
        batchId: r.batchId,
        categorizeDismissed: r.categorizeDismissed,
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

/**
 * "Category credits" — income filed under an *expense* category. Per BUSINESS_RULES
 * these are reimbursements that net against the category (e.g. dental insurance
 * under Dental), and a goal-spend "applied to a category" (pulling from a
 * kitchen-reno goal into Home to cover that purchase) is recorded the same way.
 * Ordinary income lives in income/neutral categories, so it's never picked up here.
 * The spend aggregations (`buildOverview`, `buildTrends`) subtract these per
 * category so the covered/reimbursed spend drops out of that category's tile /
 * report — matching the 50/30/20 rule's per-category net. Income stored negative,
 * so the caller negates to get a positive offset.
 */
export function categoryCredits(flows: EnrichedTxn[]): EnrichedTxn[] {
  return flows.filter((t) => t.flow === 'income' && t.categoryId !== null && t.categoryKind === 'expense')
}

/** Convenience for pages that only load the expense set via `loadEnriched`: the
 *  category credits to pass alongside into `buildOverview`/`buildTrends`. */
export async function loadCategoryCredits(): Promise<EnrichedTxn[]> {
  return categoryCredits(await loadAllFlows())
}

/** Sum credits (as positive offsets) per category name over the rows the
 *  predicate keeps. Shared by the overview/trends netting. */
function creditByCategory(credits: EnrichedTxn[], inRange: (t: EnrichedTxn) => boolean): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of credits) {
    if (!inRange(t)) continue
    m.set(t.categoryName, (m.get(t.categoryName) ?? 0) + -t.amount)
  }
  return m
}

/** Apply a credit map to a category-total map in place, clamped at 0. */
function applyCredits(catMap: Map<string, number>, credits: Map<string, number>): void {
  for (const [name, credit] of credits) {
    const cur = catMap.get(name)
    if (cur === undefined) continue
    catMap.set(name, Math.max(0, cur - credit))
  }
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

/**
 * Net (income − spend) over the inclusive [startYm, endYm] month range, matching
 * the Income / Budget `ytdNet` definition: income flow summed (stored negative,
 * so negated), positive expenses summed (mortgage included), refunds / payments /
 * transfers excluded. Shared by Goals (net-zero) and the monthly report.
 */
export function netOverRange(txns: EnrichedTxn[], startYm: string, endYm: string): number {
  let income = 0
  let spend = 0
  for (const t of txns) {
    const ym = t.txnDate.slice(0, 7)
    if (ym < startYm || ym > endYm) continue
    if (t.flow === 'income') income += -t.amount
    else if (t.flow === 'expense' && t.amount > 0) spend += t.amount
  }
  return Math.round((income - spend) * 100) / 100
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

function dayOfMonth(dateIso: string): number {
  return Number(dateIso.slice(8, 10))
}


/**
 * Categories whose fixed bills shouldn't headline the "biggest purchase" tiles
 * (Home = mortgage, property tax, hydro, water — always the largest line).
 */
const BIGGEST_PURCHASE_EXCLUDE_CATEGORIES = new Set(['Home', 'Dental'])

/** Specific recurring merchants to also keep out of "biggest purchase" (lowercased substrings). */
const BIGGEST_PURCHASE_EXCLUDE_MERCHANTS = ['scholars']

export function isExcludedFromBiggest(t: EnrichedTxn): boolean {
  if (BIGGEST_PURCHASE_EXCLUDE_CATEGORIES.has(t.categoryName)) return true
  const name = t.merchantName.toLowerCase()
  return BIGGEST_PURCHASE_EXCLUDE_MERCHANTS.some((m) => name.includes(m))
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
  prevCount: number
  prevAvg: number
  largest: { merchant: string; amount: number; date: string; category: string } | null
  categoryCards: { label: string; name: string; color: string; amount: number; prevAmount: number }[]
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
  exactMonth?: string | null,
  credits: EnrichedTxn[] = []
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

  // Same-period (apples-to-apples) comparison. When the current window reaches
  // the in-progress anchor month, the previous period's matching month is
  // clamped to the same day-of-month so we never compare a full month against a
  // partial one (e.g. all of May vs the first 18 days of June).
  const includesAnchor = end === anchor
  const anchorDay = filtered
    .filter((t) => monthKey(t.txnDate) === anchor)
    .reduce((max, t) => Math.max(max, dayOfMonth(t.txnDate)), 0)

  const prevEnd = addMonths(start, -1)
  const prevStart = exactMonth ? prevEnd : addMonths(prevEnd, -(months - 1))
  const inPrevWindow = (t: EnrichedTxn) => {
    const ym = monthKey(t.txnDate)
    if (ym < prevStart || ym > prevEnd) return false
    // Clamp the month aligned with the partial anchor month to the same days.
    if (includesAnchor && ym === prevEnd && dayOfMonth(t.txnDate) > anchorDay) return false
    return true
  }
  const prev = filtered.filter(inPrevWindow)

  // Goal-spend credits "applied to a category" reduce that category's spend.
  const creditPool = excludeSpecial ? credits.filter((t) => !t.isSpecial) : credits
  const curCredit = creditByCategory(creditPool, (t) => inWindow(t, start, end))
  const prevCredit = creditByCategory(creditPool, inPrevWindow)

  const purchases = cur.filter((t) => t.amount > 0)
  const gross = sum(purchases.map((t) => t.amount))
  const refunds = sum(cur.filter((t) => t.amount < 0).map((t) => t.amount))
  const net = gross + refunds
  const count = purchases.length
  const avg = count ? gross / count : 0
  const prevPurchases = prev.filter((t) => t.amount > 0)
  const prevGross = sum(prevPurchases.map((t) => t.amount))
  const prevCount = prevPurchases.length
  const prevAvg = prevCount ? prevGross / prevCount : 0

  // Per-category quick tiles: top 7 by current spend + always Uncategorized if non-zero.
  const prevCatMap = new Map<string, number>()
  for (const t of prevPurchases) prevCatMap.set(t.categoryName, (prevCatMap.get(t.categoryName) ?? 0) + t.amount)
  applyCredits(prevCatMap, prevCredit)
  const curCatMap = new Map<string, { color: string; amount: number }>()
  for (const t of purchases) {
    const e = curCatMap.get(t.categoryName) ?? { color: t.categoryColor, amount: 0 }
    e.amount += t.amount
    curCatMap.set(t.categoryName, e)
  }
  for (const [name, credit] of curCredit) {
    const e = curCatMap.get(name)
    if (e) e.amount = Math.max(0, e.amount - credit)
  }
  const uncatEntry = curCatMap.get('Uncategorized')
  const categoryCards = [
    ...[...curCatMap.entries()]
      .filter(([name]) => name !== 'Uncategorized')
      .sort((a, b) => b[1].amount - a[1].amount)
      .slice(0, 7)
      .map(([name, v]) => ({ label: name, name, color: v.color, amount: v.amount, prevAmount: prevCatMap.get(name) ?? 0 })),
    ...(uncatEntry && uncatEntry.amount > 0
      ? [{ label: 'Uncategorized', name: 'Uncategorized', color: '#94a3b8', amount: uncatEntry.amount, prevAmount: prevCatMap.get('Uncategorized') ?? 0 }]
      : []),
  ]

  // Category breakdown (gross purchases, net of any goal-spend credits).
  const catTotals = new Map<string, { color: string; amount: number }>()
  for (const t of purchases) {
    const e = catTotals.get(t.categoryName) ?? { color: t.categoryColor, amount: 0 }
    e.amount += t.amount
    catTotals.set(t.categoryName, e)
  }
  for (const [name, credit] of curCredit) {
    const e = catTotals.get(name)
    if (e) e.amount = Math.max(0, e.amount - credit)
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

  // "Biggest purchase(s)" exclude fixed Home bills (mortgage, property tax, …)
  // and named recurring bills like Scholars.
  const topTransactions = purchases
    .filter((t) => !isExcludedFromBiggest(t))
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
    prevCount,
    prevAvg,
    largest,
    categoryCards,
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
  exactMonth?: string | null,
  credits: EnrichedTxn[] = []
): Trends {
  const anchor = anchorMonth(all)
  if (!anchor) return { hasData: false, anchor: null, months, total: [], categories: [], months_labels: [] }
  const filtered = excludeSpecial ? all.filter((t) => !t.isSpecial) : all

  // Goal-spend credits applied to a category, summed per category + month, so each
  // category's monthly series drops by the spend the goal covered. Income stored
  // negative → negate for a positive offset.
  const creditPool = excludeSpecial ? credits.filter((t) => !t.isSpecial) : credits
  const creditByCatYm = new Map<string, number>()
  for (const t of creditPool) {
    const key = `${t.categoryName}|${monthKey(t.txnDate)}`
    creditByCatYm.set(key, (creditByCatYm.get(key) ?? 0) + -t.amount)
  }

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
      const series = labels.map((ym) => {
        const gross = sum(
          filtered
            .filter((t) => t.amount > 0 && t.categoryName === name && monthKey(t.txnDate) === ym)
            .map((t) => t.amount)
        )
        return Math.max(0, gross - (creditByCatYm.get(`${name}|${ym}`) ?? 0))
      })
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
    prevCount: 0,
    prevAvg: 0,
    largest: null,
    categoryCards: [],
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
