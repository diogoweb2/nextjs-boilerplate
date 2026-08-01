'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCurrency } from '@/app/lib/format'
import { dismissPlannedSplitAlert, type PlannedSplitAlert } from '@/app/actions/planned-splits'

/**
 * Dashboard feedback for planned splits (BUSINESS_RULES.md §22): a green line
 * confirming the import carved out what you asked for, and an amber one when a
 * rule has been waiting a week without ever matching (typo'd payee, charge that
 * never posted). Dismissal is DB-backed, so it clears on every device —
 * dismissing a done rule deletes it, dismissing a stuck one only mutes it.
 */
function line(a: PlannedSplitAlert): string {
  if (a.status === 'applied') {
    const goal = a.goalName ? `, paid from ${a.goalName}` : ''
    return `Split ${formatCurrency(a.splitAmount)} out of your ${a.merchantLabel} charge as “${a.label}”${goal}.`
  }
  return `Still waiting on a ${a.merchantLabel} charge for “${a.label}” — ${a.waitingDays} days and nothing matched.`
}

export function PlannedSplitBanner({ alerts }: { alerts: PlannedSplitAlert[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  if (alerts.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      {alerts.map((a) => (
        <div
          key={a.id}
          className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
            a.status === 'applied'
              ? 'border-emerald-500/30 bg-emerald-500/10'
              : 'border-amber-500/30 bg-amber-500/10'
          }`}
        >
          <span className="min-w-0 text-sm">
            <span aria-hidden className="mr-1.5">
              {a.status === 'applied' ? '✅' : '⏳'}
            </span>
            {line(a)}{' '}
            <a href="/transactions/planned" className="underline">
              {a.status === 'applied' ? 'Review' : 'Fix the rule'}
            </a>
          </span>
          <button
            onClick={() =>
              startTransition(async () => {
                await dismissPlannedSplitAlert(a.id)
                router.refresh()
              })
            }
            disabled={pending}
            title={
              a.status === 'applied'
                ? 'Got it — remove this planned split'
                : 'Stop warning me about this rule'
            }
            className="shrink-0 rounded-full border border-[var(--border)] px-2.5 py-1 text-xs font-medium text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
          >
            {pending ? 'Dismissing…' : 'Dismiss'}
          </button>
        </div>
      ))}
    </div>
  )
}
