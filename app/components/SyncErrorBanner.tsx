'use client'

import { formatSyncAge } from '@/app/lib/sync'

export type SyncFailure = {
  label: string
  lastSuccessAt: string | null
  error: string | null
  failureCount: number
}

/**
 * Dashboard alert shown when one or more automated bank syncs failed. Names the
 * failed bank(s) and when each last worked, so a broken pipeline is obvious at a
 * glance instead of only surfacing 3 days later as "stale". Cleared automatically
 * once a source's next run reports success (see /api/sync-status).
 */
export function SyncErrorBanner({ failures }: { failures: SyncFailure[] }) {
  if (failures.length === 0) return null

  const banks =
    failures.length === 1
      ? `${failures[0].label} sync failed`
      : `${failures.length} syncs failed`

  return (
    <div
      role="alert"
      className="rounded-lg border border-[var(--negative)]/40 bg-[var(--negative)]/10 px-4 py-3"
    >
      <p className="text-sm font-semibold text-[var(--negative)]">⚠️ {banks}</p>
      <ul className="mt-1.5 space-y-1">
        {failures.map((f) => (
          <li key={f.label} className="text-xs text-[var(--muted)]">
            <span className="font-medium text-[var(--foreground)]">{f.label}</span>
            {' — last worked '}
            {f.lastSuccessAt ? (
              <span title={new Date(f.lastSuccessAt).toLocaleString()}>
                {formatSyncAge(f.lastSuccessAt)} ago
              </span>
            ) : (
              'never'
            )}
            {f.failureCount > 1 && ` · failed ${f.failureCount}×`}
            {f.error && <span className="block text-[var(--muted)]/80">{f.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
