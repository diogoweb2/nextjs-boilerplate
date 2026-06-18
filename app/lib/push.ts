import 'server-only'
import webpush from 'web-push'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { pushSubscriptions } from '@/db/schema'

/**
 * Web Push sender for the daily digest. The VAPID private key signs every push
 * and must stay server-only; the matching public key (NEXT_PUBLIC_VAPID_PUBLIC_KEY)
 * is what the browser subscribes with. See app/components/PushToggle.tsx +
 * public/sw.js for the client/service-worker side.
 */

export function pushConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
}

let configured = false
function configure(): void {
  if (configured) return
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) throw new Error('VAPID keys are not configured.')
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:budget@example.com', publicKey, privateKey)
  configured = true
}

export type PushPayload = { title: string; body: string; url?: string }

/**
 * Send one notification to every stored subscription. Subscriptions the push
 * service reports as gone (404/410 — browser uninstalled / permission revoked)
 * are pruned so the table self-cleans.
 */
export async function sendPushToAll(payload: PushPayload): Promise<{ sent: number; failed: number }> {
  configure()
  const subs = await db.select().from(pushSubscriptions)
  const json = JSON.stringify(payload)
  let sent = 0
  let failed = 0

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          json
        )
        sent++
      } catch (err) {
        failed++
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, s.endpoint))
        }
      }
    })
  )

  return { sent, failed }
}
