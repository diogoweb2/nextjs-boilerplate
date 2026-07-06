'use client'

import { formatSyncAge, syncStale } from '@/app/lib/sync'

type SyncEntry = { label: string; lastSync: string | null; failed?: boolean }

/**
 * Dashboard freshness badge: shows each source's last-sync age, red past the
 * stale threshold OR when its last automated run failed (`failed`). The failure
 * details live in the SyncErrorBanner; this is the always-visible at-a-glance
 * status. Alerting itself is handled by the daily Web Push digest.
 *
 * `lastNotified` is when the daily push digest last actually went out (null if
 * never), shown as a trailing badge alongside the per-source sync ages.
 */
export function SyncStatusBar({
  entries,
  lastNotified,
}: {
  entries: SyncEntry[]
  lastNotified?: string | null
}) {
  return (
    <div className="flex items-center gap-3">
      {entries.map(({ label, lastSync, failed }) => {
        const bad = failed || syncStale(lastSync)
        return (
          <span
            key={label}
            title={
              failed
                ? 'Last automated sync failed'
                : lastSync
                  ? `Last sync: ${new Date(lastSync).toLocaleString()}`
                  : 'Never synced'
            }
            className={`text-xs ${bad ? 'font-medium text-[var(--negative)]' : 'text-[var(--muted)]'}`}
          >
            {label}: {failed ? '⚠️ ' : ''}
            {lastSync ? `${formatSyncAge(lastSync)} ago` : 'never'}
          </span>
        )
      })}
      {lastNotified !== undefined && (
        <span
          title={
            lastNotified
              ? `Last daily notification sent: ${new Date(lastNotified).toLocaleString()}`
              : 'No daily notification sent yet'
          }
          className="text-xs text-[var(--muted)]"
        >
          Notified: {lastNotified ? `${formatSyncAge(lastNotified)} ago` : 'never'}
        </span>
      )}
    </div>
  )
}
