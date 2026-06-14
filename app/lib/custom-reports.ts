// type-only import is erased at compile time and does not pull in the db module.
import type { EnrichedTxn } from '@/app/lib/analytics'
import type { ReportSeries } from '@/db/schema'

// These four helpers are duplicated from analytics.ts so that this file can be
// safely imported by client components without pulling in the db connection.
function monthKey(dateIso: string): string {
  return dateIso.slice(0, 7)
}

function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}`
}

function anchorMonth(txns: EnrichedTxn[]): string | null {
  if (txns.length === 0) return null
  return txns.reduce((max, t) => (t.txnDate > max ? t.txnDate : max), txns[0].txnDate).slice(0, 7)
}

function availableMonths(txns: EnrichedTxn[]): string[] {
  const set = new Set(txns.map((t) => t.txnDate.slice(0, 7)))
  return Array.from(set).sort().reverse()
}

/** Period selector values for a custom report. */
export type ReportRange = '1' | '2' | '3' | '6' | '12' | 'ytd' | 'all'

export const REPORT_RANGES: { value: ReportRange; label: string }[] = [
  { value: '1', label: '1M' },
  { value: '2', label: '2M' },
  { value: '3', label: '3M' },
  { value: '6', label: '6M' },
  { value: '12', label: '1Y' },
  { value: 'ytd', label: 'YTD' },
  { value: 'all', label: 'ALL' },
]

export function isReportRange(v: unknown): v is ReportRange {
  return typeof v === 'string' && REPORT_RANGES.some((r) => r.value === v)
}

/** Distinct, readable palette for report lines (cycled when exhausted). */
export const SERIES_COLORS = [
  '#6366f1', // indigo
  '#ef4444', // red
  '#10b981', // emerald
  '#f59e0b', // amber
  '#3b82f6', // blue
  '#ec4899', // pink
  '#14b8a6', // teal
  '#8b5cf6', // violet
  '#f97316', // orange
  '#84cc16', // lime
]

export function nextSeriesColor(usedCount: number): string {
  return SERIES_COLORS[usedCount % SERIES_COLORS.length]
}

function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0)
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Enumerate YYYY-MM labels from `start` to `end` inclusive (chronological). */
function monthRange(start: string, end: string): string[] {
  const out: string[] = []
  let ym = start
  // Guard against pathological inputs.
  for (let i = 0; i < 600 && ym <= end; i++) {
    out.push(ym)
    ym = addMonths(ym, 1)
  }
  return out
}

/**
 * Ordered list of YYYY-MM labels for a range, ending at the dataset anchor
 * (latest month present). Numeric → last N months; 'ytd' → Jan(anchor year)..
 * anchor; 'all' → earliest available month..anchor.
 */
export function monthsForRange(all: EnrichedTxn[], range: ReportRange): string[] {
  const anchor = anchorMonth(all)
  if (!anchor) return []
  if (range === 'ytd') {
    const start = `${anchor.slice(0, 4)}-01`
    return monthRange(start <= anchor ? start : anchor, anchor)
  }
  if (range === 'all') {
    const months = availableMonths(all) // desc
    const earliest = months[months.length - 1] ?? anchor
    return monthRange(earliest, anchor)
  }
  const n = Number(range)
  return monthRange(addMonths(anchor, -(n - 1)), anchor)
}

export type ComputedLine = {
  name: string
  color: string
  values: number[]
  total: number
  /** Mean of complete (prior) months — excludes the anchor "current" month. */
  average: number
  /** Median of complete (prior) months. null when there is no prior month. */
  target: number | null
  /** The anchor (current, possibly partial) month's total. */
  current: number
}

export type ComputedReport = {
  labels: string[]
  lines: ComputedLine[]
}

/**
 * Compute a custom report's per-line monthly series. A transaction contributes
 * to a line when its effective category OR its merchant is listed — counted at
 * most once per line (iterating per transaction guarantees the dedupe). Only
 * purchases (amount > 0) are summed; payments are already excluded upstream.
 */
export function computeReportData(
  all: EnrichedTxn[],
  series: ReportSeries[],
  range: ReportRange
): ComputedReport {
  const labels = monthsForRange(all, range)
  const labelIndex = new Map(labels.map((ym, i) => [ym, i]))
  const purchases = all.filter((t) => t.amount > 0)

  const lines: ComputedLine[] = series.map((s) => {
    const catSet = new Set(s.categoryIds)
    const merchSet = new Set(s.merchantIds)
    const values = new Array(labels.length).fill(0)
    for (const t of purchases) {
      const idx = labelIndex.get(monthKey(t.txnDate))
      if (idx === undefined) continue
      const matches =
        (t.categoryId != null && catSet.has(t.categoryId)) || merchSet.has(t.merchantId)
      if (matches) values[idx] += t.amount
    }
    // Prior (complete) months exclude the last label, treated as "this month".
    const prior = values.slice(0, -1)
    return {
      name: s.name,
      color: s.color,
      values,
      total: sum(values),
      average: prior.length ? sum(prior) / prior.length : 0,
      target: prior.length ? median(prior) : null,
      current: values.length ? values[values.length - 1] : 0,
    }
  })

  return { labels, lines }
}

export type CutSuggestion = {
  name: string
  color: string
  current: number
  average: number
  over: number
}

/**
 * "Where to cut": for each effective category, compare this month (anchor,
 * partial) against its own average over the prior `window` complete months.
 * Returns categories currently running over their historical average, ranked by
 * dollars over. Categories with no history (average 0) are skipped.
 */
export function buildWhereToCut(
  all: EnrichedTxn[],
  { window = 6, top = 6 }: { window?: number; top?: number } = {}
): CutSuggestion[] {
  const anchor = anchorMonth(all)
  if (!anchor) return []
  const priorMonths = new Set(
    Array.from({ length: window }, (_, i) => addMonths(anchor, -(i + 1)))
  )
  const purchases = all.filter((t) => t.amount > 0)

  type Acc = { color: string; current: number; prior: number }
  const byCat = new Map<string, Acc>()
  for (const t of purchases) {
    const ym = monthKey(t.txnDate)
    const isCurrent = ym === anchor
    const isPrior = priorMonths.has(ym)
    if (!isCurrent && !isPrior) continue
    const e = byCat.get(t.categoryName) ?? { color: t.categoryColor, current: 0, prior: 0 }
    if (isCurrent) e.current += t.amount
    else e.prior += t.amount
    byCat.set(t.categoryName, e)
  }

  return [...byCat.entries()]
    .map(([name, e]) => {
      const average = e.prior / window
      return { name, color: e.color, current: e.current, average, over: e.current - average }
    })
    .filter((c) => c.average > 0 && c.over > 0)
    .sort((a, b) => b.over - a.over)
    .slice(0, top)
}
