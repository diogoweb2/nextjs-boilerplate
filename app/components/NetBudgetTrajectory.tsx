'use client'

import { formatCurrencyCompact, formatMonth } from '@/app/lib/format'

const ACTUAL_COLOR = '#0ea5e9'

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

  const allV = [...actual.map((p) => p.v), ...guide.map((p) => p.v), 0]
  const min = Math.min(...allV)
  const max = Math.max(...allV)
  const span = max - min || 1
  const x = (i: number) => padX + (i / (n - 1)) * innerW
  const y = (v: number) => padTop + innerH - ((v - min) / span) * innerH

  const guideColor = onTrack ? 'var(--positive)' : 'var(--negative)'
  const toPts = (ps: { i: number; v: number }[]) => ps.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')

  return (
    <div className="flex flex-col gap-2">
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
        <polyline points={toPts(actual)} fill="none" stroke={ACTUAL_COLOR} strokeWidth={2.5} strokeLinejoin="round" />
        {actual.map((p) => (
          <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={2.8} fill={ACTUAL_COLOR}>
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
          <span className="h-2 w-3 rounded-sm" style={{ background: ACTUAL_COLOR }} />
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
