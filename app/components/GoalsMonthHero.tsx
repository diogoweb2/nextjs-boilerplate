'use client'

/**
 * "Invested in <month>" hero on the Goals page. Defaults to the current month
 * (rendered straight from the server's monthStats, so first paint needs no
 * fetch), and lets the owner step to any other month — each step loads that
 * month's contributions from `loadGoalMonth` and can itemize every entry that
 * made up the figure. See BUSINESS_RULES.md §10.
 */

import { useEffect, useState, useTransition } from 'react'
import { formatCurrency, formatMonth, formatShortDate } from '@/app/lib/format'
import { loadGoalMonth, type GoalMonthDetail, type GoalView } from '@/app/actions/goals'

const STEP_BTN =
  'rounded-lg border border-[var(--border)] px-2 py-0.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40'
const GHOST_BTN =
  'rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)]'

function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

export function GoalsMonthHero({
  goals,
  nowYm,
  monthStats,
}: {
  goals: GoalView[]
  nowYm: string
  monthStats: { thisMonth: number; lastMonth: number }
}) {
  const [ym, setYm] = useState(nowYm)
  const [detail, setDetail] = useState<GoalMonthDetail | null>(null)
  const [showRows, setShowRows] = useState(false)
  const [pending, startTransition] = useTransition()

  // The current month renders from monthStats without a fetch; every other
  // month (and any itemized view) needs the per-entry detail.
  const needsDetail = ym !== nowYm || showRows
  useEffect(() => {
    if (!needsDetail || detail?.ym === ym) return
    startTransition(async () => {
      setDetail(await loadGoalMonth(ym))
    })
  }, [ym, needsDetail, detail?.ym])

  const showing = detail?.ym === ym ? detail : null
  const isCurrent = ym === nowYm
  const total = isCurrent && !showing ? monthStats.thisMonth : (showing?.total ?? 0)
  const prevTotal = isCurrent && !showing ? monthStats.lastMonth : (showing?.prevTotal ?? 0)
  const perGoal =
    showing?.perGoal ??
    (isCurrent
      ? goals
          .filter((g) => !g.archived && Math.abs(g.contributedThisMonth) >= 0.005)
          .map((g) => ({ goalId: g.id, name: g.name, emoji: g.emoji, amount: g.contributedThisMonth }))
      : [])
  const loading = pending && !showing

  return (
    <div className="card animate-in bg-gradient-to-br from-[var(--surface)] to-[var(--surface-2)] p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold tracking-tight">Your Goals 🎯</h1>

          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button className={STEP_BTN} onClick={() => setYm(addMonths(ym, -1))} aria-label="Previous month">
              ‹
            </button>
            <input
              type="month"
              value={ym}
              max={nowYm}
              onChange={(e) => e.target.value && setYm(e.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-xs text-[var(--foreground)]"
              aria-label="Month"
            />
            <button
              className={STEP_BTN}
              onClick={() => setYm(addMonths(ym, 1))}
              disabled={ym >= nowYm}
              aria-label="Next month"
            >
              ›
            </button>
            {!isCurrent && (
              <button className={GHOST_BTN} onClick={() => setYm(nowYm)}>
                This month
              </button>
            )}
          </div>

          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums">
              {loading ? '—' : formatCurrency(total)}
            </span>
            <span className="text-sm text-[var(--muted)]">
              invested in {isCurrent ? 'this month' : formatMonth(ym)}
            </span>
            {!loading && prevTotal > 0 && (
              <span
                className={`text-sm font-medium ${total >= prevTotal ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}
              >
                {total >= prevTotal ? '↑' : '↓'} {formatCurrency(Math.abs(total - prevTotal))} vs{' '}
                {formatMonth(addMonths(ym, -1))}
              </span>
            )}
          </div>

          {perGoal.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
              {perGoal.map((g) => (
                <div key={g.goalId} className="flex items-center gap-1.5 text-sm">
                  <span>{g.emoji}</span>
                  <span className="text-[var(--muted)]">{g.name}</span>
                  <span className="font-medium tabular-nums">{formatCurrency(g.amount)}</span>
                  {total > 0 && (
                    <span className="text-xs text-[var(--muted)]">
                      ({Math.round((g.amount / total) * 100)}%)
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {!loading && total === 0 && perGoal.length === 0 && (
            <p className="mt-2 text-sm text-[var(--muted)]">
              {isCurrent ? 'Nothing invested yet this month.' : `Nothing invested in ${formatMonth(ym)}.`}
            </p>
          )}

          <button className={`${GHOST_BTN} mt-3`} onClick={() => setShowRows((v) => !v)}>
            {showRows ? 'Hide contributions' : 'See contributions'}
          </button>

          {showRows && (
            <div className="mt-2">
              {loading || (!showing && needsDetail) ? (
                <p className="text-sm text-[var(--muted)]">Loading…</p>
              ) : showing && showing.rows.length > 0 ? (
                <ul className="flex flex-col divide-y divide-[var(--border)] text-sm">
                  {showing.rows.map((r) => (
                    <li key={r.key} className="flex items-center gap-2 py-1.5">
                      <span className="w-14 shrink-0 text-xs text-[var(--muted)]">
                        {formatShortDate(r.occurredAt)}
                      </span>
                      <span>{r.goalEmoji}</span>
                      <span className="shrink-0">{r.goalName}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-[var(--muted)]">
                        {r.source === 'mortgage-extra' ? `Extra principal — ${r.note}` : r.note}
                      </span>
                      <span
                        className={`shrink-0 font-medium tabular-nums ${r.amount < 0 ? 'text-[var(--negative)]' : ''}`}
                      >
                        {formatCurrency(r.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-[var(--muted)]">No contributions recorded in {formatMonth(ym)}.</p>
              )}
            </div>
          )}
        </div>
        <span className="hidden text-4xl sm:block">🚀</span>
      </div>
    </div>
  )
}
