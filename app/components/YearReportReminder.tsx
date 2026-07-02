'use client'

import { useSyncExternalStore } from 'react'
import Link from 'next/link'
import { YEAR_REPORT_SEEN_KEY } from '@/app/lib/reportSchedule'

/**
 * Persistent, device-local nudge to view the Year in Review — the annual sibling
 * of ReportReminder. The year-settled push is one-shot and easy to miss, so this
 * banner keeps showing on every visit until the owner opens the review
 * (YearReportClient marks it seen) or taps Dismiss. Same contract: what's "seen"
 * lives in localStorage, per-device and not in the db, so each person clears it
 * on their own.
 */

const CHANGE_EVENT = 'yearReportReminderChange'

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange) // sync across tabs
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

const getSeen = () => localStorage.getItem(YEAR_REPORT_SEEN_KEY)

export function YearReportReminder({ year }: { year: string | null }) {
  const seen = useSyncExternalStore(subscribe, getSeen, () => null)

  if (!year || seen === year) return null

  const dismiss = () => {
    localStorage.setItem(YEAR_REPORT_SEEN_KEY, year)
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }

  return (
    <div
      role="status"
      className="mb-5 flex flex-col gap-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-sm font-semibold">🎉 Your {year} Year in Review is ready.</p>
      <div className="flex items-center gap-2">
        <Link
          href={`/report/year?year=${year}`}
          onClick={dismiss}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[var(--accent-fg)]"
        >
          Watch the rewind ⏪
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
