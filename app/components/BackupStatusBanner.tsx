'use client'

import { formatSyncAge } from '@/app/lib/sync'
import { backupStale } from '@/app/lib/backup'

/**
 * Dashboard alert shown when the database hasn't been backed up in over two
 * weeks (or ever). Backups run weekly on the Mac (sync/backup) and report to
 * /api/backup-status; if that pipeline silently stops, this makes it obvious
 * instead of the user discovering it only when they need a restore. Clears
 * automatically once the next successful backup lands (route revalidates `/`).
 */
export function BackupStatusBanner({ lastSuccessAt }: { lastSuccessAt: string | null }) {
  if (!backupStale(lastSuccessAt)) return null

  return (
    <div
      role="alert"
      className="rounded-lg border border-[var(--negative)]/40 bg-[var(--negative)]/10 px-4 py-3"
    >
      <p className="text-sm font-semibold text-[var(--negative)]">
        ⚠️ {lastSuccessAt ? 'Backup is overdue' : 'No backup yet'}
      </p>
      <p className="mt-1 text-xs text-[var(--muted)]">
        {lastSuccessAt ? (
          <>
            Last successful backup was{' '}
            <span
              className="font-medium text-[var(--foreground)]"
              title={new Date(lastSuccessAt).toLocaleString()}
            >
              {formatSyncAge(lastSuccessAt)} ago
            </span>
            . The weekly backup may have stopped — run{' '}
            <code className="text-[var(--foreground)]">npm run backup</code> to back up now.
          </>
        ) : (
          <>
            Your data has never been backed up to Google Drive. Run{' '}
            <code className="text-[var(--foreground)]">npm run backup</code> (or wait for the
            weekly job) to create the first backup.
          </>
        )}
      </p>
    </div>
  )
}
