'use client'

import { useTransition } from 'react'
import { dismissRenewalWarning } from '@/app/actions/subscriptions'
import type { RenewalWarning } from '@/app/lib/renewal-watch'
import { formatCurrency } from '@/app/lib/format'

/**
 * Dashboard warning for annual subscriptions whose yearly charge is due within
 * ~1 month (§18b). Nudges the owner to cancel before being billed again. Each
 * warning is dismissible; the dismissal persists in the DB (per renewal cycle),
 * so it clears across devices and re-appears next year. The banner also clears
 * on its own once the renewal charge posts.
 */
function renewalPhrase(w: RenewalWarning): string {
  const date = new Date(`${w.renewalDate}T00:00:00`).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
  })
  if (w.daysUntil < 0) return `was due ${date} — cancel now if you don't want it`
  if (w.daysUntil === 0) return `renews today`
  if (w.daysUntil === 1) return `renews tomorrow (${date})`
  return `renews in ${w.daysUntil} days (${date})`
}

function DismissButton({ merchantId, renewalYm }: { merchantId: number; renewalYm: string }) {
  const [pending, startTransition] = useTransition()
  return (
    <button
      onClick={() => startTransition(() => dismissRenewalWarning(merchantId, renewalYm))}
      disabled={pending}
      className="shrink-0 rounded-full border border-[var(--border)] px-2.5 py-1 text-xs font-medium text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
      title="Dismiss — I've decided what to do about this renewal"
    >
      {pending ? 'Dismissing…' : 'Dismiss'}
    </button>
  )
}

export function RenewalWarningBanner({ warnings }: { warnings: RenewalWarning[] }) {
  if (warnings.length === 0) return null

  return (
    <div
      role="alert"
      className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-3"
    >
      <p className="text-sm font-semibold">🔔 Annual subscription renewing soon</p>
      <ul className="mt-2 flex flex-col gap-2">
        {warnings.map((w) => (
          <li key={w.merchantId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <span className="text-sm text-[var(--muted)]">
              <a
                href={`/transactions?period=all&q=${encodeURIComponent(w.name)}`}
                className="font-medium text-[var(--foreground)] hover:underline"
              >
                {w.name}
              </a>{' '}
              {renewalPhrase(w)} — last charged {formatCurrency(w.amount)}.
            </span>
            <DismissButton merchantId={w.merchantId} renewalYm={w.renewalYm} />
          </li>
        ))}
      </ul>
    </div>
  )
}
