import { formatCurrency, formatMonth } from '@/app/lib/format'
import type { PricePoint } from '@/app/lib/subscription-watch'

/**
 * Tiny step-line price history for the subscriptions table. A step (not a
 * slope) because a subscription price is flat between charges; the last point
 * gets a dot so a fresh change reads at a glance. Native <title> tooltips per
 * point, matching the app's other pure-SVG charts.
 */
export function PriceSparkline({
  history,
  color = 'var(--accent)',
  width = 120,
  height = 28,
}: {
  history: PricePoint[]
  color?: string
  width?: number
  height?: number
}) {
  const n = history.length
  if (n === 0) return null
  const pad = 4
  const values = history.map((p) => p.amount)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const x = (i: number) => (n <= 1 ? width / 2 : pad + (i / (n - 1)) * (width - pad * 2))
  // Flat history sits mid-band instead of hugging an edge.
  const y = (v: number) =>
    span === 0 ? height / 2 : pad + (1 - (v - min) / span) * (height - pad * 2)

  let d = `M ${x(0)},${y(values[0])}`
  for (let i = 1; i < n; i++) d += ` H ${x(i)} V ${y(values[i])}`

  const last = history[n - 1]
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="false">
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      {history.map((p, i) => (
        <circle
          key={p.ym}
          cx={x(i)}
          cy={y(p.amount)}
          r={i === n - 1 ? 2.5 : 1.2}
          fill={color}
          fillOpacity={i === n - 1 ? 1 : 0.55}
        >
          <title>{`${formatMonth(p.ym)}: ${formatCurrency(p.amount)}`}</title>
        </circle>
      ))}
      <title>{`${formatMonth(last.ym)}: ${formatCurrency(last.amount)}`}</title>
    </svg>
  )
}
