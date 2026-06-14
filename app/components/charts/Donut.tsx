import { formatCurrencyCompact } from '@/app/lib/format'

export type DonutSegment = { name: string; color: string; amount: number; pct: number }

/** Pure-SVG donut. Renders a centered total and a legend with percentages. */
export function Donut({
  segments,
  total,
}: {
  segments: DonutSegment[]
  total: number
}) {
  const size = 180
  const stroke = 22
  const radius = (size - stroke) / 2
  const circ = 2 * Math.PI * radius

  const visible = segments.filter((s) => s.amount > 0)
  // Precompute each arc length + its cumulative start offset (no render mutation).
  const lens = visible.map((s) => s.pct * circ)
  const arcs = visible.map((s, i) => ({
    seg: s,
    len: lens[i],
    offset: lens.slice(0, i).reduce((a, b) => a + b, 0),
  }))

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-7">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--surface-2)"
            strokeWidth={stroke}
          />
          {arcs.map(({ seg: s, len, offset }) => (
            <circle
              key={s.name}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={s.color}
              strokeWidth={stroke}
              strokeDasharray={`${len} ${circ - len}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
            >
              <title>{`${s.name}: ${formatCurrencyCompact(s.amount)} (${Math.round(s.pct * 100)}%)`}</title>
            </circle>
          ))}
        </g>
        <text
          x="50%"
          y="46%"
          textAnchor="middle"
          className="fill-[var(--muted)]"
          style={{ fontSize: 11 }}
        >
          Total
        </text>
        <text
          x="50%"
          y="60%"
          textAnchor="middle"
          className="fill-[var(--foreground)]"
          style={{ fontSize: 19, fontWeight: 700 }}
        >
          {formatCurrencyCompact(total)}
        </text>
      </svg>

      <ul className="grid w-full grid-cols-1 gap-1.5 sm:max-w-[260px]">
        {visible.slice(0, 7).map((s) => (
          <li key={s.name} className="flex items-center gap-2 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: s.color }}
            />
            <span className="flex-1 truncate text-[var(--foreground)]">{s.name}</span>
            <span className="tabular-nums text-[var(--muted)]">
              {Math.round(s.pct * 100)}%
            </span>
            <span className="w-20 text-right tabular-nums font-medium">
              {formatCurrencyCompact(s.amount)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
