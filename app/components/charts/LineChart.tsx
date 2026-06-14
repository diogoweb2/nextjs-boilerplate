import { formatCurrencyCompact, formatMonth } from '@/app/lib/format'

export type LineSeries = { color: string; values: number[]; name?: string }

/**
 * Pure-SVG line/area chart for monthly trends. Responsive via viewBox; the
 * container controls width. The first series is drawn as a filled area.
 */
export function LineChart({
  labels,
  series,
  height = 200,
}: {
  labels: string[]
  series: LineSeries[]
  height?: number
}) {
  const width = 640
  const padX = 36
  const padTop = 16
  const padBottom = 28
  const n = labels.length
  const allValues = series.flatMap((s) => s.values)
  const max = Math.max(1, ...allValues)
  const innerW = width - padX * 2
  const innerH = height - padTop - padBottom

  const x = (i: number) => (n <= 1 ? padX + innerW / 2 : padX + (i / (n - 1)) * innerW)
  const y = (v: number) => padTop + innerH - (v / max) * innerH

  // Horizontal gridlines at 0/50/100%.
  const gridYs = [0, 0.5, 1].map((f) => ({ f, y: padTop + innerH - f * innerH, v: f * max }))

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      preserveAspectRatio="none"
      style={{ height }}
    >
      {gridYs.map((g) => (
        <g key={g.f}>
          <line
            x1={padX}
            x2={width - padX}
            y1={g.y}
            y2={g.y}
            stroke="var(--border)"
            strokeWidth={1}
          />
          <text x={4} y={g.y + 3} style={{ fontSize: 9 }} className="fill-[var(--muted)]">
            {formatCurrencyCompact(g.v)}
          </text>
        </g>
      ))}

      {series.map((s, si) => {
        const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')
        const areaPath =
          si === 0 && n > 1
            ? `M ${x(0)},${padTop + innerH} L ${s.values
                .map((v, i) => `${x(i)},${y(v)}`)
                .join(' L ')} L ${x(n - 1)},${padTop + innerH} Z`
            : null
        return (
          <g key={si}>
            {areaPath && <path d={areaPath} fill={s.color} fillOpacity={0.12} />}
            <polyline
              points={pts}
              fill="none"
              stroke={s.color}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {s.values.map((v, i) => {
              const cx = x(i)
              const cy = y(v)
              const labelOffset = 12
              const nearTop = cy - padTop < labelOffset + 4
              const labelY = nearTop ? cy + labelOffset + 4 : cy - labelOffset + 4
              return (
                <g key={i}>
                  <circle cx={cx} cy={cy} r={2.8} fill={s.color}>
                    <title>{`${formatMonth(labels[i])}: ${formatCurrencyCompact(v)}`}</title>
                  </circle>
                  <text
                    x={cx}
                    y={labelY}
                    textAnchor="middle"
                    style={{ fontSize: 8 }}
                    className="fill-[var(--foreground)]"
                    pointerEvents="none"
                  >
                    {formatCurrencyCompact(v)}
                  </text>
                </g>
              )
            })}
          </g>
        )
      })}

      {labels.map((lab, i) => (
        <text
          key={lab}
          x={x(i)}
          y={height - 8}
          textAnchor="middle"
          style={{ fontSize: 9 }}
          className="fill-[var(--muted)]"
        >
          {formatMonth(lab).replace(' 20', " '")}
        </text>
      ))}
    </svg>
  )
}
