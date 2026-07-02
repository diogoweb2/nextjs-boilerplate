'use server'

import { revalidatePath } from 'next/cache'
import { eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '@/db'
import { merchants, merchantRules, transactions } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { normalizeKey } from '@/app/lib/normalize'

function revalidateAll() {
  revalidatePath('/')
  revalidatePath('/trends')
  revalidatePath('/merchants')
  revalidatePath('/transactions')
}

export async function renameMerchant(id: number, name: string): Promise<void> {
  await requireAuth()
  const trimmed = name.trim()
  if (!trimmed) return
  await db.update(merchants).set({ name: trimmed }).where(eq(merchants.id, id))
  revalidateAll()
}

export async function setMerchantCategory(
  id: number,
  categoryId: number | null
): Promise<void> {
  await requireAuth()
  await db.update(merchants).set({ categoryId }).where(eq(merchants.id, id))
  revalidateAll()
}

export async function setMerchantFlags(
  id: number,
  flags: { defaultRecurring?: boolean; defaultSpecial?: boolean; recurringAnnual?: boolean }
): Promise<void> {
  await requireAuth()
  await db.update(merchants).set(flags).where(eq(merchants.id, id))
  revalidateAll()
}

/**
 * Merge several merchants into one canonical merchant. Repoints transactions
 * and rules, then deletes the losers. Future imports of the losers' patterns
 * now resolve to the winner.
 */
export async function mergeMerchants(
  winnerId: number,
  loserIds: number[]
): Promise<void> {
  await requireAuth()
  const losers = loserIds.filter((id) => id !== winnerId)
  if (losers.length === 0) return
  await db
    .update(transactions)
    .set({ merchantId: winnerId })
    .where(inArray(transactions.merchantId, losers))
  await db
    .update(merchantRules)
    .set({ merchantId: winnerId })
    .where(inArray(merchantRules.merchantId, losers))
  await db.delete(merchants).where(inArray(merchants.id, losers))
  revalidateAll()
}

export async function getMerchantMonthlySpend(
  merchantId: number
): Promise<{ label: string; total: number }[]> {
  await requireAuth()
  const rows = await db
    .select({
      label: sql<string>`to_char(${transactions.txnDate}, 'YYYY-MM')`,
      total: sql<string>`coalesce(sum(${transactions.amount}), 0)`,
    })
    .from(transactions)
    .where(eq(transactions.merchantId, merchantId))
    .groupBy(sql`to_char(${transactions.txnDate}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${transactions.txnDate}, 'YYYY-MM')`)
  return rows.map((r) => ({ label: r.label, total: Number(r.total) }))
}

/**
 * Teach a grouping by substring: "anything whose key contains <pattern> is this
 * merchant". Adds a persistent rule AND retroactively repoints existing matching
 * transactions so the change is visible immediately.
 */
export async function addContainsRule(
  merchantId: number,
  patternRaw: string
): Promise<void> {
  await requireAuth()
  const pattern = patternRaw.trim().toLowerCase()
  if (!pattern) return

  await db.insert(merchantRules).values({
    pattern,
    matchType: 'contains',
    merchantId,
    priority: pattern.length,
  })

  // Retroactively apply to existing transactions on other merchants.
  const candidates = await db
    .select({ id: transactions.id, raw: transactions.rawDescription })
    .from(transactions)
    .where(ne(transactions.merchantId, merchantId))
  const toMove = candidates
    .filter((t) => normalizeKey(t.raw).includes(pattern))
    .map((t) => t.id)
  if (toMove.length) {
    await db
      .update(transactions)
      .set({ merchantId })
      .where(inArray(transactions.id, toMove))
  }
  revalidateAll()
}
