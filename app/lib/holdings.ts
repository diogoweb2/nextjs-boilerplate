/**
 * Parsing & aggregation for the iTrade holdings CSV (the portfolio export, NOT a
 * transaction statement — so it lives outside app/lib/csv.ts). Pure & deterministic.
 *
 * Example header:
 *   Security name,Symbol,Asset class,Currency,Quantity,Average cost ($),
 *   Market price ($),Book value ($),All time value change (%),
 *   All time value change ($),Market value ($)
 *
 * USD positions are valued in CAD using a single USD→CAD rate (fetched from the
 * Bank of Canada on import and stored on the snapshot). All-CAD accounts use 1.
 */

import { parseCsv } from '@/app/lib/csv'

export type ParsedPosition = {
  symbol: string
  name: string
  assetClass: string
  currency: string // 'CAD' | 'USD' | ...
  quantity: number
  avgCost: number
  marketPrice: number
  bookValue: number
  changePct: number
  changeAmount: number
  marketValue: number // in the position's own currency
}

const HEADER_KEYS = ['security name', 'symbol', 'market value ($)']

/** True when the first row looks like an iTrade holdings export header. */
export function isHoldingsCsv(text: string): boolean {
  const rows = parseCsv(text)
  if (rows.length === 0) return false
  const h = rows[0].map((c) => c.trim().toLowerCase())
  return HEADER_KEYS.every((k) => h.includes(k))
}

function col(header: string[], name: string): number {
  return header.findIndex((c) => c.trim().toLowerCase() === name.toLowerCase())
}

function num(raw: string | undefined): number {
  const n = Number((raw ?? '').replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** Parse the holdings CSV into positions. Throws if the header is unrecognized. */
export function parseHoldings(text: string): ParsedPosition[] {
  const rows = parseCsv(text)
  if (rows.length === 0) throw new Error('The file is empty.')
  const header = rows[0]
  const idx = {
    name: col(header, 'Security name'),
    symbol: col(header, 'Symbol'),
    assetClass: col(header, 'Asset class'),
    currency: col(header, 'Currency'),
    quantity: col(header, 'Quantity'),
    avgCost: col(header, 'Average cost ($)'),
    price: col(header, 'Market price ($)'),
    book: col(header, 'Book value ($)'),
    changePct: col(header, 'All time value change (%)'),
    changeAmt: col(header, 'All time value change ($)'),
    marketValue: col(header, 'Market value ($)'),
  }
  if (idx.symbol < 0 || idx.marketValue < 0) {
    throw new Error('Could not recognize this as an iTrade holdings export.')
  }

  const out: ParsedPosition[] = []
  for (const r of rows.slice(1)) {
    const symbol = (r[idx.symbol] ?? '').trim()
    if (!symbol) continue
    out.push({
      symbol,
      name: (r[idx.name] ?? '').trim(),
      assetClass: (r[idx.assetClass] ?? '').trim(),
      currency: ((r[idx.currency] ?? 'CAD').trim() || 'CAD').toUpperCase(),
      quantity: num(r[idx.quantity]),
      avgCost: num(r[idx.avgCost]),
      marketPrice: num(r[idx.price]),
      bookValue: num(r[idx.book]),
      changePct: num(r[idx.changePct]),
      changeAmount: num(r[idx.changeAmt]),
      marketValue: num(r[idx.marketValue]),
    })
  }
  return out
}

/** Convert a native-currency value to CAD using the USD→CAD rate. */
export function toCad(value: number, currency: string, fxUsdCad: number): number {
  if (currency === 'USD') return Math.round(value * fxUsdCad * 100) / 100
  return Math.round(value * 100) / 100
}

/** Total CAD market value across positions for a given USD→CAD rate. */
export function totalValueCad(positions: ParsedPosition[], fxUsdCad: number): number {
  const sum = positions.reduce((s, p) => s + toCad(p.marketValue, p.currency, fxUsdCad), 0)
  return Math.round(sum * 100) / 100
}

/** Total book value (cost basis) across positions in CAD. */
export function totalBookCad(positions: ParsedPosition[], fxUsdCad: number): number {
  const sum = positions.reduce((s, p) => s + toCad(p.bookValue, p.currency, fxUsdCad), 0)
  return Math.round(sum * 100) / 100
}
