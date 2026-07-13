/**
 * Shared sync-freshness config used by the dashboard notification bell (NotificationBell) and
 * the daily digest (app/lib/digest.ts). One place to add a source or change the
 * staleness threshold so the two never drift.
 */

export type SyncSource = {
  source: 'amex' | 'master' | 'scotia' | 'tangerine'
  label: string
  /**
   * Sources that gate the daily digest notification. The push fires once all
   * of these have synced today, even if the others (scotia/tangerine) haven't —
   * Master and Amex carry the bulk of daily spend, so waiting on the slower
   * accounts would delay (or drop) the notification.
   */
  requiredForDigest?: boolean
}

/**
 * Auto-synced sources, in display order. Each maps to an `import_batches`
 * source key — every consumer (dashboard badge, daily digest) picks up new
 * entries automatically.
 */
export const SYNC_SOURCES: SyncSource[] = [
  { source: 'amex', label: 'Amex', requiredForDigest: true },
  { source: 'master', label: 'Master', requiredForDigest: true },
  { source: 'scotia', label: 'Scotia' },
  { source: 'tangerine', label: 'Tangerine' },
]

/** The subset of sources whose sync gates the daily digest push. */
export const DIGEST_REQUIRED_SOURCES = SYNC_SOURCES.filter((s) => s.requiredForDigest)

/** A sync older than this is "stale" — shown in red and flagged in the digest. */
export const SYNC_STALE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Freshness = the more recent of the last imported batch and the last successful
 * sync run. A successful sync that imports 0 new rows (very common for Tangerine,
 * whose export only lists *new* transactions) advances `sync_runs.lastSuccessAt`
 * but creates no import batch — so without this it would look perpetually stale.
 */
export function mostRecentIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  // ISO-8601 UTC strings sort chronologically as plain strings.
  return a > b ? a : b
}

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
