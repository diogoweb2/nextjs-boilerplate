/**
 * Shared sync-freshness config used by the dashboard badge (SyncStatusBar) and
 * the daily digest (app/lib/digest.ts). One place to add a source or change the
 * staleness threshold so the two never drift.
 */

export type SyncSource = { source: 'amex' | 'master' | 'scotia'; label: string }

/**
 * Auto-synced sources, in display order. Each maps to an `import_batches`
 * source key. Add Tangerine here (`{ source: 'tangerine', label: 'Tangerine' }`)
 * once its sync runner lands — every consumer picks it up automatically.
 */
export const SYNC_SOURCES: SyncSource[] = [
  { source: 'amex', label: 'Amex' },
  { source: 'master', label: 'Master' },
  { source: 'scotia', label: 'Scotia' },
]

/** A sync older than this is "stale" — shown in red and flagged in the digest. */
export const SYNC_STALE_MS = 3 * 24 * 60 * 60 * 1000

export function syncAgeMs(lastSync: string | null, now = Date.now()): number | null {
  if (!lastSync) return null
  return now - new Date(lastSync).getTime()
}

export function syncStale(lastSync: string | null, now = Date.now()): boolean {
  const age = syncAgeMs(lastSync, now)
  return age === null || age > SYNC_STALE_MS
}

/** Compact relative age ("8m", "5h", "4d", or "never"). */
export function formatSyncAge(lastSync: string | null, now = Date.now()): string {
  const age = syncAgeMs(lastSync, now)
  if (age === null) return 'never'
  const minutes = Math.floor(age / 60_000)
  const hours = Math.floor(age / 3_600_000)
  const days = Math.floor(age / 86_400_000)
  if (minutes < 60) return `${minutes}m`
  if (hours < 24) return `${hours}h`
  return `${days}d`
}
