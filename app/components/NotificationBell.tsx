'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { formatSyncAge } from '@/app/lib/sync'
import { retryDailyDigest } from '@/app/actions/digest'
import { markNotificationsSeen } from '@/app/actions/notifications'
import type { NotificationItem } from '@/app/lib/notifications'

type SyncEntry = { label: string; lastSync: string | null; failed?: boolean }

/**
 * Header notification bell that replaces the old always-visible banners/badges
 * (SyncErrorBanner, BackupStatusBanner, DigestStatusBanner, SyncStatusBar).
 * Healthy pipelines are silent; problems show as a count badge. Opening the
 * panel acknowledges the current problem set — persisted in the DB
 * (notification_seen), so acknowledging on one device clears the badge
 * everywhere — and the badge only reappears when the set changes. The panel
 * footer keeps the per-source last-sync ages and the last daily notification
 * time for reference.
 */
function DigestRetry() {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  return (
    <div className="mt-1.5">
      <button
        onClick={() => {
          setResult(null)
          startTransition(async () => setResult(await retryDailyDigest()))
        }}
        disabled={pending}
        className="rounded-lg border border-[var(--negative)]/40 px-2.5 py-1 text-xs font-medium text-[var(--negative)] transition-colors hover:bg-[var(--negative)]/10 disabled:opacity-50"
      >
        {pending ? 'Retrying…' : 'Retry'}
      </button>
      {result && (
        <p className={`mt-1.5 text-xs ${result.ok ? 'text-[var(--muted)]' : 'text-[var(--negative)]'}`}>
          {result.message}
        </p>
      )}
    </div>
  )
}

export function NotificationBell({
  items,
  unseen,
  signature,
  syncEntries,
  lastNotified,
  className = '',
}: {
  items: NotificationItem[]
  /** Server-computed: current signature differs from the acknowledged one. */
  unseen: boolean
  /** Fingerprint of `items`, persisted when the panel is opened. */
  signature: string
  syncEntries: SyncEntry[]
  lastNotified: string | null
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [ackedSig, setAckedSig] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // Hide the badge immediately on open; the DB write catches up in the
  // background and keeps other devices in sync.
  const showBadge = unseen && items.length > 0 && ackedSig !== signature

  const toggle = () => {
    if (!open && showBadge) {
      setAckedSig(signature)
      void markNotificationsSeen(signature)
    }
    setOpen((v) => !v)
  }

  return (
    <div className={`relative ${className}`} ref={panelRef}>
      <button
        onClick={toggle}
        title="Notifications"
        aria-label={`Notifications${items.length > 0 ? ` (${items.length})` : ''}`}
        className="relative rounded-lg border border-[var(--border)] p-2 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {showBadge && (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--negative)] px-1 text-[10px] font-bold text-white">
            {items.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl sm:w-96">
          <div className="max-h-96 overflow-y-auto p-3">
            {items.length === 0 ? (
              <p className="py-2 text-center text-sm text-[var(--muted)]">
                ✅ All good — syncs, backup and notifications are healthy.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {items.map((item) => (
                  <li key={item.id}>
                    <p
                      className={`text-sm font-semibold ${
                        item.severity === 'error' ? 'text-[var(--negative)]' : 'text-[var(--warning)]'
                      }`}
                    >
                      ⚠️ {item.title}
                    </p>
                    {item.lines?.map((line, i) => (
                      <p key={i} className="mt-0.5 text-xs text-[var(--muted)]">
                        {line}
                      </p>
                    ))}
                    {item.kind === 'digest-retry' && <DigestRetry />}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-t border-[var(--border)] px-3 py-2">
            <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--muted)]">
              {syncEntries.map(({ label, lastSync }) => (
                <span key={label} title={lastSync ? new Date(lastSync).toLocaleString() : 'Never synced'}>
                  {label}: {lastSync ? `${formatSyncAge(lastSync)} ago` : 'never'}
                </span>
              ))}
              <span title={lastNotified ? `Last daily notification: ${new Date(lastNotified).toLocaleString()}` : 'No daily notification sent yet'}>
                Notified: {lastNotified ? `${formatSyncAge(lastNotified)} ago` : 'never'}
              </span>
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
