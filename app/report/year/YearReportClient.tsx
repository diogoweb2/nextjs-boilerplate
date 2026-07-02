'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { formatCurrency, formatShortDate } from '@/app/lib/format'
import { YEAR_REPORT_SEEN_KEY } from '@/app/lib/reportSchedule'
import type { CategoryDelta } from '@/app/lib/monthReport'
import type { YearGrade, YearReport } from '@/app/lib/yearReport'

/** Mirrors YEAR_WEIGHTS in app/lib/yearReport.ts (a server module this client can't import). */
const YEAR_WEIGHTS = { black: 25, yoy: 25, goals: 20, discretionary: 15, consistency: 15 } as const

const GRADE_BLURB: Record<string, string> = {
  'A+': 'A platinum-record year. Frame this one. 🏆',
  A: 'Chart-topping money moves all year. 🌟',
  'A-': 'A near-perfect album — one skippable track. 🌟',
  'B+': 'Strong year, real momentum into the next. 🕺',
  B: 'A solid groove, twelve months long. 🕺',
  'B-': 'Steady year — turn the volume up next lap. 🪩',
  'C+': 'Held the line through all four seasons. 🪩',
  C: 'A mixtape year: some hits, some filler. 🎧',
  'C-': 'Static in the signal — retune for the new year. 🎧',
  D: 'A rough LP. New year, new recording. 📼',
  F: 'The tape unspooled. Rewind and go again. 💾',
}

export function YearReportClient({ report, years }: { report: YearReport; years: string[] }) {
  const idx = years.indexOf(report.year)
  const older = idx >= 0 && idx < years.length - 1 ? years[idx + 1] : null
  const newer = idx > 0 ? years[idx - 1] : null

  // Viewing the review clears the dashboard reminder for this year (the "or sees
  // it" path — same device-local contract as the monthly ReportReminder).
  useEffect(() => {
    localStorage.setItem(YEAR_REPORT_SEEN_KEY, report.year)
  }, [report.year])

  const nwDelta =
    report.netWorthEnd !== null && report.netWorthStart !== null
      ? report.netWorthEnd - report.netWorthStart
      : null
  const maxAbsNet = Math.max(1, ...report.monthlyNets.map((m) => Math.abs(m.net)))
  const maxMerchant = Math.max(1, ...report.topMerchants.map((m) => m.amount))

  return (
    <div className="report-90s px-4 py-6 sm:px-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        {/* Header / year nav */}
        <header className="flex items-center justify-between gap-3">
          <Link href="/" className="report-btn px-3 py-1.5 text-xs">← App</Link>
          <div className="flex items-center gap-2">
            <NavArrow year={older} label="◀" title="Older year" />
            <span className="report-chip px-3 py-1 text-xs font-semibold uppercase tracking-wider">
              {report.year}{report.inProgress ? ' · YTD' : ''}
            </span>
            <NavArrow year={newer} label="▶" title="Newer year" />
          </div>
        </header>

        {/* Quote of the year */}
        <section className="report-card px-5 py-4 text-center">
          <p className="report-neon-yellow text-sm font-semibold italic">&ldquo;{report.quote.text}&rdquo;</p>
        </section>

        {/* Hero: title + grade */}
        <section className="report-card flex flex-col items-center gap-2 px-5 py-7 text-center">
          <div className="text-xs uppercase tracking-[0.35em] text-[var(--ink-dim)]">Year in Review</div>
          <h1 className="report-title text-2xl sm:text-3xl">★ {report.year} Rewind ★</h1>
          <div className="report-grade my-1 text-[5.5rem] sm:text-[7rem]">{report.grade.letter}</div>
          <div className="report-neon-yellow text-sm font-semibold">
            {GRADE_BLURB[report.grade.letter] ?? 'Another year in the books.'}
          </div>
          <div className="text-[11px] text-[var(--ink-dim)]">
            effort score {report.grade.score}/100
            {report.prevYear ? ` · vs ${report.prevYear}` : ''} <YearGradeBreakdown grade={report.grade} />
          </div>
          {report.inProgress && (
            <div className="text-[11px] text-[var(--ink-dim)]">
              ⏳ {report.year} is still in progress — numbers are year-to-date.
            </div>
          )}
        </section>

        {/* The big three: in / out / net */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Tile href="/reports/income">
            <TileLabel>💰 Money in</TileLabel>
            <Big className="report-neon-cyan">{formatCurrency(report.totalIncome)}</Big>
            {report.prevIncome !== null && (
              <Delta good={report.totalIncome >= report.prevIncome} text={`${signed(report.totalIncome - report.prevIncome)} vs ${report.prevYear}`} />
            )}
          </Tile>
          <Tile href="/reports">
            <TileLabel>💸 Money out</TileLabel>
            <Big className="report-neon-cyan">{formatCurrency(report.totalSpend)}</Big>
            {report.prevSpend !== null && (
              <Delta good={report.totalSpend <= report.prevSpend} text={`${signed(report.totalSpend - report.prevSpend)} vs ${report.prevYear}`} />
            )}
          </Tile>
          <Tile>
            <TileLabel>🎯 Year net</TileLabel>
            <Big className={report.net >= 0 ? 'report-good' : 'report-bad'}>
              {report.net >= 0 ? '+' : ''}{formatCurrency(report.net)}
            </Big>
            {report.prevNet !== null && (
              <Delta good={report.net >= report.prevNet} text={`${signed(report.net - report.prevNet)} vs ${report.prevYear}`} />
            )}
          </Tile>
        </section>

        {/* Month-by-month strip */}
        <section className="report-card px-5 py-4">
          <SectionTitle>📅 The twelve rounds</SectionTitle>
          <div className="mt-3 flex items-end justify-between gap-1" style={{ height: 84 }}>
            {report.monthlyNets.map((m) => {
              const h = Math.max(4, Math.round((Math.abs(m.net) / maxAbsNet) * 70))
              return (
                <Link
                  key={m.ym}
                  href={`/report?month=${m.ym}`}
                  title={`${m.label}: ${m.net >= 0 ? '+' : ''}${formatCurrency(m.net)}`}
                  className="flex flex-1 flex-col items-center justify-end gap-1"
                >
                  <div
                    className="w-full max-w-[22px] rounded-sm"
                    style={{ height: h, background: m.net >= 0 ? 'var(--neon-cyan,#2dd4bf)' : 'var(--neon-pink,#f0459c)', opacity: 0.85 }}
                  />
                  <div className="text-[9px] uppercase text-[var(--ink-dim)]">{m.ym.slice(5)}</div>
                </Link>
              )
            })}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
            {report.bestMonth && (
              <div>🥇 Best: <span className="report-good font-semibold">{report.bestMonth.label}</span> ({signed(report.bestMonth.net)})</div>
            )}
            {report.worstMonth && (
              <div>🥴 Toughest: <span className="report-bad font-semibold">{report.worstMonth.label}</span> ({signed(report.worstMonth.net)})</div>
            )}
            <div>🖤 In the black: <span className="report-neon-cyan font-semibold">{report.monthsInBlack} months</span></div>
          </div>
        </section>

        {/* Category wins & slips (only when a previous year exists) */}
        {(report.categoryWins.length > 0 || report.categorySlips.length > 0) && (
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <CategoryList title="🟢 Green machine — biggest cuts" deltas={report.categoryWins} good prevYear={report.prevYear} />
            <CategoryList title="🔴 Creep alert — biggest rises" deltas={report.categorySlips} prevYear={report.prevYear} />
          </section>
        )}

        {/* Top merchants */}
        <section className="report-card px-5 py-4">
          <SectionTitle>🏪 Top 10 merchants</SectionTitle>
          <ol className="mt-3 flex flex-col gap-1.5">
            {report.topMerchants.map((m, i) => (
              <li key={m.id}>
                <Link href={`/transactions?month=all&q=${encodeURIComponent(m.name)}`} className="flex items-center gap-2 text-xs hover:brightness-125">
                  <span className="w-5 text-right tabular-nums text-[var(--ink-dim)]">{i + 1}.</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{m.name}</span>
                  <span className="hidden text-[var(--ink-dim)] sm:inline">{m.count}×</span>
                  <span className="w-24 text-right tabular-nums report-neon-cyan">{formatCurrency(m.amount)}</span>
                  <span className="hidden h-1.5 w-24 rounded-full bg-white/10 sm:block">
                    <span
                      className="block h-1.5 rounded-full"
                      style={{ width: `${Math.round((m.amount / maxMerchant) * 100)}%`, background: 'var(--neon-cyan,#2dd4bf)' }}
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>

        {/* Money moved: goals, mortgage, TFSA, RESP */}
        <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <MiniStat label="Moved to goals" value={formatCurrency(report.movedToGoals)} sub={report.movedToGoalsPrev !== null ? `${signed(report.movedToGoals - report.movedToGoalsPrev)} vs ${report.prevYear}` : undefined} href="/goals" emoji="💸" />
          <MiniStat label="Mortgage principal" value={formatCurrency(report.mortgagePrincipal)} sub="killed this year" href="/goals" emoji="🏠" />
          <MiniStat label="TFSA contributed" value={formatCurrency(report.tfsaContributed)} href="/investments" emoji="🌱" />
          <MiniStat label="RESP contributed" value={formatCurrency(report.respContributed)} href="/investments" emoji="🎓" />
        </section>

        {/* Fun facts */}
        <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <MiniStat label="No-spend days" value={String(report.noSpendDays)} sub="not a dime" emoji="🧊" />
          <MiniStat label="Subscriptions" value={formatCurrency(report.subscriptionsTotal)} sub="recurring total" href="/merchants" emoji="🔁" />
          {report.biggestPurchase ? (
            <MiniStat
              label="Biggest splurge"
              value={formatCurrency(report.biggestPurchase.amount)}
              sub={`${report.biggestPurchase.merchant} · ${formatShortDate(report.biggestPurchase.date)}`}
              emoji="💥"
            />
          ) : (
            <MiniStat label="Biggest splurge" value="—" emoji="💥" />
          )}
          {nwDelta !== null && report.netWorthEnd !== null ? (
            <MiniStat
              label="Net worth"
              value={formatCurrency(report.netWorthEnd)}
              sub={`${signed(nwDelta)} in ${report.year}`}
              href="/accounts/networth"
              emoji="🏦"
            />
          ) : (
            <MiniStat label="Net worth" value={report.netWorthEnd !== null ? formatCurrency(report.netWorthEnd) : '—'} href="/accounts/networth" emoji="🏦" />
          )}
        </section>

        {/* Share line */}
        <p className="text-center text-xs text-[var(--ink-dim)]">{report.shareLine}</p>
      </div>
    </div>
  )
}

function NavArrow({ year, label, title }: { year: string | null; label: string; title: string }) {
  if (!year) return <span className="report-btn px-3 py-1 text-sm opacity-35">{label}</span>
  return (
    <Link href={`/report/year?year=${year}`} title={title} className="report-btn px-3 py-1 text-sm">
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

function Big({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`text-2xl font-extrabold tabular-nums sm:text-3xl ${className ?? ''}`}>{children}</div>
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium uppercase tracking-wider text-[var(--ink-dim)]">{children}</div>
}

function Delta({ good, text }: { good: boolean; text: string }) {
  return <div className={`mt-1 text-xs font-semibold ${good ? 'report-good' : 'report-bad'}`}>{text}</div>
}

function CategoryList({
  title,
  deltas,
  good,
  prevYear,
}: {
  title: string
  deltas: CategoryDelta[]
  good?: boolean
  prevYear: string | null
}) {
  return (
    <div className="report-card report-rise px-4 py-4">
      <TileLabel>{title}</TileLabel>
      {deltas.length === 0 ? (
        <div className="text-sm text-[var(--ink-dim)]">Nothing notable.</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {deltas.map((d) => (
            <li key={d.name} className="text-xs">
              <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: d.color }} />
              <span className="font-bold">{d.name}</span>{' '}
              <span className={`font-semibold tabular-nums ${good ? 'report-good' : 'report-bad'}`}>
                {signed(d.deltaDollars)} ({d.isNew ? 'new' : `${d.deltaPct > 0 ? '+' : ''}${Math.round(d.deltaPct)}%`})
              </span>
              <div className="text-[10px] text-[var(--ink-dim)]">
                {formatCurrency(d.amount)} vs {formatCurrency(d.prevAmount)} in {prevYear}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function MiniStat({
  label,
  value,
  sub,
  href,
  emoji,
}: {
  label: string
  value: string
  sub?: string
  href?: string
  emoji: string
}) {
  const body = (
    <>
      <div className="text-lg">{emoji}</div>
      <div className="report-neon-cyan truncate text-lg font-bold tabular-nums">{value}</div>
      {sub && <div className="truncate text-[11px] text-[var(--ink-dim)]">{sub}</div>}
      <div className="mt-1 text-[10px] uppercase tracking-wider text-[var(--ink-dim)]">{label}</div>
    </>
  )
  const cls = 'report-card report-rise px-3 py-3 text-center'
  if (href) return <Link href={href} className={`${cls} block transition hover:brightness-110`}>{body}</Link>
  return <div className={cls}>{body}</div>
}

const SIGNAL_LABELS: Record<keyof typeof YEAR_WEIGHTS, string> = {
  black: 'Year in the black',
  yoy: 'Net vs last year',
  goals: 'Money moved to goals',
  discretionary: 'Discretionary spend YoY',
  consistency: 'Months in the black',
}

function YearGradeBreakdown({ grade }: { grade: YearGrade }) {
  const [open, setOpen] = useState(false)
  const b = grade.breakdown

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ml-1 text-[var(--neon-cyan,#2dd4bf)] underline underline-offset-2 hover:opacity-80"
        style={{ fontSize: 'inherit' }}
      >
        {open ? 'Hide ▲' : 'Why? ▼'}
      </button>
      {open && (
        <div className="mt-3 overflow-hidden rounded-xl border border-[var(--neon-cyan,#2dd4bf)] bg-black/50 px-4 py-3 text-left">
          <div className="mb-2 text-[10px] uppercase tracking-widest text-[var(--neon-cyan,#2dd4bf)]">Score breakdown</div>
          <table className="w-full text-xs">
            <tbody>
              {(Object.keys(YEAR_WEIGHTS) as (keyof typeof YEAR_WEIGHTS)[]).map((key) => {
                const weight = YEAR_WEIGHTS[key]
                const sub = b[key]
                const pts = Math.round(sub * weight)
                const pct = Math.round(sub * 100)
                return (
                  <tr key={key}>
                    <td className="py-1 pr-3 whitespace-nowrap text-[var(--ink-dim)]">{SIGNAL_LABELS[key]}</td>
                    <td className="w-full py-1 pr-2">
                      <div className="h-1.5 rounded-full bg-white/10">
                        <div
                          className="h-1.5 rounded-full"
                          style={{ width: `${pct}%`, background: pct >= 70 ? 'var(--neon-cyan,#2dd4bf)' : pct >= 40 ? 'var(--neon-yellow,#fbbf24)' : 'var(--neon-pink,#f0459c)' }}
                        />
                      </div>
                    </td>
                    <td className="py-1 pl-2 text-right tabular-nums whitespace-nowrap text-white">{pts}/{weight}</td>
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
