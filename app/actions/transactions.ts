'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { and, eq, ilike, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { transactions, merchants, categories, merchantAmountRules, transferReviews } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'

function revalidateAll() {
  revalidatePath('/')
  revalidatePath('/trends')
  revalidatePath('/transactions')
  revalidatePath('/income')
  revalidatePath('/budget')
  revalidatePath('/custom')
  revalidatePath('/merchants')
  revalidatePath('/goals')
}

// Catch-all bank labels that are never the same purchase twice — teaching them
// at the merchant level would wrongly recategorize every unrelated transfer.
const AMBIGUOUS_MERCHANTS = ['E-Transfer Out', 'Bank Withdrawal', 'Cheque Withdrawal']

/**
 * Set a category by teaching it at the merchant level, then clearing all
 * per-transaction overrides for that merchant so every transaction (past and
 * future) inherits the merchant's category automatically.
 *
 * Exception: ambiguous catch-all bank labels (E-Transfer Out, Bank Withdrawal,
 * Cheque Withdrawal) are never taught at the merchant level — each transfer is
 * its own thing, so only the specific transaction is updated.
 */
export async function setTxnCategory(
  txnId: number,
  merchantId: number,
  categoryId: number | null
): Promise<void> {
  await requireAuth()
  const [merchant] = await db
    .select({ name: merchants.name })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1)
  if (merchant && AMBIGUOUS_MERCHANTS.includes(merchant.name)) {
    await db.update(transactions).set({ categoryId }).where(eq(transactions.id, txnId))
  } else {
    await db.update(merchants).set({ categoryId }).where(eq(merchants.id, merchantId))
    await db
      .update(transactions)
      .set({ categoryId: null })
      .where(eq(transactions.merchantId, merchantId))
  }
  revalidateAll()
}

/**
 * Override a single transaction's money-flow (expense / income / transfer) — the
 * manual fix for a mis-pressed dashboard transfer review, from the Activity row
 * editor. Setting `transfer` also moves the row into the neutral `Transfer`
 * category so it stays coherent and drops out of spend analytics, the Income page,
 * the runway burn and the safe-to-move schedule — while the Emergency Fund still
 * moves the account balance (it ignores flow). `expense`/`income` only change the
 * flow; use the category picker to fix the category if needed.
 */
export async function setTxnFlow(id: number, flow: 'expense' | 'income' | 'transfer'): Promise<void> {
  await requireAuth()
  if (flow === 'transfer') {
    const [tc] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.name, 'Transfer'))
      .limit(1)
    await db.update(transactions).set({ flow, categoryId: tc?.id ?? null }).where(eq(transactions.id, id))
  } else {
    await db.update(transactions).set({ flow }).where(eq(transactions.id, id))
  }
  revalidateAll()
}

/**
 * Per-transaction flag overrides. Tri-state: true / false force a value,
 * null clears the override and falls back to the merchant default.
 *
 * Marking or un-marking a transaction as recurring (↻ Subscription) teaches
 * it at the merchant level instead — like `setTxnCategory` — so every other
 * charge from the same merchant (past and future) flips too, rather than
 * only the one transaction clicked.
 */
export async function setTxnFlags(
  id: number,
  merchantId: number,
  flags: { isRecurring?: boolean | null; isSpecial?: boolean | null }
): Promise<void> {
  await requireAuth()
  if (flags.isRecurring === true || flags.isRecurring === false) {
    await db
      .update(merchants)
      .set({ defaultRecurring: flags.isRecurring })
      .where(eq(merchants.id, merchantId))
    await db
      .update(transactions)
      .set({ isRecurring: null })
      .where(eq(transactions.merchantId, merchantId))
  } else {
    await db.update(transactions).set(flags).where(eq(transactions.id, id))
  }
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
/**
 * Create or update an amount rule for this transaction's merchant+amount, saving
 * the current category and note so future imports of the same amount from the same
 * merchant are auto-filled. Passing `note` here also updates the transaction itself
 * so clicking "Remember" doubles as saving the note.
 */
export async function upsertAmountRule(txnId: number, note: string | null): Promise<void> {
  await requireAuth()
  const [txn] = await db
    .select({ merchantId: transactions.merchantId, amount: transactions.amount, categoryId: transactions.categoryId })
    .from(transactions)
    .where(eq(transactions.id, txnId))
    .limit(1)
  if (!txn) return
  const cleanNote = note?.trim() || null
  await db.update(transactions).set({ note: cleanNote }).where(eq(transactions.id, txnId))
  await db
    .insert(merchantAmountRules)
    .values({ merchantId: txn.merchantId, amount: txn.amount, categoryId: txn.categoryId, note: cleanNote })
    .onConflictDoUpdate({
      target: [merchantAmountRules.merchantId, merchantAmountRules.amount],
      set: { categoryId: txn.categoryId, note: cleanNote },
    })
  // A remembered merchant+amount is already decided — dismiss any pending
  // "what was this for?" prompts queued for matching transactions.
  const matching = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.merchantId, txn.merchantId), eq(transactions.amount, txn.amount)))
  if (matching.length > 0) {
    await db
      .update(transferReviews)
      .set({ status: 'dismissed' })
      .where(
        and(
          inArray(transferReviews.transactionId, matching.map((m) => m.id)),
          eq(transferReviews.status, 'pending')
        )
      )
  }
  revalidateAll()
}

/** Remove the amount rule for this transaction's merchant+amount. */
export async function deleteAmountRule(txnId: number): Promise<void> {
  await requireAuth()
  const [txn] = await db
    .select({ merchantId: transactions.merchantId, amount: transactions.amount })
    .from(transactions)
    .where(eq(transactions.id, txnId))
    .limit(1)
  if (!txn) return
  await db
    .delete(merchantAmountRules)
    .where(and(eq(merchantAmountRules.merchantId, txn.merchantId), eq(merchantAmountRules.amount, txn.amount)))
  revalidateAll()
}

/** Persist a free-text note on a single transaction (display-only, no analytics impact). */
export async function setTxnNote(id: number, note: string | null): Promise<void> {
  await requireAuth()
  await db.update(transactions).set({ note: note?.trim() || null }).where(eq(transactions.id, id))
  revalidateAll()
}

/**
 * Dismiss one or more transactions from the dashboard "needs categorizing"
 * banner. Persisted server-side so the dismissal syncs across every device,
 * unlike the old per-browser localStorage flag.
 */
export async function dismissCategorizePrompts(ids: number[]): Promise<void> {
  await requireAuth()
  if (ids.length === 0) return
  await db
    .update(transactions)
    .set({ categorizeDismissed: true })
    .where(inArray(transactions.id, ids))
  revalidatePath('/')
}

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
