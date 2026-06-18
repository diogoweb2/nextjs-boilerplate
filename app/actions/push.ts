'use server'

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { pushSubscriptions } from '@/db/schema'

/**
 * Subscription CRUD for Web Push, called from the client PushToggle. These run
 * behind the app's session auth (proxy.ts), so no extra token is needed — only a
 * logged-in browser can register or remove its own subscription.
 */

export type PushSubscriptionInput = {
  endpoint: string
  p256dh: string
  auth: string
  userAgent?: string
}

export async function savePushSubscription(sub: PushSubscriptionInput): Promise<void> {
  if (!sub.endpoint || !sub.p256dh || !sub.auth) return
  await db
    .insert(pushSubscriptions)
    .values({
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      userAgent: sub.userAgent ?? null,
    })
    // Re-subscribing returns the same endpoint with rotated keys — keep them fresh.
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { p256dh: sub.p256dh, auth: sub.auth, userAgent: sub.userAgent ?? null },
    })
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  if (!endpoint) return
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))
}
