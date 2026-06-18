'use client'

import { formatSyncAge, syncStale } from '@/app/lib/sync'

type SyncEntry = { label: string; lastSync: string | null }

/**
 * Dashboard freshness badge: shows each source's last-sync age, red past the
 * stale threshold. Alerting itself is handled by the daily Web Push digest
 * (Settings → Notifications); this is the always-visible at-a-glance status.
 */
export function SyncStatusBar({ entries }: { entries: SyncEntry[] }) {
  return (
    <div className="flex items-center gap-3">
      {entries.map(({ label, lastSync }) => {
        const stale = syncStale(lastSync)
        return (
          <span
            key={label}
            title={lastSync ? `Last sync: ${new Date(lastSync).toLocaleString()}` : 'Never synced'}
            className={`text-xs ${stale ? 'font-medium text-[var(--negative)]' : 'text-[var(--muted)]'}`}
          >
            {label}: {lastSync ? `${formatSyncAge(lastSync)} ago` : 'never'}
          </span>
        )
      })}
    </div>
  )
}
