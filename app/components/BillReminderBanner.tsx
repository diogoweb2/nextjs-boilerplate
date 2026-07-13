'use client'

import { useState, useTransition } from 'react'
import { dismissBillReminder } from '@/app/actions/bills'
import type { BillReminder } from '@/app/lib/bill-calendar'
import { formatCurrency } from '@/app/lib/format'

/**
 * Top-of-dashboard warning for bills whose expected day is within 2 days (§19).
 * Collapsed by default (header shows the count); expands on click.
 * Clears on its own once the payment posts; each line is also dismissible — the
 * dismissal persists in the DB (per bill + due month), so it clears across
 * devices and next month's cycle warns again.
 */
function duePhrase(r: BillReminder): string {
  const date = new Date(`${r.dueDate}T00:00:00`).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
  })
  if (r.daysUntil === 0) return `expected today`
  if (r.daysUntil === 1) return `expected tomorrow (${date})`
  return `expected in ${r.daysUntil} days (${date})`
}

function DismissButton({ billKey, dueYm }: { billKey: string; dueYm: string }) {
  const [pending, startTransition] = useTransition()
  return (
    <button
      onClick={() => startTransition(() => dismissBillReminder(billKey, dueYm))}
      disabled={pending}
      className="shrink-0 rounded-full border border-[var(--border)] px-2.5 py-1 text-xs font-medium text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
      title="Dismiss — hide this bill's reminder for this month"
    >
      {pending ? 'Dismissing…' : 'Dismiss'}
    </button>
  )
}

export function BillReminderBanner({ reminders }: { reminders: BillReminder[] }) {
  const [open, setOpen] = useState(false)
  if (reminders.length === 0) return null

  return (
    <div
      role="alert"
      className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-3"
    >
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="text-sm font-semibold">
          📅 Bill payment coming up
          <span className="ml-1.5 font-normal text-[var(--muted)]">({reminders.length})</span>
        </span>
        <span className={`text-xs text-[var(--muted)] transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden>
          ▾
        </span>
      </button>
      {open && (
      <ul className="mt-2 flex flex-col gap-2">
        {reminders.map((r) => (
          <li key={r.billKey} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <span className="text-sm text-[var(--muted)]">
              <a
                href={`/transactions?period=all&q=${encodeURIComponent(r.label)}`}
                className="font-medium text-[var(--foreground)] hover:underline"
              >
                {r.label}
              </a>{' '}
              {duePhrase(r)} — about {formatCurrency(r.amount)}.
            </span>
            <DismissButton billKey={r.billKey} dueYm={r.dueYm} />
          </li>
        ))}
      </ul>
      )}
    </div>
  )
}
