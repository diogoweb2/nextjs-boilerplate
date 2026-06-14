'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { transactions, merchants } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'

function revalidateAll() {
  revalidatePath('/')
  revalidatePath('/trends')
  revalidatePath('/transactions')
}

/**
 * Set a category by teaching it at the merchant level, then clearing all
 * per-transaction overrides for that merchant so every transaction (past and
 * future) inherits the merchant's category automatically.
 */
export async function setTxnCategory(
  _txnId: number,
  merchantId: number,
  categoryId: number | null
): Promise<void> {
  await requireAuth()
  await db.update(merchants).set({ categoryId }).where(eq(merchants.id, merchantId))
  await db
    .update(transactions)
    .set({ categoryId: null })
    .where(eq(transactions.merchantId, merchantId))
  revalidateAll()
}

/**
 * Per-transaction flag overrides. Tri-state: true / false force a value,
 * null clears the override and falls back to the merchant default.
 */
export async function setTxnFlags(
  id: number,
  flags: { isRecurring?: boolean | null; isSpecial?: boolean | null }
): Promise<void> {
  await requireAuth()
  await db.update(transactions).set(flags).where(eq(transactions.id, id))
  revalidateAll()
}
