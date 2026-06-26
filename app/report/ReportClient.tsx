'use client'

import { useState } from 'react'
import Link from 'next/link'
import { formatCurrency } from '@/app/lib/format'
import type { CategoryDelta, Grade, MonthReport } from '@/app/lib/monthReport'

const GRADE_BLURB: Record<string, string> = {
  'A+': 'Totally tubular. Flawless month. 🏆',
  A: 'Radical money moves. 🌟',
  'A-': 'So close to perfect. Keep cruising. 🌟',
  'B+': 'Looking fresh — real momentum. 🕺',
  B: 'Solid groove this month. 🕺',
  'B-': 'Steady beat, room to turn it up. 🪩',
  'C+': 'Holding the line. Push for more. 🪩',
  C: 'Middle of the mixtape. 🎧',
  'C-': 'A little static — refocus. 🎧',
  D: 'Rough cut. Next month, rewind & retry. 📼',
  F: 'Tape jammed. Reset and bounce back. 💾',
}

export function ReportClient({ report, months }: { report: MonthReport; months: string[] }) {
  const idx = months.indexOf(report.month)
  const older = idx >= 0 && idx < months.length - 1 ? months[idx + 1] : null
  const newer = idx > 0 ? months[idx - 1] : null

  return (
    <div className="report-80s px-4 py-6 sm:px-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        {/* Header / month nav */}
        <header className="flex items-center justify-between gap-3">
          <Link href="/" className="report-btn px-3 py-1.5 text-xs">← App</Link>
          <div className="flex items-center gap-2">
            <NavArrow href={older} label="◀" title="Older month" />
            <span className="report-chip px-3 py-1 text-xs font-semibold uppercase tracking-wider">
              {report.monthLabel}
            </span>
            <NavArrow href={newer} label="▶" title="Newer month" />
          </div>
        </header>

        {/* Quote of the month (top) */}
        <section className="report-card px-5 py-4 text-center">
          <p className="report-neon-yellow text-sm font-semibold italic">"{report.quote.text}"</p>
        </section>

        {/* Hero: title + grade */}
        <section className="report-card flex flex-col items-center gap-2 px-5 py-7 text-center">
          <div className="text-xs uppercase tracking-[0.35em] text-[var(--ink-dim)]">Monthly Money Recap</div>
          <h1 className="report-title text-2xl sm:text-3xl">★ {report.monthLabel} Results ★</h1>
          <div className="report-grade my-1 text-[5.5rem] sm:text-[7rem]">{report.grade.letter}</div>
          <div className="report-neon-yellow text-sm font-semibold">
            {GRADE_BLURB[report.grade.letter] ?? 'Another month in the books.'}
          </div>
          <div className="text-[11px] text-[var(--ink-dim)]">
            effort score {report.grade.score}/100 · vs {report.prevMonthLabel}{' '}
            <GradeBreakdown grade={report.grade} />
          </div>
        </section>

        {/* Headline tiles */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Moved to goals */}
          <Link href="/goals" className="report-card report-rise block px-4 py-4 transition hover:brightness-110">
            <TileLabel>💸 Moved to goals</TileLabel>
            <div className="report-neon-cyan text-3xl font-extrabold tabular-nums">{formatCurrency(report.movedToGoals)}</div>
            <Delta
              good={report.movedToGoals >= report.movedToGoalsPrev}
              text={`${signed(report.movedToGoals - report.movedToGoalsPrev)} vs ${report.prevMonthLabel} →`}
            />
          </Link>

          {/* Net-0 for the year */}
          <Tile href={`/?month=${report.month}`}>
            <TileLabel>🎯 Saved toward net-0 (year)</TileLabel>
            <div className={`text-3xl font-extrabold tabular-nums ${report.net >= 0 ? 'report-good' : 'report-bad'}`}>
              {report.net >= 0 ? '+' : ''}{formatCurrency(report.net)}
            </div>
            <div className="mt-1 text-xs text-[var(--ink-dim)]">
              Year stands at{' '}
              <span className={report.yearNetPositive ? 'report-good' : 'report-bad'}>{formatCurrency(report.yearNet)}</span>
            </div>
          </Tile>

          {/* Best category */}
          <CategoryTile label="🟢 Biggest win vs last month" delta={report.bestCategory} good prevLabel={report.prevMonthLabel} month={report.month} />
          {/* Worst category */}
          <CategoryTile label="🔴 Watch-out vs last month" delta={report.worstCategory} prevLabel={report.prevMonthLabel} month={report.month} />

          {/* Net-positive streak */}
          <Tile href="/reports">
            <TileLabel>🔥 Net-positive streak</TileLabel>
            <div className="report-neon-cyan text-3xl font-extrabold tabular-nums">{report.netPositiveStreak} mo</div>
            <div className="mt-1 text-xs text-[var(--ink-dim)]">consecutive months in the black</div>
          </Tile>

          {/* Net worth (last) */}
          <Tile href="/accounts/networth">
            <TileLabel>🏦 Net worth</TileLabel>
            <div className="report-neon-cyan text-3xl font-extrabold tabular-nums">
              {formatCurrency(report.netWorth)}
            </div>
            {report.netWorthBreakdown && (
              <div className="mt-1 text-xs text-[var(--ink-dim)]">
                Chequing {formatCurrency(report.netWorthBreakdown.chequing)} + Investments {formatCurrency(report.netWorthBreakdown.investments)} − Mortgage {formatCurrency(report.netWorthBreakdown.mortgage)}
              </div>
            )}
            {report.netWorthDeltaPct && (
              <Delta
                good={report.netWorthDeltaPct.direction !== 'down'}
                text={`${signed(report.netWorth - report.prevNetWorth)} (${report.netWorthDeltaPct.text}) vs ${report.prevMonthLabel}`}
              />
            )}
          </Tile>
        </section>

        {/* Share line */}
        <p className="text-center text-xs text-[var(--ink-dim)]">{report.shareLine}</p>
      </div>
    </div>
  )
}

function NavArrow({ href, label, title }: { href: string | null; label: string; title: string }) {
  if (!href) return <span className="report-btn px-3 py-1 text-sm opacity-35">{label}</span>
  return (
    <Link href={`/report?month=${href}`} title={title} className="report-btn px-3 py-1 text-sm">
      {label}
    </Link>
  )
}

function Tile({ children, href }: { children: React.ReactNode; href?: string }) {
  const cls = 'report-card report-rise px-4 py-4'
  if (href) return <Link href={href} className={`${cls} block transition hover:brightness-110`}>{children}</Link>
  return <div className={cls}>{children}</div>
}

function TileLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-xs font-medium uppercase tracking-wider text-[var(--ink-dim)]">{children}</div>
}

function Delta({ good, text }: { good: boolean; text: string }) {
  return <div className={`mt-1 text-xs font-semibold ${good ? 'report-good' : 'report-bad'}`}>{text}</div>
}

function CategoryTile({
  label,
  delta,
  good,
  prevLabel,
  month,
}: {
  label: string
  delta: CategoryDelta | null
  good?: boolean
  prevLabel: string
  month: string
}) {
  const href = delta ? `/transactions?month=${month}&category=${encodeURIComponent(delta.name)}` : undefined
  return (
    <Tile href={href}>
      <TileLabel>{label}</TileLabel>
      {delta ? (
        <>
          <div className="flex items-baseline gap-2">
            <span className="h-3 w-3 rounded-sm" style={{ background: delta.color, display: 'inline-block' }} />
            <span className="text-xl font-bold">{delta.name}</span>
          </div>
          <div className={`mt-1 text-sm font-semibold tabular-nums ${good ? 'report-good' : 'report-bad'}`}>
            {signed(delta.deltaDollars)}{' '}
            <span className="opacity-80">
              ({delta.isNew ? 'new' : `${delta.deltaPct > 0 ? '+' : ''}${Math.round(delta.deltaPct)}%`})
            </span>
          </div>
          <div className="mt-0.5 text-xs text-[var(--ink-dim)]">
            {formatCurrency(delta.amount)} vs {formatCurrency(delta.prevAmount)} in {prevLabel}
          </div>
        </>
      ) : (
        <div className="text-sm text-[var(--ink-dim)]">No notable change.</div>
      )}
    </Tile>
  )
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="report-card report-rise px-3 py-3 text-center">
      <div className="report-neon-cyan truncate text-lg font-bold">{value}</div>
      {sub && <div className="text-[11px] text-[var(--ink-dim)]">{sub}</div>}
      <div className="mt-1 text-[10px] uppercase tracking-wider text-[var(--ink-dim)]">{label}</div>
    </div>
  )
}

const WEIGHTS = { net: 30, trajectory: 25, goals: 20, discretionary: 15, black: 10 } as const
const SIGNAL_LABELS: Record<keyof typeof WEIGHTS, string> = {
  net: 'Net income MoM',
  trajectory: 'Net-$0 trajectory',
  goals: 'Money moved to goals',
  discretionary: 'Discretionary spend',
  black: 'Month in the black',
}

function GradeBreakdown({ grade }: { grade: Grade }) {
  const [open, setOpen] = useState(false)
  const b = grade.breakdown

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ml-1 text-[var(--neon-cyan,#05d9e8)] underline underline-offset-2 hover:opacity-80"
        style={{ fontSize: 'inherit' }}
      >
        {open ? 'Hide ▲' : 'Why? ▼'}
      </button>
      {open && (
        <div className="mt-3 overflow-hidden rounded-xl border border-[var(--neon-cyan,#05d9e8)] bg-black/50 px-4 py-3 text-left">
          <div className="mb-2 text-[10px] uppercase tracking-widest text-[var(--neon-cyan,#05d9e8)]">Score breakdown</div>
          <table className="w-full text-xs">
            <tbody>
              {(Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).map((key) => {
                const weight = WEIGHTS[key]
                const sub = b[key]
                const pts = Math.round(sub * weight)
                const pct = Math.round(sub * 100)
                const barW = `${pct}%`
                return (
                  <tr key={key}>
                    <td className="py-1 pr-3 text-[var(--ink-dim)] whitespace-nowrap">{SIGNAL_LABELS[key]}</td>
                    <td className="py-1 pr-2 w-full">
                      <div className="h-1.5 rounded-full bg-white/10">
                        <div
                          className="h-1.5 rounded-full"
                          style={{ width: barW, background: pct >= 70 ? 'var(--neon-cyan,#05d9e8)' : pct >= 40 ? 'var(--neon-yellow,#f9f871)' : '#ff2e97' }}
                        />
                      </div>
                    </td>
                    <td className="py-1 pl-2 text-right tabular-nums text-white whitespace-nowrap">{pts}/{weight}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="mt-2 border-t border-white/10 pt-1.5 text-right text-xs font-bold text-white">
            Total: {grade.score}/100
          </div>
        </div>
      )}
    </>
  )
}

/** "+$120" / "−$80" with the sign carried explicitly (for deltas). */
function signed(n: number): string {
  const s = formatCurrency(Math.abs(n))
  return `${n >= 0 ? '+' : '−'}${s}`
}
