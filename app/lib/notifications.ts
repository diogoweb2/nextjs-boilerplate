/**
 * Shared shape + fingerprint for the header NotificationBell. `signature` is
 * what gets persisted (notification_seen table) when the owner opens the
 * panel: it covers ids, titles and detail lines, so any new problem — or a
 * change in an existing one (e.g. failure count climbing) — produces a new
 * signature and re-shows the badge.
 */
export type NotificationItem = {
  id: string
  severity: 'error' | 'warning'
  title: string
  lines?: string[]
  /** 'digest-retry' renders a Retry button that re-runs the daily digest. */
  kind?: 'digest-retry'
}

export function notificationSignature(items: NotificationItem[]): string {
  return items.map((i) => `${i.id}|${i.title}|${(i.lines ?? []).join(';')}`).join('\n')
}
