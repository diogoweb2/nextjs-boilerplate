'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { subscriptionAlertDismissals, subscriptionRenewalDismissals } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { isDemoSession } from '@/app/lib/demo'
import type { AlertDismissal } from '@/app/lib/subscription-watch'
import type { RenewalDismissal } from '@/app/lib/renewal-watch'

/** All "not a real increase" dismissals, for the watchdog (see §18). */
export async function loadAlertDismissals(): Promise<AlertDismissal[]> {
  if (await isDemoSession()) return []
  const rows = await db.select().from(subscriptionAlertDismissals)
  return rows.map((r) => ({
    merchantId: r.merchantId,
    sinceYm: r.sinceYm,
    amount: Number(r.amount),
  }))
}

/**
 * Mark a subscription price-change alert as spurious ("not a real increase").
 * Keyed to the exact change (merchant + month + flagged amount) so a genuine
 * later change still alerts. One row per merchant — re-dismissing a newer change
 * overwrites the old signature.
 */
export async function dismissSubscriptionAlert(
  merchantId: number,
  sinceYm: string,
  amount: number
): Promise<void> {
  await requireAuth()
  await db
    .insert(subscriptionAlertDismissals)
    .values({ merchantId, sinceYm, amount: amount.toFixed(2) })
    .onConflictDoUpdate({
      target: subscriptionAlertDismissals.merchantId,
      set: { sinceYm, amount: amount.toFixed(2), createdAt: new Date() },
    })
  revalidatePath('/')
  revalidatePath('/reports')
  revalidatePath('/reports/subscriptions')
}

/** Undo a dismissal — the alert reappears if the change still stands. */
export async function undismissSubscriptionAlert(merchantId: number): Promise<void> {
  await requireAuth()
  await db
    .delete(subscriptionAlertDismissals)
    .where(eq(subscriptionAlertDismissals.merchantId, merchantId))
  revalidatePath('/')
  revalidatePath('/reports')
  revalidatePath('/reports/subscriptions')
}

/** Dismissed annual-renewal warnings, for the renewal watchdog (see §18b). */
export async function loadRenewalDismissals(): Promise<RenewalDismissal[]> {
  if (await isDemoSession()) return []
  const rows = await db.select().from(subscriptionRenewalDismissals)
  return rows.map((r) => ({ merchantId: r.merchantId, renewalYm: r.renewalYm }))
}

/**
 * Dismiss an "annual subscription renews soon" warning. Keyed to the renewal
 * cycle (merchant + renewal month) so next year's renewal warns again. One row
 * per merchant — dismissing a newer cycle overwrites the old signature.
 */
export async function dismissRenewalWarning(
  merchantId: number,
  renewalYm: string
): Promise<void> {
  await requireAuth()
  await db
    .insert(subscriptionRenewalDismissals)
    .values({ merchantId, renewalYm })
    .onConflictDoUpdate({
      target: subscriptionRenewalDismissals.merchantId,
      set: { renewalYm, createdAt: new Date() },
    })
  revalidatePath('/')
}
