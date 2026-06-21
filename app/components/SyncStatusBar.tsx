'use client'

import { formatSyncAge, syncStale } from '@/app/lib/sync'

type SyncEntry = { label: string; lastSync: string | null; failed?: boolean }

/**
 * Dashboard freshness badge: shows each source's last-sync age, red past the
 * stale threshold OR when its last automated run failed (`failed`). The failure
 * details live in the SyncErrorBanner; this is the always-visible at-a-glance
 * status. Alerting itself is handled by the daily Web Push digest.
 */
export function SyncStatusBar({ entries }: { entries: SyncEntry[] }) {
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
    </div>
  )
}
