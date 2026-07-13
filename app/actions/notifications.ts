'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db'
import { notificationSeen } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { isDemoSession } from '@/app/lib/demo'

/**
 * Signature of the problem set last acknowledged via the NotificationBell
 * (null if never acknowledged). Single-row table; see schema comment.
 */
export async function loadNotificationSeenSig(): Promise<string | null> {
  if (await isDemoSession()) return null
  const rows = await db.select().from(notificationSeen).limit(1)
  return rows[0]?.signature ?? null
}

/** Mark the current problem set as seen (called when the panel is opened). */
export async function markNotificationsSeen(signature: string): Promise<void> {
  await requireAuth()
  if (await isDemoSession()) return
  const rows = await db.select({ id: notificationSeen.id }).from(notificationSeen).limit(1)
  if (rows.length > 0) {
    await db.update(notificationSeen).set({ signature, seenAt: new Date() })
  } else {
    await db.insert(notificationSeen).values({ signature })
  }
  revalidatePath('/')
}
