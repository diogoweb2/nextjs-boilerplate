'use client'

/**
 * "Where am I this month?" — replaces the old day-by-day burn-down line chart.
 * Three glanceable panels over the same `BurndownData`, deliberately with **no
 * history**: where you stood ten days ago is noise, the only question is whether
 * this month is on track. Each panel answers it a different way so whoever's
 * reading finds one that clicks:
 *
 *   · Speedometer — how fast are we burning vs. what the month allows
 *   · Runway      — how far the money reaches, as a date
 *   · Sentence    — the same thing in plain English, no geometry
 *
 * Status colour is never alone: every panel carries the ✓/⚠/✗ glyph + label.
 */

import { useEffect, useRef, useState } from 'react'
import { formatCurrency, formatShortDate } from '@/app/lib/format'
import { pacePercent, type BurndownData, type PaceLevel } from '@/app/lib/projection'
import type { DigestCharge } from '@/app/lib/digest'
import { UnavoidableModal } from './UnavoidableModal'

const LEVEL: Record<PaceLevel, { color: string; label: string; glyph: string }> = {
  great: { color: 'var(--positive)', label: 'On pace', glyph: '✓' },
  close: { color: 'var(--warning)', label: 'Cutting it close', glyph: '⚠' },
  below: { color: 'var(--negative)', label: 'Behind pace', glyph: '✗' },
}

/** The handful of numbers every panel needs, derived once from BurndownData. */
type Pace = {
  budget: number
  remaining: number
  spent: number
  /** 0–1 through the month (calendar), and 0–1 of the budget already spent. */
  timeFrac: number
  spentFrac: number
  daysLeft: number
  perDay: number
  level: PaceLevel
  pct: number
}

function derive(data: BurndownData): Pace {
  const { budget, spentToDate, asOfIndex, labels } = data
  const remaining = data.remaining[asOfIndex] ?? budget
  const total = labels.length
  const elapsed = asOfIndex + 1
  const daysLeft = Math.max(0, total - elapsed)
  const { pct, level } = pacePercent(data)
  return {
    budget,
    remaining,
    spent: spentToDate,
    timeFrac: total > 0 ? elapsed / total : 0,
    spentFrac: budget > 0 ? Math.min(1.5, spentToDate / budget) : 0,
    daysLeft,
    // What's left, spread over the days still to come (never divide by zero on
    // the last day of the month).
    perDay: remaining / Math.max(1, daysLeft),
    level,
    pct,
  }
}

/** Animate toward `to` — 0 → value on mount, and glide from wherever it sits if
 *  the target moves. Respects reduced-motion. */
function useGrow(to: number, ms = 900): number {
  const [v, setV] = useState(0)
  const raf = useRef(0)
  // Mirrors `v` without reading state in the effect, so a re-target picks up
  // mid-flight rather than snapping back to zero.
  const current = useRef(0)
  useEffect(() => {
    const from = current.current
    if (from === to) return
    const full = from === 0 ? ms : 260
    const dur = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : full
    const start = performance.now()
    const tick = (now: number) => {
      const t = dur === 0 ? 1 : Math.min(1, (now - start) / dur)
      // easeOutCubic — quick out of the gate, settles softly.
      const next = from + (to - from) * (1 - Math.pow(1 - t, 3))
      current.current = next
      setV(next)
      if (t < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [to, ms])
  return v
}

function StatusChip({ level }: { level: PaceLevel }) {
  const l = LEVEL[level]
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ color: l.color, background: `color-mix(in srgb, ${l.color} 12%, transparent)` }}
    >
      <span aria-hidden>{l.glyph}</span>
      {l.label}
    </span>
  )
}

// ------------------------------------------------------------------ panel 1

/**
 * Speedometer. Needle centred = spending exactly at the pace the month allows;
 * left = slower (good), right = faster. The scale is burn rate vs even pace, so
 * hard right means "spending twice as fast as the month affords".
 */
export function PaceDial({ data }: { data: BurndownData }) {
  const p = derive(data)
  const rate = p.timeFrac > 0 ? p.spentFrac / p.timeFrac : 0
  const clamped = Math.max(0, Math.min(2, rate))
  const angle = useGrow(-90 + (clamped / 2) * 180)
  const color = LEVEL[p.level].color

  const cx = 100
  const cy = 92
  const r = 74
  const arc = (from: number, to: number) => {
    const pt = (deg: number) => {
      const rad = ((deg - 90) * Math.PI) / 180
      return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
    }
    const [x1, y1] = pt(from)
    const [x2, y2] = pt(to)
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="text-xs text-[var(--muted)]">Spending speed</div>
      <svg viewBox="0 0 200 108" className="w-full" style={{ maxHeight: 128 }} role="img" aria-label="Spending speed">
        <path d={arc(-90, 0)} fill="none" stroke="var(--positive)" strokeWidth={10} strokeLinecap="round" opacity={0.35} />
        <path d={arc(0, 90)} fill="none" stroke="var(--negative)" strokeWidth={10} strokeLinecap="round" opacity={0.35} />
        {/* the "exactly on budget" mark */}
        <line x1={cx} y1={cy - r - 8} x2={cx} y2={cy - r + 8} stroke="var(--foreground)" strokeWidth={2} opacity={0.6} />
        <g transform={`rotate(${angle} ${cx} ${cy})`}>
          <line x1={cx} y1={cy} x2={cx} y2={cy - r + 6} stroke={color} strokeWidth={3} strokeLinecap="round" />
        </g>
        <circle cx={cx} cy={cy} r={5} fill={color} />
        <text x={16} y={cy + 14} style={{ fontSize: 9 }} className="fill-[var(--muted)]">
          slower
        </text>
        <text x={158} y={cy + 14} style={{ fontSize: 9 }} className="fill-[var(--muted)]">
          faster
        </text>
      </svg>

      <div className="mt-auto flex flex-col gap-1">
        <StatusChip level={p.level} />
        <div className="text-xs text-[var(--muted)]">
          <span className="font-semibold text-[var(--foreground)] tabular-nums">{formatCurrency(p.remaining)}</span> left
          · {p.daysLeft === 0 ? 'last day' : `${p.daysLeft} ${p.daysLeft === 1 ? 'day' : 'days'} to go`}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ panel 2

/**
 * Runway. "At the rate you're going, this month's money lasts until <date>."
 * The bar is the month; the fill is how far the money reaches. No pace jargon —
 * it straight-lines the actual $/day so far.
 */
export function PaceRunway({ data, monthIso }: { data: BurndownData; monthIso: string }) {
  const p = derive(data)
  const totalDays = data.labels.length
  const elapsed = data.asOfIndex + 1
  const rate = elapsed > 0 ? p.spent / elapsed : 0
  const runsOutOn = rate > 0 ? elapsed + p.remaining / rate : totalDays
  const lasts = runsOutOn >= totalDays
  const reach = useGrow(Math.min(1, runsOutOn / totalDays))
  const color = LEVEL[p.level].color
  const day = String(Math.min(totalDays, Math.max(1, Math.round(runsOutOn)))).padStart(2, '0')

  return (
    <div className="flex h-full flex-col gap-3">
      <div>
        <div className="text-xs text-[var(--muted)]">At this rate, your money lasts</div>
        <div className="text-3xl font-bold" style={{ color }}>
          {lasts ? 'all month' : `to ${formatShortDate(`${monthIso}-${day}`)}`}
        </div>
        <div className="text-xs text-[var(--muted)]">
          {lasts ? `${formatCurrency(p.remaining)} to spare` : `${totalDays - Math.round(runsOutOn)} days short`}
        </div>
      </div>

      <div className="relative mt-2">
        <div className="h-3 w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
          <div className="h-full rounded-full" style={{ width: `${reach * 100}%`, background: color }} />
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] text-[var(--muted)]">
          <span>day 1</span>
          <span>end of month</span>
        </div>
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2 text-xs text-[var(--muted)]">
        <span>
          <span className="font-semibold text-[var(--foreground)] tabular-nums">{formatCurrency(rate)}</span> / day so
          far
        </span>
        <StatusChip level={p.level} />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ panel 3

/** The sentence. No geometry at all — a face and one plain-English line. */
export function PaceSentence({ data }: { data: BurndownData }) {
  const p = derive(data)
  const color = LEVEL[p.level].color
  const face = p.level === 'great' ? '😌' : p.level === 'close' ? '😬' : '😰'
  const verdict = p.level === 'great' ? "We're good." : p.level === 'close' ? "It's tight." : "We're overspending."
  const scale = useGrow(1, 500)

  return (
    <div className="flex h-full flex-col justify-center gap-3 text-center">
      <div
        className="text-5xl leading-none"
        style={{ transform: `scale(${0.6 + scale * 0.4})`, transformOrigin: 'center' }}
        aria-hidden
      >
        {face}
      </div>
      <div className="text-xl font-bold" style={{ color }}>
        {verdict}
      </div>
      <p className="text-sm text-[var(--foreground)]">
        We can spend{' '}
        <span className="font-bold tabular-nums" style={{ color }}>
          {formatCurrency(p.perDay)}
        </span>{' '}
        {/* On the last day of the month there is no "next N days" to spread it
            over — the whole remainder is today's. */}
        {p.daysLeft === 0 ? (
          <span className="font-bold">today</span>
        ) : (
          <>
            a day for the next{' '}
            <span className="font-bold tabular-nums">
              {p.daysLeft} {p.daysLeft === 1 ? 'day' : 'days'}
            </span>
          </>
        )}
        .
      </p>
      <div className="text-xs text-[var(--muted)]">
        {formatCurrency(p.remaining)} left of {formatCurrency(p.budget)}
      </div>
    </div>
  )
}

// -------------------------------------------------------------------- card

/**
 * The three panels plus the footer the old line chart used to own: the "new
 * since last report" charge list and the unavoidable-spend breakdown.
 */
export function PaceSummary({
  data,
  monthIso,
  periodLabel,
  newCharges = [],
  unavoidableTotal,
}: {
  data: BurndownData
  /** YYYY-MM of the month being shown — dates the runway panel. */
  monthIso: string
  periodLabel: string
  newCharges?: DigestCharge[]
  /** This month's unavoidable spend (kept out of the figures) — for the link. */
  unavoidableTotal?: number | null
}) {
  const [showCharges, setShowCharges] = useState(false)
  const [showUnavoidable, setShowUnavoidable] = useState(false)
  const newTotal = newCharges.reduce((s, c) => s + c.amount, 0)
  const cell = 'flex flex-col rounded-lg border border-[var(--border)] p-4'

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-[var(--muted)]">
        {periodLabel} · discretionary only
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className={cell}>
          <PaceDial data={data} />
        </div>
        <div className={cell}>
          <PaceRunway data={data} monthIso={monthIso} />
        </div>
        <div className={cell}>
          <PaceSentence data={data} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
        {newCharges.length > 0 && (
          <button
            type="button"
            onClick={() => setShowCharges(true)}
            className="underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)]"
          >
            {formatCurrency(newTotal)} new since last report
            <span className="opacity-70">
              {' '}· {newCharges.length} {newCharges.length === 1 ? 'charge' : 'charges'}
            </span>
          </button>
        )}
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
