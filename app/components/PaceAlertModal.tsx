'use client'

import { useCallback, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import type { PaceAlert } from '@/app/lib/pace-alerts'
import { formatCurrency } from '@/app/lib/format'

/**
 * Dashboard modal opened by tapping a digest push that carried pace alerts
 * (`/?paceAlert=1`, see BUSINESS_RULES.md §B5-pace). Expands the compact
 * "🔥 Groceries +30%" notification line into the full picture per category:
 * spent so far, goal, run-rate projection, and how much/day keeps it on goal.
 * Closing strips the query param so the normal dashboard remains.
 */
export function PaceAlertModal({ alerts }: { alerts: PaceAlert[] }) {
  const router = useRouter()
  const pathname = usePathname()

  // Read the query at close time (client event) instead of useSearchParams so
  // the server page can render this without a Suspense boundary.
  const onClose = useCallback(() => {
    const params = new URLSearchParams(window.location.search)
    params.delete('paceAlert')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
  }, [router, pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:py-10"
      role="dialog"
      aria-modal="true"
      aria-label="Category pace alerts"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-[var(--border)] text-[var(--foreground)] shadow-xl"
        style={{ background: 'var(--surface)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div>
            <div className="text-sm font-semibold">🔥 Categories running hot</div>
            <div className="text-xs text-[var(--muted)]">
              At the current pace these categories will finish the month over their goal.
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
        <div className="flex flex-col gap-3 p-4">
          {alerts.length === 0 && (
            <p className="py-6 text-center text-sm text-[var(--muted)]">
              Nothing is running hot right now — the pace that triggered the notification has
              cooled off (or the month rolled over). All good.
            </p>
          )}
          {alerts.map((a) => {
            const daysLeft = a.daysInMonth - a.asOfDay
            // Spend/day that lands exactly on the goal by month end.
            const perDayToGoal = daysLeft > 0 ? Math.max(0, (a.goal - a.spent) / daysLeft) : 0
            return (
              <div
                key={a.categoryId}
                className="rounded-lg border border-[var(--border)] p-3"
                style={{ borderLeft: `4px solid ${a.color}` }}
              >
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold">{a.name}</span>
                  <span className="text-sm font-semibold text-[var(--negative)]">
                    +{a.overPct}% over goal
                  </span>
                </div>
                <p className="text-xs text-[var(--muted)]">
                  {formatCurrency(a.spent)} spent in the first {a.asOfDay} days — on pace for{' '}
                  <strong className="text-[var(--foreground)]">{formatCurrency(a.projected)}</strong>{' '}
                  vs a {formatCurrency(a.goal)} goal.
                  {daysLeft > 0 && (
                    <>
                      {' '}
                      Staying under {formatCurrency(perDayToGoal)}/day for the remaining {daysLeft}{' '}
                      days keeps it on goal.
                    </>
                  )}
                </p>
                <a
                  href={`/transactions?category=${encodeURIComponent(a.name)}`}
                  className="mt-1 inline-block text-xs text-[var(--muted)] underline hover:text-[var(--foreground)]"
                >
                  see the charges →
                </a>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
