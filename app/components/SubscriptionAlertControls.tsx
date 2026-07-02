'use client'

import { useTransition } from 'react'
import { dismissSubscriptionAlert, undismissSubscriptionAlert } from '@/app/actions/subscriptions'

/**
 * "Not a real increase" — marks a subscription price-change alert as spurious
 * (e.g. a month with a double/triple charge from a payment-schedule quirk). The
 * dismissal is keyed to this exact change, so a genuine later change re-alerts.
 */
export function DismissAlertButton({
  merchantId,
  sinceYm,
  amount,
}: {
  merchantId: number
  sinceYm: string
  amount: number
}) {
  const [pending, startTransition] = useTransition()
  return (
    <button
      onClick={() =>
        startTransition(() => dismissSubscriptionAlert(merchantId, sinceYm, amount))
      }
      disabled={pending}
      className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] font-medium text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
      title="This isn't a real price increase — hide it (e.g. a month with more than one charge)"
    >
      {pending ? 'Hiding…' : 'Not a real increase'}
    </button>
  )
}

/** Undo a dismissal — the alert reappears if the change still stands. */
export function UndismissAlertButton({ merchantId }: { merchantId: number }) {
  const [pending, startTransition] = useTransition()
  return (
    <button
      onClick={() => startTransition(() => undismissSubscriptionAlert(merchantId))}
      disabled={pending}
      className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] font-medium text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
      title="Undo — treat this as a price change again"
    >
      {pending ? 'Undoing…' : 'Undo'}
    </button>
  )
}
