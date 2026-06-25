'use client'

import { formatCurrency, formatCurrencyCompact, formatMonth } from '@/app/lib/format'

export function NetBudgetTrajectory({
  labels,
  cumulativeNet,
  currentIndex,
  completedBaseline,
  targetNet,
  monthsRemaining,
  onTrack,
}: {
  labels: string[]
  cumulativeNet: (number | null)[]
  currentIndex: number
  completedBaseline: number
  targetNet: number
  monthsRemaining: number
  onTrack: boolean
}) {
  const width = 640
  const height = 200
  const padX = 40
  const padTop = 16
  const padBottom = 28
  const n = labels.length
  const innerW = width - padX * 2
  const innerH = height - padTop - padBottom
  const lastCompleted = currentIndex - 1

  const slope = monthsRemaining > 0 ? (targetNet - completedBaseline) / monthsRemaining : 0
  const guide: { i: number; v: number }[] = []
  for (let i = Math.max(0, lastCompleted); i <= n - 1; i++) {
    guide.push({ i, v: completedBaseline + (i - lastCompleted) * slope })
  }

  const actual = cumulativeNet
    .map((v, i) => (v === null ? null : { i, v }))
    .filter((p): p is { i: number; v: number } => p !== null)

  const last = actual.at(-1) ?? null
  const prev = actual.at(-2) ?? null
  const currentNet = last?.v ?? 0

  // Sign-aware colour for the actual line + current-net readout:
  // comfortably positive → green, near $0 → yellow, negative → red.
  const band = Math.max(500, Math.abs(targetNet) * 0.1)
  const netColor =
    currentNet >= band ? 'var(--positive)' : currentNet <= -band ? 'var(--negative)' : 'var(--warning)'

  // "At this pace" — extend the most recent actual segment to the $0 line.
  const pace = last && prev ? last.v - prev.v : null
  let zeroLabel: string | null = null
  let zeroI: number | null = null
  if (last && pace !== null && pace > 0 && currentNet < 0) {
    const monthsToZero = -currentNet / pace
    if (monthsToZero <= 600) {
      zeroI = last.i + monthsToZero
      const [ly, lm] = labels[last.i].split('-').map(Number)
      const total = ly * 12 + (lm - 1) + Math.ceil(monthsToZero)
      zeroLabel = formatMonth(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`)
    }
  }

  // Good news = reaching $0 on or before the Dec goal deadline (last label).
  const beatsGoal = zeroI !== null && zeroI <= n - 1
  let paceLabel: string
  let paceColor: string
  if (currentNet >= 0) {
    paceLabel = 'in the black — keep it up'
    paceColor = 'var(--positive)'
  } else if (zeroLabel) {
    paceLabel = `net $0 by ${zeroLabel}`
    paceColor = beatsGoal ? 'var(--positive)' : 'var(--negative)'
  } else {
    paceLabel = 'trim spending to start climbing'
    paceColor = 'var(--negative)'
  }

  const allV = [...actual.map((p) => p.v), ...guide.map((p) => p.v), 0]
  const min = Math.min(...allV)
  const max = Math.max(...allV)
  const span = max - min || 1
  const x = (i: number) => padX + (i / (n - 1)) * innerW
  const y = (v: number) => padTop + innerH - ((v - min) / span) * innerH

  const guideColor = onTrack ? 'var(--positive)' : 'var(--negative)'
  const toPts = (ps: { i: number; v: number }[]) => ps.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')

  // Projection ray from the latest point toward $0, clamped to the chart's right edge.
  const projEndI = zeroI === null ? null : Math.min(zeroI, n - 1)
  const projEndV = last && pace !== null && projEndI !== null ? last.v + (projEndI - last.i) * pace : null

  return (
    <div className="flex flex-col gap-3">
      {last && (
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">Current net</div>
            <div className="text-2xl font-semibold tabular-nums leading-tight" style={{ color: netColor }}>
              {formatCurrency(currentNet)}
            </div>
          </div>
          <div
            className="rounded-lg border px-3 py-1.5 text-right"
            style={{ borderColor: paceColor, color: paceColor }}
          >
            <div className="text-[10px] font-medium uppercase tracking-wide opacity-70">At this pace</div>
            <div className="text-sm font-semibold leading-tight">{paceLabel}</div>
          </div>
        </div>
      )}
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
        <line x1={padX} x2={width - padX} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeWidth={1} />
        <text x={4} y={y(0) + 3} style={{ fontSize: 9 }} className="fill-[var(--muted)]">
          $0
        </text>
        <line
          x1={padX}
          x2={width - padX}
          y1={y(targetNet)}
          y2={y(targetNet)}
          stroke={guideColor}
          strokeWidth={1}
          strokeDasharray="2 3"
          opacity={0.5}
        />
        <polyline
          points={toPts(guide)}
          fill="none"
          stroke={guideColor}
          strokeWidth={2}
          strokeDasharray="5 4"
          strokeLinejoin="round"
        />
        {last && projEndI !== null && projEndV !== null && (
          <line
            x1={x(last.i)}
            y1={y(last.v)}
            x2={x(projEndI)}
            y2={y(projEndV)}
            stroke={netColor}
            strokeWidth={1.5}
            strokeDasharray="2 3"
            opacity={0.7}
          />
        )}
        {zeroI !== null && zeroI <= n - 1 && (
          <circle cx={x(zeroI)} cy={y(0)} r={3} fill="none" stroke={netColor} strokeWidth={1.5} />
        )}
        <polyline points={toPts(actual)} fill="none" stroke={netColor} strokeWidth={2.5} strokeLinejoin="round" />
        {actual.map((p) => (
          <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={2.8} fill={netColor}>
            <title>{`${formatMonth(labels[p.i])}: ${formatCurrencyCompact(p.v)}`}</title>
          </circle>
        ))}
        {labels.map((lab, i) => (
          <text key={lab} x={x(i)} y={height - 8} textAnchor="middle" style={{ fontSize: 9 }} className="fill-[var(--muted)]">
            {formatMonth(lab).replace(' 20', " '")}
          </text>
        ))}
      </svg>
      <div className="flex flex-wrap gap-4 text-xs text-[var(--muted)]">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: netColor }} />
          Actual cumulative net
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: guideColor }} />
          Required path to target
        </span>
      </div>
    </div>
  )
}
