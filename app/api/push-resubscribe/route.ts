import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { pushSubscriptions } from '@/db/schema'

/**
 * Auto-resubscribe endpoint for Web Push. Mobile browsers rotate/expire push
 * subscriptions far more aggressively than tablets — when they do, the old
 * endpoint 410s and sendPushToAll prunes it (app/lib/push.ts), and the phone
 * would otherwise go permanently silent. public/sw.js listens for the
 * `pushsubscriptionchange` event, fetches the VAPID public key here (GET), then
 * subscribes afresh and stores the new subscription (POST) — all without the
 * user reopening the app. Session-cookie authed via proxy.ts.
 */
export const dynamic = 'force-dynamic'

export function GET(): Response {
  // The SW is a static file and can't read NEXT_PUBLIC_* env at runtime; hand it
  // the key it needs to call pushManager.subscribe().
  return Response.json({ publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null })
}

export async function POST(request: NextRequest): Promise<Response> {
  const sub = (await request.json().catch(() => null)) as {
    endpoint?: string
    keys?: { p256dh?: string; auth?: string }
  } | null

  const endpoint = sub?.endpoint
  const p256dh = sub?.keys?.p256dh
  const auth = sub?.keys?.auth
  if (!endpoint || !p256dh || !auth) return new Response('Bad subscription', { status: 400 })

  await db
    .insert(pushSubscriptions)
    .values({ endpoint, p256dh, auth, userAgent: request.headers.get('user-agent') })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { p256dh, auth },
    })

  return new Response(null, { status: 204 })
}
