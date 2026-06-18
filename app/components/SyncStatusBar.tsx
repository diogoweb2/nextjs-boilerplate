'use client'

import { useEffect } from 'react'
import { formatSyncAge, syncStale } from '@/app/lib/sync'

type SyncEntry = { label: string; lastSync: string | null }

export function SyncStatusBar({ entries }: { entries: SyncEntry[] }) {
  useEffect(() => {
    const stale = entries.filter((e) => syncStale(e.lastSync)).map((e) => e.label)
    if (stale.length === 0 || !('Notification' in window)) return

    // Notify at most once per calendar day per set of stale sources.
    const today = new Date().toISOString().slice(0, 10)
    const key = `sync-stale-notified-${today}-${stale.join(',')}`
    if (sessionStorage.getItem(key)) return

    const fire = () => {
      sessionStorage.setItem(key, '1')
      new Notification('Budget sync stale', {
        body: `${stale.join(' & ')} ${stale.length > 1 ? 'have' : 'has'} not synced in 3+ days.`,
      })
    }

    if (Notification.permission === 'granted') {
      fire()
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') fire()
      })
    }
  }, [entries])

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
