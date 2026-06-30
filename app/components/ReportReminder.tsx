'use client'

import { useSyncExternalStore } from 'react'
import Link from 'next/link'
import { REPORT_SEEN_KEY } from '@/app/lib/reportSchedule'

/**
 * Persistent, device-local nudge to view the monthly recap. The recap push
 * (app/api/digest) is one-shot and easy to miss, so this banner keeps showing on
 * every visit until the owner opens the report (ReportClient marks it seen) or
 * taps Dismiss.
 *
 * `month` is the completed month to nag about (or null), decided server-side from
 * the data (app/page.tsx). What's "seen" lives in localStorage — intentionally
 * per-device and not in the db, so each person clears it on their own. Read via
 * useSyncExternalStore so the server snapshot is null (no hydration mismatch) and
 * a dismiss re-reads immediately.
 */

const CHANGE_EVENT = 'reportReminderChange'

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange) // sync across tabs
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

const getSeen = () => localStorage.getItem(REPORT_SEEN_KEY)

export function ReportReminder({ month }: { month: string | null }) {
  const seen = useSyncExternalStore(subscribe, getSeen, () => null)

  if (!month || seen === month) return null

  const dismiss = () => {
    localStorage.setItem(REPORT_SEEN_KEY, month)
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }

  const label = new Date(`${month}-01T00:00:00`).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  })

  return (
    <div
      role="status"
      className="mb-5 flex flex-col gap-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-sm font-semibold">📊 Your {label} report is ready.</p>
      <div className="flex items-center gap-2">
        <Link
          href={`/report?month=${month}`}
          onClick={dismiss}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[var(--accent-fg)]"
        >
          View report ▶
        </Link>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-md px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
