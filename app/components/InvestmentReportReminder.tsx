'use client'

import { useSyncExternalStore } from 'react'
import Link from 'next/link'
import { INVESTMENT_REPORT_SEEN_KEY } from '@/app/lib/investmentReportSchedule'

/**
 * Device-local nudge that the monthly investment report is ready — mirrors
 * ReportReminder (§15) but for holdings (§16b). `snapshotDate` is the latest
 * holdings-snapshot date to nag about (or null), decided server-side; what's
 * "seen" lives in localStorage (per device, not the db). Opening the report
 * (InvestmentReportClient sets the key) or tapping Dismiss clears it.
 */

const CHANGE_EVENT = 'investmentReportChange'

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

const getSeen = () => localStorage.getItem(INVESTMENT_REPORT_SEEN_KEY)

export function InvestmentReportReminder({ snapshotDate }: { snapshotDate: string | null }) {
  const seen = useSyncExternalStore(subscribe, getSeen, () => null)

  if (!snapshotDate || seen === snapshotDate) return null

  const dismiss = () => {
    localStorage.setItem(INVESTMENT_REPORT_SEEN_KEY, snapshotDate)
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }

  return (
    <div
      role="status"
      className="mb-5 flex flex-col gap-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-sm font-semibold">📈 Your monthly investment report is ready.</p>
      <div className="flex items-center gap-2">
        <Link
          href="/accounts/investments/report"
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
