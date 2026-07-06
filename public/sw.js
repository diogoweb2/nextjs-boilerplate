/**
 * Service worker for the budget digest Web Push notifications.
 *
 * Receives the push the server sends (app/lib/push.ts) and shows it even when no
 * tab is open. On Android the notification persists in the shade until tapped;
 * tapping focuses an existing tab or opens the dashboard.
 */
// Take control of already-open tabs as soon as a new worker activates. Without
// this, tabs loaded before the worker installed stay *uncontrolled*, and
// client.navigate() below silently rejects on them — so a notification tap just
// re-focuses whatever page that tab was on (e.g. /settings) instead of the URL
// in the push. skipWaiting + claim also means an updated sw.js takes over right
// away rather than after every tab closes.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// Chrome only treats the app as installable (and fires beforeinstallprompt /
// shows the install button) once the service worker has a fetch handler. We
// don't cache anything — this just passes every request straight to the
// network so the install prompt becomes available.
self.addEventListener('fetch', () => {})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Budget', body: event.data ? event.data.text() : '' }
  }

  const title = data.title || 'Budget'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png', // large app artwork shown in the notification
      badge: '/badge.png', // small glyph in the Android status bar
      tag: 'budget-digest', // collapse repeats into one entry
      renotify: true,
      requireInteraction: true, // stay until tapped (no 3s auto-dismiss)
      data: { url: data.url || '/' },
    })
  )
})

// Mobile browsers rotate/expire the push subscription on their own (memory
// pressure, browser updates, GCM key rotation) — far more often than tablets.
// When that happens the server prunes the dead endpoint (410) and the device
// would go silent forever. Re-subscribe transparently: grab the VAPID public
// key from the app, subscribe again, and store the fresh subscription.
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch('/api/push-resubscribe')
      const { publicKey } = await res.json()
      if (!publicKey) return
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
      await fetch('/api/push-resubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      })
    })()
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of clientList) {
        if ('focus' in client) {
          // Point the existing tab at the push URL, then focus it. navigate()
          // can still reject on a client we don't control — fall back to a fresh
          // window so the tap never dead-ends on the wrong page.
          if ('navigate' in client) {
            try {
              await client.navigate(url)
              return client.focus()
            } catch {
              break
            }
          }
          return client.focus()
        }
      }
      return self.clients.openWindow(url)
    })()
  )
})
