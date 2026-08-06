/**
 * Planned splits — the "future custom import" rules (BUSINESS_RULES.md §22).
 *
 * The owner declares, before the charge posts, that the next Metro purchase over
 * $500 really contains a $500 Amazon gift card. The daily import then carves it
 * out automatically, so the money never sits in the wrong category waiting to be
 * fixed by hand.
 *
 * This module is deliberately auth-free: the importer runs from the cron/API
 * token path (`app/api/ingest`) where there is no cookie session. The Server
 * Actions in `app/actions/planned-splits.ts` wrap the CRUD with `requireAuth`.
 *
 * The goal-spend half is written here rather than calling `spendFromGoal` for
 * the same reason (that action is auth-gated). It writes the identical ledger
 * pair — a negative `contribution` plus an offsetting `manual`/`income` row —
 * so undo from the Activity row still works. The only thing it skips is the
 * optional per-goal push notification.
 */

import { randomUUID } from 'node:crypto'
import { and, asc, eq, ilike, inArray } from 'drizzle-orm'
import { db } from '@/db'
import {
  plannedSplits,
  transactions,
  merchants,
  categories,
  goals,
  goalEntries,
} from '@/db/schema'
import { savingsValue } from '@/app/lib/goals'

/** A rule matches a charge at or above this; defaults to the split amount. */
function threshold(rule: { minAmount: string | null; splitAmount: string }): number {
  const min = rule.minAmount != null ? Number(rule.minAmount) : NaN
  return Number.isFinite(min) && min > 0 ? min : Number(rule.splitAmount)
}

/**
 * Reduce a goal by `amount` and post the offsetting income row against
 * `spentOnTransactionId` — the same shape `spendFromGoal` writes. Capped at what
 * the goal actually holds; a non-savings/empty goal is a no-op.
 */
async function payFromGoal(input: {
  goalId: number
  amount: number
  occurredAt: string
  categoryId: number | null
  note: string
  spentOnTransactionId: number
}): Promise<void> {
  const [goal] = await db.select().from(goals).where(eq(goals.id, input.goalId)).limit(1)
  if (!goal || goal.kind !== 'savings') return

  const entries = await db
    .select({ kind: goalEntries.kind, amount: goalEntries.amount, occurredAt: goalEntries.occurredAt })
    .from(goalEntries)
    .where(eq(goalEntries.goalId, goal.id))
  const value = savingsValue(
    entries.map((e) => ({ kind: e.kind, amount: Number(e.amount), occurredAt: e.occurredAt }))
  )
  if (value <= 0) return
  const amount = Math.min(Math.round(input.amount * 100) / 100, value)
  if (amount <= 0) return

  const [goalSpendCat] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, 'Goal Spend'))
    .limit(1)
  const categoryId = input.categoryId ?? goalSpendCat?.id ?? null

  let [payee] = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(ilike(merchants.name, 'Goal Withdrawal'))
    .limit(1)
  if (!payee) {
    ;[payee] = await db
      .insert(merchants)
      .values({ name: 'Goal Withdrawal', categoryId: goalSpendCat?.id ?? null })
      .returning({ id: merchants.id })
  }

  const [offset] = await db
    .insert(transactions)
    .values({
      source: 'manual',
      flow: 'income',
      categoryId,
      externalId: `goal:${goal.id}:spend:${randomUUID().slice(0, 8)}`,
      txnDate: input.occurredAt,
      rawDescription: `Goal spend — ${goal.name}`,
      merchantId: payee.id,
      // Income is stored negative (money in); see the sign convention.
      amount: (-amount).toFixed(2),
    })
    .returning({ id: transactions.id })

  await db.insert(goalEntries).values({
    goalId: goal.id,
    kind: 'contribution',
    amount: (-amount).toFixed(2),
    transactionId: offset.id,
    spentOnTransactionId: input.spentOnTransactionId,
    occurredAt: input.occurredAt,
    note: input.note.slice(0, 200),
  })
}

/**
 * Credit a gift card with the carved-off amount and flip that row to an internal
 * transfer — the auth-free mirror of `loadGiftCard` (BUSINESS_RULES.md §10c).
 * Buying stored value inside a grocery bill is exactly the case planned splits
 * were written for, so the rule can finish the job: the $500 leaves spending now
 * and comes back, categorised, when the card is actually used.
 */
async function loadOntoGiftCard(input: {
  goal: { id: number; name: string }
  amount: number
  occurredAt: string
  transactionId: number
  note: string
}): Promise<void> {
  const amount = Math.round(input.amount * 100) / 100
  if (!(amount > 0)) return
  await db.update(transactions).set({ flow: 'transfer' }).where(eq(transactions.id, input.transactionId))
  await db.insert(goalEntries).values({
    goalId: input.goal.id,
    kind: 'contribution',
    amount: amount.toFixed(2),
    transactionId: input.transactionId,
    occurredAt: input.occurredAt,
    note: input.note.slice(0, 200),
  })
}

/**
 * Apply every pending planned split against the transactions just inserted.
 * Called at the end of `ingestStatement`, so both the manual upload and the
 * nightly sync go through it. Each rule fires at most once (the oldest matching
 * charge wins) and then flips to 'applied'.
 *
 * Several rules CAN land on the same charge — one bill often hides more than one
 * thing (a $100 gift card *and* a $30 shirt inside the Metro run). Rules are
 * applied oldest-first, each peeling its amount off what the charge has left, so
 * the parent shrinks once per rule and the totals still add up.
 */
export async function applyPlannedSplits(insertedIds: number[]): Promise<void> {
  if (insertedIds.length === 0) return
  const rules = await db
    .select()
    .from(plannedSplits)
    .where(eq(plannedSplits.status, 'pending'))
    .orderBy(asc(plannedSplits.createdAt))
  if (rules.length === 0) return

  const rows = await db
    .select({
      id: transactions.id,
      txnDate: transactions.txnDate,
      amount: transactions.amount,
      flow: transactions.flow,
      isPayment: transactions.isPayment,
      externalId: transactions.externalId,
      postedDate: transactions.postedDate,
      rawDescription: transactions.rawDescription,
      rawCategory: transactions.rawCategory,
      cardLast4: transactions.cardLast4,
      country: transactions.country,
      batchId: transactions.batchId,
      source: transactions.source,
      merchantId: transactions.merchantId,
      merchantName: merchants.name,
    })
    .from(transactions)
    .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
    .where(inArray(transactions.id, insertedIds))

  const candidates = rows
    .filter((r) => r.flow === 'expense' && !r.isPayment && Number(r.amount) > 0)
    .sort((a, b) => a.txnDate.localeCompare(b.txnDate))

  // What each charge still has left after earlier rules peeled their parts off,
  // so two rules on the same bill each take their own slice.
  const left = new Map<number, number>(candidates.map((r) => [r.id, Number(r.amount)]))

  for (const rule of rules) {
    const split = Number(rule.splitAmount)
    if (!(split > 0)) continue
    const min = threshold(rule)
    const wanted = rule.merchantLabel.trim().toLowerCase()

    const match = candidates.find((r) => {
      const sameMerchant =
        rule.merchantId != null
          ? r.merchantId === rule.merchantId
          : r.merchantName.trim().toLowerCase() === wanted
      if (!sameMerchant) return false
      // The "only if more than" floor reads the charge as it was imported; what
      // is still available to peel off is what's left after earlier rules.
      if (Number(r.amount) < min - 0.005) return false
      const available = left.get(r.id) ?? 0
      // A charge already partly split must keep a remainder — only a whole,
      // untouched charge can be consumed exactly (relabelled in place below).
      const untouched = Math.abs(available - Number(r.amount)) < 0.005
      return untouched ? available >= split - 0.005 : available - split > 0.0049
    })
    if (!match) continue

    const total = left.get(match.id)!
    const remainder = Math.round((total - split) * 100) / 100
    left.set(match.id, remainder)

    let targetId: number
    if (remainder <= 0.0049) {
      // The whole charge WAS the planned purchase — relabel it in place; a split
      // has to leave a remainder on the original.
      await db
        .update(transactions)
        .set({ categoryId: rule.categoryId, note: rule.label })
        .where(eq(transactions.id, match.id))
      targetId = match.id
    } else {
      // Peel the planned amount off into its own child row, reusing a merchant
      // with that name when one exists (no merchant_rule — this stays a one-off).
      let merchantId = match.merchantId
      const [existing] = await db
        .select({ id: merchants.id })
        .from(merchants)
        .where(ilike(merchants.name, rule.label))
        .limit(1)
      if (existing) {
        merchantId = existing.id
      } else {
        const [created] = await db
          .insert(merchants)
          .values({ name: rule.label, categoryId: rule.categoryId })
          .returning({ id: merchants.id })
        merchantId = created.id
      }

      const [child] = await db
        .insert(transactions)
        .values({
          source: match.source,
          flow: 'expense',
          externalId: `${match.externalId}:split:${randomUUID().slice(0, 8)}`,
          txnDate: match.txnDate,
          postedDate: match.postedDate,
          rawDescription: match.rawDescription,
          merchantId,
          categoryId: rule.categoryId,
          amount: split.toFixed(2),
          rawCategory: match.rawCategory,
          cardLast4: match.cardLast4,
          country: match.country,
          isPayment: false,
          batchId: match.batchId,
          splitParentId: match.id,
          note: rule.label,
        })
        .returning({ id: transactions.id })

      await db
        .update(transactions)
        .set({ amount: remainder.toFixed(2) })
        .where(eq(transactions.id, match.id))
      targetId = child.id
    }

    if (rule.goalId != null) {
      const [goal] = await db.select().from(goals).where(eq(goals.id, rule.goalId)).limit(1)
      if (goal?.kind === 'giftcard') {
        // Stored value: credit the card and take the row out of spending, rather
        // than spending savings that were never set aside for it (§10c).
        await loadOntoGiftCard({
          goal,
          amount: split,
          occurredAt: match.txnDate,
          transactionId: targetId,
          note: `Loaded from ${rule.label}`,
        })
      } else {
        await payFromGoal({
          goalId: rule.goalId,
          amount: split,
          occurredAt: match.txnDate,
          categoryId: rule.categoryId,
          note: `Paid ${rule.label}`,
          spentOnTransactionId: targetId,
        })
      }
    }

    await db
      .update(plannedSplits)
      .set({ status: 'applied', appliedAt: new Date(), appliedTransactionId: targetId })
      .where(and(eq(plannedSplits.id, rule.id), eq(plannedSplits.status, 'pending')))
  }
}

/** A rule pending this long without a match is reported as "it never fired". */
export const PLANNED_SPLIT_STALE_DAYS = 7

export function daysSince(iso: Date): number {
  return Math.floor((Date.now() - iso.getTime()) / 86_400_000)
}
