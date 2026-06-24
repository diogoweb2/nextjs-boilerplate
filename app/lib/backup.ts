/**
 * Backup-freshness config used by the dashboard staleness banner
 * (BackupStatusBanner). The weekly launchd job (sync/backup) reports each run to
 * /api/backup-status → backup_runs; here we decide when "no recent backup"
 * becomes a visible warning. Display reuses formatSyncAge from ./sync.
 */

/** A successful backup older than this (or none at all) raises the banner. */
export const BACKUP_STALE_MS = 14 * 24 * 60 * 60 * 1000

export function backupStale(lastSuccessIso: string | null, now = Date.now()): boolean {
  if (!lastSuccessIso) return true
  return now - new Date(lastSuccessIso).getTime() > BACKUP_STALE_MS
}
