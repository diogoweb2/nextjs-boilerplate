'use client'

import { formatCurrency, formatCurrencyCompact, formatMonth, formatShortDate } from '@/app/lib/format'
import type { NetTrajectory } from '@/app/lib/budget'

const POSITIVE = 'var(--positive)'
const NEGATIVE = 'var(--negative)'

/** Whole days between two YYYY-MM-DD dates (b − a). */
function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`).getTime()
  const db = new Date(`${b}T00:00:00`).getTime()
  return Math.round((db - da) / 86_400_000)
}

/**
 * Year-to-date net progression toward the year-end net goal. Plots the running
 * cumulative net (income − spend) day by day across the calendar year. The line
 * is green wherever it sits at or above the goal and red below it (achieved via
 * a vertical gradient that flips at the goal line), so you can see how far the
 * net is from $0 and whether it has crossed into positive territory.
 */
export function NetGoalTrajectory({ data }: { data: NetTrajectory }) {
  const { points, startDate, endDate, currentNet, targetNet, monthlyNet } = data
  const aboveGoal = currentNet >= targetNet
  const headlineColor = aboveGoal ? POSITIVE : NEGATIVE
  const distance = currentNet - targetNet
  const bestMonths = monthlyNet.slice(0, 3)

  const width = 640
  const height = 200
  const padX = 48
  const padTop = 16
  const padBottom = 26
  const innerW = width - padX * 2
  const innerH = height - padTop - padBottom

  // x by real calendar position (Jan 1 → latest activity); y by net value.
  const totalDays = Math.max(1, daysBetween(startDate, endDate))
  const xs = points.map((p) => padX + (daysBetween(startDate, p.date) / totalDays) * innerW)

  const allV = [...points.map((p) => p.net), targetNet, 0]
  const min = Math.min(...allV)
  const max = Math.max(...allV)
  const span = max - min || 1
  const y = (v: number) => padTop + innerH - ((v - min) / span) * innerH
  const linePts = points.map((p, i) => `${xs[i]},${y(p.net)}`).join(' ')

  // Gradient flips green→red exactly at the goal line so the stroke color tracks
  // whether each segment is above (good) or below (bad) the goal.
  const goalY = y(targetNet)
  const cut = Math.min(1, Math.max(0, (goalY - padTop) / innerH))

  // ~5 month ticks across the plotted range.
  const tickCount = 5
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const t = new Date(`${startDate}T00:00:00`).getTime() + (i / tickCount) * totalDays * 86_400_000
    const iso = new Date(t).toISOString().slice(0, 10)
    return { x: padX + (i / tickCount) * innerW, label: formatShortDate(iso) }
  })

  const lastX = xs[xs.length - 1]
  const lastY = y(currentNet)

  // Label the most informative points: always the peak and trough (the extremes
  // you want to read off), then fill in the biggest day-over-day swings. Points
  // too close to one already picked are skipped so labels don't collide.
  const peakIdx = points.reduce((best, p, i) => (p.net > points[best].net ? i : best), 0)
  const troughIdx = points.reduce((best, p, i) => (p.net < points[best].net ? i : best), 0)
  const swings = points
    .map((p, i) => ({ i, delta: i === 0 ? 0 : p.net - points[i - 1].net }))
    .slice(1)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  const labeled: number[] = []
  const tryAdd = (i: number) => {
    if (labeled.length >= 6) return
    if (labeled.some((j) => Math.abs(xs[j] - xs[i]) < 52)) return
    labeled.push(i)
  }
  tryAdd(peakIdx)
  tryAdd(troughIdx)
  for (const s of swings) tryAdd(s.i)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums" style={{ color: headlineColor }}>
              {formatCurrency(currentNet)}
            </span>
            <span className="text-sm font-semibold tabular-nums" style={{ color: headlineColor }}>
              {aboveGoal ? '+' : ''}
              {formatCurrency(distance)} vs goal
            </span>
          </div>
          <div className="text-xs text-[var(--muted)]">
            year-to-date net · goal {formatCurrency(targetNet)} by Dec 31
          </div>
        </div>
        {bestMonths.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-[var(--muted)]">🏆 Best months</span>
            {bestMonths.map((m) => {
              const color = m.net >= 0 ? POSITIVE : NEGATIVE
              return (
                <span
                  key={m.ym}
                  className="rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums"
                  style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
                >
                  {formatMonth(m.ym).replace(/ \d{4}$/, '')} {formatCurrencyCompact(m.net)}
                </span>
              )
            })}
          </div>
        )}
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
        <defs>
          <linearGradient
            id="net-goal-grad"
            x1="0"
            y1={padTop}
            x2="0"
            y2={padTop + innerH}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset={cut} stopColor={POSITIVE} />
            <stop offset={cut} stopColor={NEGATIVE} />
          </linearGradient>
        </defs>

        {/* goal line (= $0 by default) */}
        <line x1={padX} x2={width - padX} y1={goalY} y2={goalY} stroke="var(--border)" strokeWidth={1} />
        <text x={4} y={goalY + 3} style={{ fontSize: 9 }} className="fill-[var(--muted)]">
          {formatCurrencyCompact(targetNet)}
        </text>

        {/* cumulative net, colored by sign vs the goal */}
        <polyline
          points={linePts}
          fill="none"
          stroke="url(#net-goal-grad)"
          strokeWidth={2.5}
          strokeLinejoin="round"
        />
        {/* Amount labels at the biggest swings — drawn in a pill, offset off the
            line so the value stays legible against the colored stroke. */}
        {labeled.map((i) => {
          const p = points[i]
          const py = y(p.net)
          const color = p.net >= targetNet ? POSITIVE : NEGATIVE
          const label = formatCurrencyCompact(p.net)
          const above = py - padTop > 26 // flip below the point when near the top
          const cx = xs[i]
          const baseline = above ? py - 14 : py + 22
          const boxW = label.length * 5.6 + 10
          const boxH = 14
          return (
            <g key={i}>
              <circle cx={cx} cy={py} r={2.6} fill={color} />
              <rect
                x={cx - boxW / 2}
                y={baseline - 10}
                width={boxW}
                height={boxH}
                rx={4}
                fill="var(--surface)"
                stroke={color}
                strokeWidth={1}
                opacity={0.95}
              />
              <text
                x={cx}
                y={baseline}
                textAnchor="middle"
                style={{ fontSize: 9, fontWeight: 600 }}
                fill={color}
              >
                {label}
              </text>
            </g>
          )
        })}

        {points.length > 0 && (
          <circle cx={lastX} cy={lastY} r={3.2} fill={headlineColor}>
            <title>{`${formatShortDate(endDate)}: ${formatCurrencyCompact(currentNet)} net`}</title>
          </circle>
        )}

        {ticks.map((t, i) => (
          <text
            key={i}
            x={t.x}
            y={height - 8}
            textAnchor="middle"
            style={{ fontSize: 9 }}
            className="fill-[var(--muted)]"
          >
            {t.label}
          </text>
        ))}
      </svg>

      <div className="flex flex-wrap gap-4 text-xs text-[var(--muted)]">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: POSITIVE }} />
          At or above goal
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: NEGATIVE }} />
          Below goal
        </span>
      </div>
    </div>
  )
}
