'use client'

import { useState, useTransition } from 'react'
import { dismissProjectFromDashboard, type DashboardProject } from '@/app/actions/projects'
import { formatCurrency } from '@/app/lib/format'

/**
 * Dashboard reminder, collapsed by default (header shows the count), for
 * projects whose window is near or current (§15): from
 * ~3 weeks before start through 10 days after end. Only projects that are over
 * (in the +10-day tail) show a Dismiss button; dismissing persists in the DB
 * (`dashboardDismissed`) so it clears across devices and never reappears. The
 * banner also clears on its own once the project's +10-day tail elapses.
 */
function dateRange(p: DashboardProject): string {
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return p.endDate && p.endDate !== p.startDate
    ? `${fmt(p.startDate)} – ${fmt(p.endDate)}`
    : fmt(p.startDate)
}

function phrase(p: DashboardProject): string {
  if (p.phase === 'upcoming') {
    if (p.daysUntilStart === 1) return 'starts tomorrow'
    return `starts in ${p.daysUntilStart} days`
  }
  if (p.phase === 'active') return 'happening now'
  return 'just wrapped up'
}

function DismissButton({ id }: { id: number }) {
  const [pending, startTransition] = useTransition()
  return (
    <button
      onClick={() => startTransition(() => dismissProjectFromDashboard(id))}
      disabled={pending}
      className="shrink-0 rounded-full border border-[var(--border)] px-2.5 py-1 text-xs font-medium text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
      title="Dismiss — stop reminding me about this project"
    >
      {pending ? 'Dismissing…' : 'Dismiss'}
    </button>
  )
}

export function ProjectReminderBanner({ projects }: { projects: DashboardProject[] }) {
  const [open, setOpen] = useState(false)
  if (projects.length === 0) return null

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="text-sm font-semibold">
          🧳 Project reminder
          <span className="ml-1.5 font-normal text-[var(--muted)]">({projects.length})</span>
        </span>
        <span className={`text-xs text-[var(--muted)] transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden>
          ▾
        </span>
      </button>
      {open && (
      <ul className="mt-2 flex flex-col gap-2">
        {projects.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <span className="text-sm text-[var(--muted)]">
              <a href={`/projects/${p.id}`} className="font-medium text-[var(--foreground)] hover:underline">
                {p.emoji} {p.name}
              </a>{' '}
              {phrase(p)} ({dateRange(p)})
              {p.count > 0 && ` — ${formatCurrency(p.total)} so far`}.
            </span>
            {p.phase === 'wrapup' && <DismissButton id={p.id} />}
          </li>
        ))}
      </ul>
      )}
    </div>
  )
}
