'use client'

import { useEffect, useState } from 'react'
import { formatCurrency, formatCurrencyCompact, formatMonth, formatShortDate } from '@/app/lib/format'
import { pacePercent, type BurndownData, type PaceLevel } from '@/app/lib/projection'
import type { DigestCharge } from '@/app/lib/digest'
import { UnavoidableModal } from './UnavoidableModal'

const PACE_COLOR = 'var(--muted)'
// The remaining line is coloured per-segment by where it sits vs the pace line:
// at/above pace → green, below → red (the "Cutting it close" badge stays yellow).
const LINE_GREEN = 'var(--positive)'
const LINE_RED = 'var(--negative)'

/** Color + badge copy for each of the three pace levels. */
const LEVEL: Record<PaceLevel, { color: string; label: string }> = {
  great: { color: 'var(--positive)', label: 'On pace ✓' },
  close: { color: 'var(--warning)', label: 'Cutting it close ⚠' },
  below: { color: 'var(--negative)', label: 'Behind pace ✗' },
}

/**
 * "Discretionary burn-down": money left to spend this period after unavoidable
 * bills, burning toward $0, vs a straight pace line. The remaining line is green
 * when it sits above the pace (spending slower than budget), red when below.
 * Day-by-day for a single/current month, month-by-month for longer periods.
 */
export function BurndownTrajectory({
  data,
  periodLabel,
  newCharges = [],
  unavoidableTotal,
}: {
  data: BurndownData
  periodLabel: string
  newCharges?: DigestCharge[]
  /** This month's unavoidable spend (kept out of the curve) — for the link label. */
  unavoidableTotal?: number | null
}) {
  const { labels, pace, remaining, asOfIndex, budget, spentToDate, granularity } = data
  const [showCharges, setShowCharges] = useState(false)
  const [showUnavoidable, setShowUnavoidable] = useState(false)
  const newTotal = newCharges.reduce((s, c) => s + c.amount, 0)
  const remainingNow = remaining[asOfIndex] ?? budget
  const { pct, level } = pacePercent(data)
  const lineColor = LEVEL[level].color
  const pctLabel = `${pct >= 0 ? '+' : ''}${pct}%`

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

  // Split the remaining line into green (at/above pace) and red (below) segments,
  // breaking exactly where it crosses the even-pace line.
  const diffAt = (i: number, v: number) => v - (pace[i] ?? 0)
  const remSegs: { x1: number; y1: number; x2: number; y2: number; color: string }[] = []
  for (let k = 0; k < remPts.length - 1; k++) {
    const a = remPts[k]
    const b = remPts[k + 1]
    const da = diffAt(a.i, a.v)
    const db = diffAt(b.i, b.v)
    const ax = x(a.i)
    const ay = y(a.v)
    const bx = x(b.i)
    const by = y(b.v)
    if ((da >= 0) === (db >= 0)) {
      remSegs.push({ x1: ax, y1: ay, x2: bx, y2: by, color: da >= 0 ? LINE_GREEN : LINE_RED })
    } else {
      const t = da / (da - db) // fraction along the segment where it hits the pace line
      const cx = ax + (bx - ax) * t
      const cy = ay + (by - ay) * t
      remSegs.push({ x1: ax, y1: ay, x2: cx, y2: cy, color: da >= 0 ? LINE_GREEN : LINE_RED })
      remSegs.push({ x1: cx, y1: cy, x2: bx, y2: by, color: db >= 0 ? LINE_GREEN : LINE_RED })
    }
  }
  const dotColor = diffAt(asOfIndex, remainingNow) >= 0 ? LINE_GREEN : LINE_RED

  const pacePts = pace.map((v, i) => ({ i, v: v ?? 0 }))
  // Tick labels: thin out to ~5 marks so day axes don't crowd.
  const tickEvery = Math.max(1, Math.ceil(n / 6))
  const labelOf = (lab: string) => (granularity === 'month' ? formatMonth(lab).replace(' 20', " '") : lab)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums">{formatCurrency(remainingNow)}</span>
            <span className="text-base font-semibold tabular-nums" style={{ color: lineColor }}>
              {pctLabel}
            </span>
          </div>
          <div className="text-xs text-[var(--muted)]">
            left of {formatCurrency(budget)} discretionary · {periodLabel}
          </div>
          {newCharges.length > 0 && (
            <button
              type="button"
              onClick={() => setShowCharges(true)}
              className="mt-0.5 text-xs text-[var(--muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)]"
            >
              {formatCurrency(newTotal)} new since last report
              <span className="opacity-70">
                {' '}· {newCharges.length} {newCharges.length === 1 ? 'charge' : 'charges'}
              </span>
            </button>
          )}
        </div>
        <span
          className="rounded-full px-2.5 py-1 text-xs font-semibold"
          style={{
            color: lineColor,
            background: `color-mix(in srgb, ${lineColor} 12%, transparent)`,
          }}
        >
          {LEVEL[level].label} · spent {formatCurrencyCompact(spentToDate)}
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

        {/* remaining (actual) line — green above pace, red below */}
        {remSegs.map((s, i) => (
          <line
            key={i}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke={s.color}
            strokeWidth={2.5}
            strokeLinecap="round"
          />
        ))}
        {remPts.length > 0 && (
          <circle cx={x(asOfIndex)} cy={y(remainingNow)} r={3.2} fill={dotColor}>
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

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: lineColor }} />
          Money left to spend
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: PACE_COLOR }} />
          Even pace to $0
        </span>
        <button
          type="button"
          onClick={() => setShowUnavoidable(true)}
          className="ml-auto underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)]"
        >
          {unavoidableTotal != null ? `${formatCurrency(unavoidableTotal)} unavoidable excluded` : 'Unavoidable spend'} →
        </button>
      </div>

      {showCharges && (
        <NewChargesModal charges={newCharges} total={newTotal} onClose={() => setShowCharges(false)} />
      )}
      {showUnavoidable && <UnavoidableModal onClose={() => setShowUnavoidable(false)} />}
    </div>
  )
}

/** Lightweight modal listing the "new since last report" charges, largest first. */
function NewChargesModal({
  charges,
  total,
  onClose,
}: {
  charges: DigestCharge[]
  total: number
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New charges since last report"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-sm flex-col rounded-xl border border-[var(--border)] text-[var(--foreground)] shadow-xl"
        style={{ background: 'var(--surface)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div>
            <div className="text-sm font-semibold">New since last report</div>
            <div className="text-xs text-[var(--muted)]">
              {formatCurrency(total)} · {charges.length} {charges.length === 1 ? 'charge' : 'charges'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-lg leading-none text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <ul className="divide-y divide-[var(--border)] overflow-y-auto px-4">
          {charges.map((c, i) => (
            <li key={`${c.merchant}-${c.date}-${i}`} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate">{c.merchant}</div>
                <div className="text-xs text-[var(--muted)]">{formatShortDate(c.date)}</div>
              </div>
              <span className="tabular-nums font-medium">{formatCurrency(c.amount)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
