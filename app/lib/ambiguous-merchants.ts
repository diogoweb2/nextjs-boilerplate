import { eq, inArray, and, ne, or, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { categories, merchants } from '@/db/schema'

/** Catch-all bank labels: never the same purchase twice, so never auto-categorized. */
export const AMBIGUOUS_MERCHANTS = ['E-Transfer Out', 'Bank Withdrawal', 'Cheque Withdrawal']

/**
 * Keep the merchant-level category of the catch-all labels pinned to `Other`, so a
 * transaction only gets anything else via a manual per-transaction edit or a
 * remembered amount rule (which sets the transaction's own category).
 */
export async function pinAmbiguousMerchantsToOther(): Promise<void> {
  const [other] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, 'Other'))
    .limit(1)
  if (!other) return
  await db
    .update(merchants)
    .set({ categoryId: other.id })
    .where(
      and(
        inArray(merchants.name, AMBIGUOUS_MERCHANTS),
        or(isNull(merchants.categoryId), ne(merchants.categoryId, other.id))
      )
    )
}
