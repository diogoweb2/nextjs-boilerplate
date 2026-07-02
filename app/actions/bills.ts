'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { billReminderDismissals, transactions } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { isDemoSession } from '@/app/lib/demo'
import type { BillDismissal, CcPayment } from '@/app/lib/bill-calendar'

/**
 * Bank-side payments toward tracked credit cards. They're `isPayment` rows,
 * deliberately excluded from `loadAllFlows`/analytics, but the bills calendar
 * needs them to place the "Credit card payment" pseudo-bill (§19).
 */
export async function loadCcPaymentHistory(): Promise<CcPayment[]> {
  if (await isDemoSession()) return []
  const rows = await db
    .select({ txnDate: transactions.txnDate, amount: transactions.amount })
    .from(transactions)
    .where(eq(transactions.isPayment, true))
  return rows
    .map((r) => ({ date: r.txnDate, amount: Math.abs(Number(r.amount)) }))
    .filter((r) => r.amount > 0)
}

/** Dismissed "bill due soon" reminders, for the banner builder (see §19). */
export async function loadBillDismissals(): Promise<BillDismissal[]> {
  if (await isDemoSession()) return []
  const rows = await db.select().from(billReminderDismissals)
  return rows.map((r) => ({ billKey: r.billKey, dueYm: r.dueYm }))
}

/**
 * Dismiss a "bill due soon" reminder. Keyed to the cycle (billKey + due month)
 * so next month's due date warns again. One row per bill — dismissing a newer
 * cycle overwrites the old signature.
 */
export async function dismissBillReminder(billKey: string, dueYm: string): Promise<void> {
  await requireAuth()
  await db
    .insert(billReminderDismissals)
    .values({ billKey, dueYm })
    .onConflictDoUpdate({
      target: billReminderDismissals.billKey,
      set: { dueYm, createdAt: new Date() },
    })
  revalidatePath('/')
}
