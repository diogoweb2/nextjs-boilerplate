/**
 * Service worker for the budget digest Web Push notifications.
 *
 * Receives the push the server sends (app/lib/push.ts) and shows it even when no
 * tab is open. On Android the notification persists in the shade until tapped;
 * tapping focuses an existing tab or opens the dashboard.
 */
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
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: 'budget-digest', // collapse repeats into one entry
      renotify: true,
      requireInteraction: true, // stay until tapped (no 3s auto-dismiss)
      data: { url: data.url || '/' },
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(url)
          return client.focus()
        }
      }
      return self.clients.openWindow(url)
    })
  )
})
