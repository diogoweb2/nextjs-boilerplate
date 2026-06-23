import { RUNWAY_TARGET, RUNWAY_WARN, runwayStatus, type RunwayStatus } from '@/app/lib/runway'
import { formatShortDate } from '@/app/lib/format'

const STATUS_VAR: Record<RunwayStatus, string> = {
  green: 'var(--positive)',
  amber: 'var(--warning)',
  red: 'var(--negative)',
}

/**
 * Trend of the worst-case emergency runway over time (one point per day it
 * changed). The line/area takes the CURRENT status color (green/amber/red) and
 * each dot is colored by its own status; a dashed 9-month target line marks the
 * goal. Pure SVG, sized by the container. See app/lib/runway.ts.
 */
export function RunwayHistoryChart({
  points,
  height = 130,
}: {
  points: { date: string; months: number | null }[]
  height?: number
}) {
  const width = 640
  const padX = 30
  const padTop = 12
  const padBottom = 22
  const n = points.length
  // null months (∞) plot at the top of the axis.
  const axisMax = Math.max(
    RUNWAY_TARGET + 2,
    Math.ceil(Math.max(0, ...points.map((p) => p.months ?? 0))),
  )
  const valueOf = (m: number | null) => (m === null ? axisMax : m)
  const innerW = width - padX * 2
  const innerH = height - padTop - padBottom
  const x = (i: number) => (n <= 1 ? padX + innerW / 2 : padX + (i / (n - 1)) * innerW)
  const y = (v: number) => padTop + innerH - (Math.min(v, axisMax) / axisMax) * innerH

  const current = points[n - 1]
  const lineColor = STATUS_VAR[runwayStatus(current.months)]
  const linePts = points.map((p, i) => `${x(i)},${y(valueOf(p.months))}`).join(' ')
  const areaPath =
    n > 1
      ? `M ${x(0)},${padTop + innerH} L ${points
          .map((p, i) => `${x(i)},${y(valueOf(p.months))}`)
          .join(' L ')} L ${x(n - 1)},${padTop + innerH} Z`
      : null

  const guides = [
    { v: RUNWAY_TARGET, label: `${RUNWAY_TARGET}mo target` },
    { v: RUNWAY_WARN, label: `${RUNWAY_WARN}mo` },
  ]

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
      {guides.map((g) => (
        <g key={g.v}>
          <line
            x1={padX}
            x2={width - padX}
            y1={y(g.v)}
            y2={y(g.v)}
            stroke="var(--border)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <text x={4} y={y(g.v) + 3} style={{ fontSize: 9 }} className="fill-[var(--muted)]">
            {g.label}
          </text>
        </g>
      ))}

      {areaPath && <path d={areaPath} fill={lineColor} fillOpacity={0.12} />}
      {n > 1 && (
        <polyline
          points={linePts}
          fill="none"
          stroke={lineColor}
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(valueOf(p.months))} r={3} fill={STATUS_VAR[runwayStatus(p.months)]}>
          <title>{`${formatShortDate(p.date)}: ${p.months === null ? '∞' : `${p.months.toFixed(1)} mo`}`}</title>
        </circle>
      ))}

      {/* first & last date labels */}
      {[0, n - 1].map((i, k) =>
        n > 1 || k === 0 ? (
          <text
            key={i}
            x={x(i)}
            y={height - 6}
            textAnchor={i === 0 ? 'start' : 'end'}
            style={{ fontSize: 9 }}
            className="fill-[var(--muted)]"
          >
            {formatShortDate(points[i].date)}
          </text>
        ) : null,
      )}
    </svg>
  )
}
