'use client'

import { useEffect, useState } from 'react'
import { savePushSubscription } from '@/app/actions/push'

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function subscribeDevice(): Promise<boolean> {
  if (!PUBLIC_KEY) return false
  const reg = await navigator.serviceWorker.ready
  const existing = await reg.pushManager.getSubscription()
  if (existing) return true
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(PUBLIC_KEY),
  })
  const json = sub.toJSON()
  await savePushSubscription({
    endpoint: sub.endpoint,
    p256dh: json.keys?.p256dh ?? '',
    auth: json.keys?.auth ?? '',
    userAgent: navigator.userAgent,
  })
  return true
}

/**
 * On app open, tries to auto-subscribe to push. If the browser requires a user
 * gesture (Chrome outside of installed PWA), shows a one-tap banner instead.
 * Once subscribed or denied, it disappears and never shows again.
 */
export function PushPrompt() {
  const [showBanner, setShowBanner] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !PUBLIC_KEY ||
      Notification.permission === 'denied'
    ) return

    if (Notification.permission === 'granted') {
      // Already permitted — make sure we have an active subscription.
      subscribeDevice().catch(() => {})
      return
    }

    // Try auto-requesting (works on installed PWAs; silently blocked in browser tabs).
    subscribeDevice().then((ok) => {
      if (!ok && Notification.permission !== 'denied') {
        // Browser blocked the auto-request — show the one-tap banner.
        setShowBanner(true)
      }
    }).catch(() => {
      if (Notification.permission !== 'denied') setShowBanner(true)
    })
  }, [])

  if (!showBanner) return null

  const handleEnable = async () => {
    setBusy(true)
    try {
      await subscribeDevice()
    } catch {}
    setShowBanner(false)
    setBusy(false)
  }

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 shadow-lg">
      <span className="text-sm text-[var(--foreground)]">Enable daily budget notifications</span>
      <button
        onClick={handleEnable}
        disabled={busy}
        className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-fg)] disabled:opacity-50"
      >
        {busy ? '…' : 'Enable'}
      </button>
      <button
        onClick={() => setShowBanner(false)}
        className="text-[var(--muted)] hover:text-[var(--foreground)]"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}
