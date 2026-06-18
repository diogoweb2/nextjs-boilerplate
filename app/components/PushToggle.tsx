'use client'

import { useEffect, useState } from 'react'
import { savePushSubscription, deletePushSubscription } from '@/app/actions/push'

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY

/** VAPID public key (base64url) → Uint8Array for pushManager.subscribe. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized)
  // Back it with a concrete ArrayBuffer so the type satisfies applicationServerKey.
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

type Status = 'loading' | 'unsupported' | 'denied' | 'off' | 'on'

/** Settings toggle to enable/disable Web Push digest notifications on this device. */
export function PushToggle() {
  const [status, setStatus] = useState<Status>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !PUBLIC_KEY) {
      setStatus('unsupported')
      return
    }
    if (Notification.permission === 'denied') {
      setStatus('denied')
      return
    }
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setStatus(sub ? 'on' : 'off'))
      .catch(() => setStatus('off'))
  }, [])

  const enable = async () => {
    setBusy(true)
    setError(null)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'denied' : 'off')
        return
      }
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(PUBLIC_KEY!),
      })
      const json = sub.toJSON()
      await savePushSubscription({
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
        userAgent: navigator.userAgent,
      })
      setStatus('on')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not enable notifications.')
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setBusy(true)
    setError(null)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await deletePushSubscription(sub.endpoint)
        await sub.unsubscribe()
      }
      setStatus('off')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disable notifications.')
    } finally {
      setBusy(false)
    }
  }

  if (status === 'loading') {
    return <p className="text-sm text-[var(--muted)]">Checking notification support…</p>
  }
  if (status === 'unsupported') {
    return (
      <p className="text-sm text-[var(--muted)]">
        This browser can&apos;t receive push notifications{!PUBLIC_KEY && ' (VAPID key not configured)'}.
      </p>
    )
  }
  if (status === 'denied') {
    return (
      <p className="text-sm text-[var(--negative)]">
        Notifications are blocked for this site. Re-enable them in your browser&apos;s site settings, then reload.
      </p>
    )
  }

  const on = status === 'on'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Daily digest notifications</p>
          <p className="text-xs text-[var(--muted)]">
            {on
              ? 'On for this device — you’ll get the daily summary even with the site closed.'
              : 'Get the daily summary pushed to this device (works with the site closed).'}
          </p>
        </div>
        <button
          onClick={on ? disable : enable}
          disabled={busy}
          className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
            on
              ? 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]'
              : 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]'
          }`}
        >
          {busy ? '…' : on ? 'Turn off' : 'Enable'}
        </button>
      </div>
      {error && <p className="text-xs text-[var(--negative)]">{error}</p>}
    </div>
  )
}
