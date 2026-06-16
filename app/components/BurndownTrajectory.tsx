'use client'

import { formatCurrency, formatCurrencyCompact, formatMonth } from '@/app/lib/format'
import type { BurndownData } from '@/app/lib/projection'

const PACE_COLOR = 'var(--muted)'

/**
 * "Discretionary burn-down": money left to spend this period after unavoidable
 * bills, burning toward $0, vs a straight pace line. The remaining line is green
 * when it sits above the pace (spending slower than budget), red when below.
 * Day-by-day for a single/current month, month-by-month for longer periods.
 */
export function BurndownTrajectory({ data, periodLabel }: { data: BurndownData; periodLabel: string }) {
  const { labels, pace, remaining, asOfIndex, budget, spentToDate, onPace, granularity } = data
  const remainingNow = remaining[asOfIndex] ?? budget
  const goodColor = 'var(--positive)'
  const badColor = 'var(--negative)'
  const lineColor = onPace ? goodColor : badColor

  const width = 640
  const height = 200
  const padX = 44
  const padTop = 16
  const padBottom = 26
  const n = labels.length
  const innerW = width - padX * 2
  const innerH = height - padTop - padBottom

  const remPts = remaining
    .map((v, i) => (v === null ? null : { i, v }))
    .filter((p): p is { i: number; v: number } => p !== null)
  const allV = [budget, 0, ...pace.filter((v): v is number => v !== null), ...remPts.map((p) => p.v)]
  const min = Math.min(...allV)
  const max = Math.max(...allV)
  const span = max - min || 1
  const x = (i: number) => padX + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const y = (v: number) => padTop + innerH - ((v - min) / span) * innerH
  const toPts = (ps: { i: number; v: number }[]) => ps.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')

  const pacePts = pace.map((v, i) => ({ i, v: v ?? 0 }))
  // Tick labels: thin out to ~5 marks so day axes don't crowd.
  const tickEvery = Math.max(1, Math.ceil(n / 6))
  const labelOf = (lab: string) => (granularity === 'month' ? formatMonth(lab).replace(' 20', " '") : lab)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-2xl font-bold tabular-nums">{formatCurrency(remainingNow)}</div>
          <div className="text-xs text-[var(--muted)]">
            left of {formatCurrency(budget)} discretionary · {periodLabel}
          </div>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
            onPace
              ? 'bg-[color-mix(in_srgb,var(--positive)_12%,transparent)] text-[var(--positive)]'
              : 'bg-[color-mix(in_srgb,var(--negative)_12%,transparent)] text-[var(--negative)]'
          }`}
        >
          {onPace ? 'On pace ✓' : 'Behind pace ✗'} · spent {formatCurrencyCompact(spentToDate)}
        </span>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
        {/* $0 floor */}
        <line x1={padX} x2={width - padX} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeWidth={1} />
        <text x={4} y={y(0) + 3} style={{ fontSize: 9 }} className="fill-[var(--muted)]">
          $0
        </text>

        {/* pace / goal line */}
        <polyline
          points={toPts(pacePts)}
          fill="none"
          stroke={PACE_COLOR}
          strokeWidth={1.5}
          strokeDasharray="5 4"
          strokeLinejoin="round"
          opacity={0.7}
        />

        {/* remaining (actual) line */}
        <polyline points={toPts(remPts)} fill="none" stroke={lineColor} strokeWidth={2.5} strokeLinejoin="round" />
        {remPts.length > 0 && (
          <circle cx={x(asOfIndex)} cy={y(remainingNow)} r={3.2} fill={lineColor}>
            <title>{`${labelOf(labels[asOfIndex])}: ${formatCurrencyCompact(remainingNow)} left`}</title>
          </circle>
        )}

        {labels.map((lab, i) =>
          i % tickEvery === 0 || i === n - 1 ? (
            <text
              key={i}
              x={x(i)}
              y={height - 8}
              textAnchor="middle"
              style={{ fontSize: 9 }}
              className="fill-[var(--muted)]"
            >
              {labelOf(lab)}
            </text>
          ) : null
        )}
      </svg>

      <div className="flex flex-wrap gap-4 text-xs text-[var(--muted)]">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: lineColor }} />
          Money left to spend
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: PACE_COLOR }} />
          Even pace to $0
        </span>
      </div>
    </div>
  )
}
