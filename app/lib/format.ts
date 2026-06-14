/** Shared formatting helpers. Currency is CAD. */

const cad = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const cadCompact = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
  maximumFractionDigits: 0,
})

export function formatCurrency(value: number): string {
  return cad.format(value)
}

/** No-cents form for big headline numbers. */
export function formatCurrencyCompact(value: number): string {
  return cadCompact.format(value)
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-CA').format(value)
}

/** e.g. +12% / -8%. Returns null when there is no meaningful baseline. */
export function formatPercentDelta(
  current: number,
  previous: number
): { text: string; direction: 'up' | 'down' | 'flat' } | null {
  if (!previous) return null
  const pct = ((current - previous) / Math.abs(previous)) * 100
  const rounded = Math.round(pct)
  if (rounded === 0) return { text: '0%', direction: 'flat' }
  return {
    text: `${rounded > 0 ? '+' : ''}${rounded}%`,
    direction: rounded > 0 ? 'up' : 'down',
  }
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** "2026-06-09" -> "Jun 9". */
export function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${MONTHS[m - 1]} ${d}`
}

/** "2026-06-09" -> "Jun 9, 2026". */
export function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${MONTHS[m - 1]} ${d}, ${y}`
}

/** "2026-06" -> "Jun 2026". */
export function formatMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m) return ym
  return `${MONTHS[m - 1]} ${y}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export function weekdayLabel(index: number): string {
  return WEEKDAYS[index] ?? ''
}
