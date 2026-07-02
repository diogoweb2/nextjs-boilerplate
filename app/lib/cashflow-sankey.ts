/**
 * Cash-flow Sankey data (Reports → Cash flow). Pure & db-free (operates on the
 * rows loaded by `loadAllFlows`) so it can be unit-tested and its types imported
 * by client components.
 *
 * Model (Monarch-style): income sources → one central "Income" node → expense
 * categories, plus a green "Saved" outflow when income > spend or an amber
 * "From savings" inflow when spend > income. Numbers tie out with the Income
 * page: income = income-kind categories only (reimbursements net against their
 * category instead — same rule as the 50/30/20 card), spending = per-category
 * net of refunds and credits, clamped at 0.
 */
import type { EnrichedTxn } from '@/app/lib/analytics'
import { incomeSourceOf } from '@/app/lib/income'
import { monthsForRange, type ReportRange } from '@/app/lib/custom-reports'

export type SankeyTxn = {
  id: number
  date: string
  merchant: string
  category: string
  /** Signed so the node's list sums to its value: positive = adds to the flow,
   *  negative = a refund/reimbursement netting against it. */
  amount: number
}

export type SankeyEndpoint = {
  key: string
  name: string
  color: string
  value: number
  /** Deep-link category id for expense nodes ('uncategorized' allowed); null for grouped/synthetic nodes. */
  categoryParam: string | null
  /** The transactions behind this node (empty for the synthetic Saved / From-savings nodes). */
  txns: SankeyTxn[]
}

export type CashflowSankeyData = {
  hasData: boolean
  months: string[]
  /** Left column: income sources, sorted desc. */
  incomes: SankeyEndpoint[]
  /** Right column: expense categories (top N + "Other spending"), then "Saved" last when present. */
  spends: SankeyEndpoint[]
  totalIncome: number
  totalSpend: number
  /** income − spend; > 0 → a Saved node exists, < 0 → a From-savings node exists. */
  net: number
}

export const SAVED_COLOR = '#10b981'
export const SHORTFALL_COLOR = '#f59e0b'
export const CENTER_COLOR = '#475569'
const OTHER_SPEND_COLOR = '#94a3b8'

/** Right-column categories shown individually before folding into "Other spending". */
const MAX_SPEND_NODES = 10

function monthKey(d: string) {
  return d.slice(0, 7)
}

export function buildCashflowSankey(
  all: EnrichedTxn[],
  range: ReportRange,
  names: { self: string; partner: string },
  opts: { excludeSpecial?: boolean; month?: string | null } = {},
): CashflowSankeyData {
  // An explicit single month (YYYY-MM) overrides the range window.
  const months = opts.month ? [opts.month] : monthsForRange(all, range)
  const inWindow = new Set(months)
  const rows = all.filter(
    (t) => inWindow.has(monthKey(t.txnDate)) && !(opts.excludeSpecial && t.isSpecial),
  )

  // Income sources (income-kind categories only; the Goal Spend / reimbursement
  // bucket is a wash, not real income — same exclusion as the 50/30/20 base).
  const incomeMap = new Map<string, SankeyEndpoint>()
  for (const t of rows) {
    if (t.flow !== 'income' || t.categoryKind !== 'income') continue
    const src = incomeSourceOf(t, names.self, names.partner)
    if (src.key === 'goal') continue
    const amount = -t.amount // income is stored negative
    const txn = { id: t.id, date: t.txnDate, merchant: t.merchantName, category: t.categoryName, amount }
    const cur = incomeMap.get(src.key)
    if (cur) {
      cur.value += amount
      cur.txns.push(txn)
    } else {
      incomeMap.set(src.key, {
        key: src.key,
        name: src.name,
        color: src.color,
        value: amount,
        categoryParam: null,
        txns: [txn],
      })
    }
  }
  const incomes = [...incomeMap.values()].filter((n) => n.value > 0.005).sort((a, b) => b.value - a.value)
  const totalIncome = incomes.reduce((a, n) => a + n.value, 0)

  // Spending per effective category: purchases + refunds netted, then
  // reimbursement credits subtracted, clamped at 0 (matches buildOverview).
  const spendMap = new Map<string, SankeyEndpoint>()
  const bump = (t: EnrichedTxn, amount: number) => {
    const txn = { id: t.id, date: t.txnDate, merchant: t.merchantName, category: t.categoryName, amount }
    const cur = spendMap.get(t.categoryName)
    if (cur) {
      cur.value += amount
      cur.txns.push(txn)
    } else {
      spendMap.set(t.categoryName, {
        key: `cat:${t.categoryName}`,
        name: t.categoryName,
        color: t.categoryColor,
        value: amount,
        categoryParam: t.categoryId != null ? String(t.categoryId) : 'uncategorized',
        txns: [txn],
      })
    }
  }
  for (const t of rows) if (t.flow === 'expense') bump(t, t.amount)
  // Reimbursement credits (same predicate as analytics' categoryCredits, inlined
  // to keep this module importable by client components — analytics pulls in
  // next/headers via the demo/db loaders). Income stored negative → subtracts.
  for (const t of rows) {
    if (t.flow === 'income' && t.categoryId !== null && t.categoryKind === 'expense') bump(t, t.amount)
  }

  let spends = [...spendMap.values()].filter((n) => n.value > 0.005).sort((a, b) => b.value - a.value)
  if (spends.length > MAX_SPEND_NODES) {
    const kept = spends.slice(0, MAX_SPEND_NODES - 1)
    const folded = spends.slice(MAX_SPEND_NODES - 1)
    kept.push({
      key: 'other-spending',
      name: `Other (${folded.length} categories)`,
      color: OTHER_SPEND_COLOR,
      value: folded.reduce((a, n) => a + n.value, 0),
      categoryParam: null,
      txns: folded.flatMap((n) => n.txns),
    })
    spends = kept
  }
  // Biggest first, so a node's detail list explains itself at a glance.
  for (const n of [...incomes, ...spends]) n.txns.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
  const totalSpend = spends.reduce((a, n) => a + n.value, 0)
  const net = totalIncome - totalSpend

  if (net > 0.005) {
    spends.push({ key: 'saved', name: 'Saved', color: SAVED_COLOR, value: net, categoryParam: null, txns: [] })
  } else if (net < -0.005) {
    incomes.push({
      key: 'shortfall',
      name: 'From savings',
      color: SHORTFALL_COLOR,
      value: -net,
      categoryParam: null,
      txns: [],
    })
  }

  return {
    hasData: incomes.length > 0 || spends.length > 0,
    months,
    incomes,
    spends,
    totalIncome,
    totalSpend,
    net,
  }
}
