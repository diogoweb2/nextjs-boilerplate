'use client'

import { formatCurrency, formatCurrencyCompact, formatMonth } from '@/app/lib/format'

// The cumulative net line is colored per-segment:
// positive (≥ $0) → green, negative (< $0) → red.
const LINE_GREEN = 'var(--positive)'
const LINE_RED = 'var(--negative)'

export function NetBudgetTrajectory({
  labels,
  cumulativeNet,
  currentIndex,
  completedBaseline,
  targetNet,
  monthsRemaining,
  onTrack,
  asOfDay,
  daysInMonth,
}: {
  labels: string[]
  cumulativeNet: (number | null)[]
  currentIndex: number
  completedBaseline: number
  targetNet: number
  monthsRemaining: number
  onTrack: boolean
  /** Day of the anchor month we're standing on, and its length — used to caption
      the in-progress point ("day 5 of 31"), which is otherwise misread as a bad month. */
  asOfDay?: number
  daysInMonth?: number
}) {
  const width = 640
  const height = 200
  const padX = 40
  const padTop = 28
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
  const currentNet = last?.v ?? 0

  // Pace is measured over COMPLETED months only. The anchor month is still
  // filling in — early in it income has posted but most spending hasn't, so any
  // delta that includes it projects a steep climb that collapses by month end.
  // Averaging the last 3 completed months also stops one odd month (a big bill,
  // a 3-paycheque month) from swinging the forecast by years.
  const completed = actual.filter((p) => p.i <= lastCompleted)
  const anchorPt = completed.at(-1) ?? null
  const deltas: number[] = []
  for (let k = completed.length - 1; k > 0 && deltas.length < 3; k--) {
    deltas.push(completed[k].v - completed[k - 1].v)
  }
  const pace = deltas.length ? deltas.reduce((s, d) => s + d, 0) / deltas.length : null
  const paceMonths = deltas.length

  // The in-progress month, and what it has contributed so far. The cumulative
  // line makes a part-month look like a whole one: on day 5 the spending has
  // posted and the paycheques haven't, so the dot dips below the closed month
  // behind it even in a month that ends up saving money.
  const partial = last && last.i > lastCompleted ? last : null
  const partialNet = partial && anchorPt ? partial.v - anchorPt.v : null

  // Sign-aware colour for the actual line + current-net readout:
  // comfortably positive → green, near $0 → yellow, negative → red.
  const band = Math.max(500, Math.abs(targetNet) * 0.1)
  const netColor =
    currentNet >= band ? 'var(--positive)' : currentNet <= -band ? 'var(--negative)' : 'var(--warning)'

  // "At this pace" — extend the averaged pace from the last completed month to $0.
  let zeroLabel: string | null = null
  let zeroI: number | null = null
  if (anchorPt && pace !== null && pace > 0 && anchorPt.v < 0) {
    const monthsToZero = -anchorPt.v / pace
    if (monthsToZero <= 600) {
      zeroI = anchorPt.i + monthsToZero
      const [ly, lm] = labels[anchorPt.i].split('-').map(Number)
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
  } else if (pace === null) {
    paceLabel = 'too early to project'
    paceColor = 'var(--muted)'
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
  const projEndV =
    anchorPt && pace !== null && projEndI !== null ? anchorPt.v + (projEndI - anchorPt.i) * pace : null

  // Split the actual line into green (positive) and red (negative) segments,
  // breaking exactly where it crosses $0.
  const actualSegs: { x1: number; y1: number; x2: number; y2: number; color: string; open?: boolean }[] = []
  for (let k = 0; k < actual.length - 1; k++) {
    const a = actual[k]
    const b = actual[k + 1]
    const ax = x(a.i)
    const ay = y(a.v)
    const bx = x(b.i)
    const by = y(b.v)
    const open = b.i > lastCompleted // segment running into the unfinished month
    if ((a.v >= 0) === (b.v >= 0)) {
      actualSegs.push({ x1: ax, y1: ay, x2: bx, y2: by, color: a.v >= 0 ? LINE_GREEN : LINE_RED, open })
    } else {
      const t = a.v / (a.v - b.v) // fraction along segment where it hits $0
      const cx = ax + (bx - ax) * t
      const cy = ay + (by - ay) * t
      actualSegs.push({ x1: ax, y1: ay, x2: cx, y2: cy, color: a.v >= 0 ? LINE_GREEN : LINE_RED, open })
      actualSegs.push({ x1: cx, y1: cy, x2: bx, y2: by, color: b.v >= 0 ? LINE_GREEN : LINE_RED, open })
    }
  }
  const dotColor = currentNet >= 0 ? LINE_GREEN : LINE_RED

  return (
    <div className="flex flex-col gap-3">
      {last && (
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
              Current net{last.i > lastCompleted ? ' (month in progress)' : ''}
            </div>
            <div className="text-2xl font-semibold tabular-nums leading-tight" style={{ color: netColor }}>
              {formatCurrency(currentNet)}
            </div>
            {partial && partialNet !== null && (
              <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                {formatMonth(labels[partial.i])} so far{' '}
                <span className="tabular-nums">{formatCurrency(partialNet)}</span>
                {asOfDay && daysInMonth ? ` · day ${asOfDay} of ${daysInMonth}` : ''}
              </div>
            )}
          </div>
          <div
            className="rounded-lg border px-3 py-1.5 text-right"
            style={{ borderColor: paceColor, color: paceColor }}
          >
            <div className="text-[10px] font-medium uppercase tracking-wide opacity-70">
              At this pace{paceMonths > 0 ? ` (${paceMonths}-mo avg)` : ''}
            </div>
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
        {anchorPt && projEndI !== null && projEndV !== null && (
          <line
            x1={x(anchorPt.i)}
            y1={y(anchorPt.v)}
            x2={x(projEndI)}
            y2={y(projEndV)}
            stroke={netColor}
            strokeWidth={1.5}
            strokeDasharray="2 3"
            opacity={0.7}
          />
        )}
        {zeroI !== null && zeroI <= n - 1 && (
          <circle cx={x(zeroI)} cy={y(0)} r={3} fill="none" stroke={dotColor} strokeWidth={1.5} />
        )}
        {/* actual cumulative net line — green (positive), red (negative) */}
        {actualSegs.map((s, i) => (
          <line
            key={i}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke={s.color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={s.open ? '4 4' : undefined}
            opacity={s.open ? 0.55 : 1}
          />
        ))}
        {actual.map((p) => {
          const cx = x(p.i)
          const cy = y(p.v)
          const color = p.v >= 0 ? LINE_GREEN : LINE_RED
          const open = p.i > lastCompleted
          const label = open ? `${formatCurrencyCompact(p.v)} so far` : formatCurrencyCompact(p.v)
          const above = cy - padTop > 26
          const labelY = above ? cy - 14 : cy + 22
          const boxW = label.length * 5.6 + 10
          const boxH = 14
          return (
            <g key={p.i}>
              <circle
                cx={cx}
                cy={cy}
                r={2.8}
                fill={open ? 'var(--surface)' : color}
                stroke={open ? color : undefined}
                strokeWidth={open ? 1.5 : undefined}
              />
              <rect
                x={cx - boxW / 2}
                y={labelY - 10}
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
                y={labelY}
                textAnchor="middle"
                style={{ fontSize: 9, fontWeight: 600 }}
                fill={color}
              >
                {label}
              </text>
            </g>
          )
        })}
        {labels.map((lab, i) => (
          <text key={lab} x={x(i)} y={height - 8} textAnchor="middle" style={{ fontSize: 9 }} className="fill-[var(--muted)]">
            {formatMonth(lab).replace(' 20', " '")}
          </text>
        ))}
      </svg>
      <div className="flex flex-wrap gap-4 text-xs text-[var(--muted)]">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: dotColor }} />
          Actual cumulative net
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: guideColor }} />
          Required path to target
        </span>
        {partial && (
          <span className="flex items-center gap-1.5">
            <span
              className="h-2 w-3 rounded-sm border"
              style={{ borderColor: dotColor, background: 'transparent' }}
            />
            {formatMonth(labels[partial.i])} still open — income may not have posted yet
          </span>
        )}
      </div>
    </div>
  )
}
