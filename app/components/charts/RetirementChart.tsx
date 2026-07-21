import { formatCurrencyCompact } from '@/app/lib/format'

export type RetirementChartRow = {
  year: number
  capitalReal: number
  neededReal: number
  crisisReal: number
}

/**
 * The centerpiece (RETIREMENT_PLAN.md §2.3): a year-axis line chart of projected
 * investable net worth ("You") vs the required-capital glidepath ("Needed"),
 * with the historical-crisis cone shaded below the "You" line. Pure SVG, theme-
 * aware via CSS vars. On-track = the solid line stays above the dashed line.
 */
export function RetirementChart({
  rows,
  retirementYear,
  currentYear,
  height = 300,
}: {
  rows: RetirementChartRow[]
  retirementYear: number
  currentYear: number
  height?: number
}) {
  const width = 720
  const padX = 44
  const padTop = 20
  const padBottom = 30
  const n = rows.length
  const innerW = width - padX * 2
  const innerH = height - padTop - padBottom

  const allVals = rows.flatMap((r) => [r.capitalReal, r.neededReal, r.crisisReal])
  const max = Math.max(1, ...allVals)
  const x = (i: number) => (n <= 1 ? padX + innerW / 2 : padX + (i / (n - 1)) * innerW)
  const y = (v: number) => padTop + innerH - (Math.max(0, v) / max) * innerH

  const yearToI = (yr: number) => {
    const idx = rows.findIndex((r) => r.year === yr)
    return idx >= 0 ? idx : 0
  }

  const line = (key: 'capitalReal' | 'neededReal' | 'crisisReal') =>
    rows.map((r, i) => `${x(i)},${y(r[key])}`).join(' ')

  // Crisis cone: band between the crisis path (lower) and the baseline (upper).
  const conePath =
    `M ${rows.map((r, i) => `${x(i)},${y(r.capitalReal)}`).join(' L ')} ` +
    `L ${[...rows].reverse().map((r, i) => `${x(n - 1 - i)},${y(r.crisisReal)}`).join(' L ')} Z`

  const gridYs = [0, 0.5, 1].map((f) => ({ f, yy: padTop + innerH - f * innerH, v: f * max }))
  const retI = yearToI(retirementYear)
  const todayI = yearToI(currentYear)

  // ~6 year ticks across the axis.
  const tickEvery = Math.max(1, Math.round(n / 6))

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
      {gridYs.map((g) => (
        <g key={g.f}>
          <line x1={padX} x2={width - padX} y1={g.yy} y2={g.yy} stroke="var(--border)" strokeWidth={1} />
          <text x={4} y={g.yy + 3} style={{ fontSize: 9 }} className="fill-[var(--muted)]">
            {formatCurrencyCompact(g.v)}
          </text>
        </g>
      ))}

      {/* Retirement year marker */}
      <line
        x1={x(retI)}
        x2={x(retI)}
        y1={padTop}
        y2={padTop + innerH}
        stroke="var(--muted)"
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      <text x={x(retI)} y={padTop - 6} textAnchor="middle" style={{ fontSize: 9 }} className="fill-[var(--muted)]">
        retire {retirementYear}
      </text>

      {/* Crisis cone */}
      <path d={conePath} fill="#f59e0b" fillOpacity={0.1} />

      {/* Needed glidepath (dashed, neutral) */}
      <polyline
        points={line('neededReal')}
        fill="none"
        stroke="var(--muted)"
        strokeWidth={2}
        strokeDasharray="5 4"
        strokeLinejoin="round"
      />

      {/* You line (solid, accent) */}
      <polyline
        points={line('capitalReal')}
        fill="none"
        stroke="#6366f1"
        strokeWidth={2.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Today dot */}
      <circle cx={x(todayI)} cy={y(rows[todayI]?.capitalReal ?? 0)} r={5} fill="#6366f1" stroke="var(--background)" strokeWidth={2}>
        <title>Today — you are here</title>
      </circle>
      <text x={x(todayI)} y={y(rows[todayI]?.capitalReal ?? 0) - 10} textAnchor="middle" style={{ fontSize: 9 }} className="fill-[var(--foreground)]">
        today
      </text>

      {/* Year axis */}
      {rows.map((r, i) =>
        i % tickEvery === 0 || i === n - 1 ? (
          <text key={r.year} x={x(i)} y={height - 8} textAnchor="middle" style={{ fontSize: 9 }} className="fill-[var(--muted)]">
            {r.year}
          </text>
        ) : null
      )}
    </svg>
  )
}
