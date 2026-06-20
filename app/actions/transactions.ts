'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { eq, ilike } from 'drizzle-orm'
import { db } from '@/db'
import { transactions, merchants } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'

function revalidateAll() {
  revalidatePath('/')
  revalidatePath('/trends')
  revalidatePath('/transactions')
  revalidatePath('/income')
  revalidatePath('/budget')
  revalidatePath('/custom')
  revalidatePath('/merchants')
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

export type SplitPart = {
  /** Always a positive magnitude; the parent's sign is reapplied. */
  amount: number
  categoryId: number | null
  /** Merchant label for this part. Reuses an existing merchant of the same
   *  name (case-insensitive) or creates a new, rule-less one so future imports
   *  are never auto-categorized to it. */
  label: string
}

/**
 * Split one transaction into the original plus one or more peeled-off parts
 * (e.g. $50 of kids' clothes inside a $200 Walmart grocery run). Each part
 * becomes its own child transaction; the parent's amount is reduced by the
 * total peeled off so the sum is unchanged and analytics never double-count.
 *
 * A part whose label matches an existing merchant reuses it; otherwise a new
 * merchant is created with no merchant_rule, so the carved-out spend stays a
 * one-off and future statements keep resolving to the original merchant.
 */
export async function splitTransaction(
  parentId: number,
  parts: SplitPart[],
): Promise<void> {
  await requireAuth()

  const clean = parts
    .map((p) => ({ ...p, amount: Math.abs(p.amount), label: p.label.trim() }))
    .filter((p) => p.amount > 0)
  if (clean.length === 0) return

  const [parent] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, parentId))
  if (!parent) throw new Error('Transaction not found')
  // Split the parent, never a child — keeps the math one level deep.
  if (parent.splitParentId) throw new Error('Cannot split a split part')

  const parentAmount = Number(parent.amount)
  const sign = parentAmount < 0 ? -1 : 1
  const peeledOff = clean.reduce((s, p) => s + p.amount, 0)
  const remainder = Math.abs(parentAmount) - peeledOff
  // The original must keep a positive remainder; to fully reassign, recategorize
  // the row instead of splitting it.
  if (remainder <= 0.0049) {
    throw new Error('Split parts must leave a remainder on the original')
  }

  for (const part of clean) {
    let merchantId = parent.merchantId
    if (part.label) {
      const [existing] = await db
        .select({ id: merchants.id })
        .from(merchants)
        .where(ilike(merchants.name, part.label))
        .limit(1)
      if (existing) {
        merchantId = existing.id
      } else {
        const [created] = await db
          .insert(merchants)
          .values({ name: part.label, categoryId: part.categoryId })
          .returning({ id: merchants.id })
        merchantId = created.id
      }
    }

    await db.insert(transactions).values({
      source: parent.source,
      flow: parent.flow,
      externalId: `${parent.externalId}:split:${randomUUID().slice(0, 8)}`,
      txnDate: parent.txnDate,
      postedDate: parent.postedDate,
      rawDescription: parent.rawDescription,
      merchantId,
      categoryId: part.categoryId,
      amount: (sign * part.amount).toFixed(2),
      rawCategory: parent.rawCategory,
      cardLast4: parent.cardLast4,
      country: parent.country,
      isPayment: parent.isPayment,
      batchId: parent.batchId,
      splitParentId: parent.id,
    })
  }

  await db
    .update(transactions)
    .set({ amount: (sign * remainder).toFixed(2) })
    .where(eq(transactions.id, parent.id))

  revalidateAll()
}

/**
 * Reverse a split: delete the parent's child parts and fold their amounts back
 * into the original. Merchants created solely for the split become orphans and
 * are cleaned up by the merchants page's existing "prune empty" path.
 */
export async function unsplitTransaction(parentId: number): Promise<void> {
  await requireAuth()
  const children = await db
    .select({ id: transactions.id, amount: transactions.amount })
    .from(transactions)
    .where(eq(transactions.splitParentId, parentId))
  if (children.length === 0) return

  const [parent] = await db
    .select({ amount: transactions.amount })
    .from(transactions)
    .where(eq(transactions.id, parentId))
  if (!parent) return

  const restored =
    Number(parent.amount) + children.reduce((s, c) => s + Number(c.amount), 0)

  await db.delete(transactions).where(eq(transactions.splitParentId, parentId))
  await db
    .update(transactions)
    .set({ amount: restored.toFixed(2) })
    .where(eq(transactions.id, parentId))

  revalidateAll()
}
