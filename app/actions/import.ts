'use server'

import { revalidatePath } from 'next/cache'
import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import {
  transactions,
  merchants,
  merchantRules,
  categories,
  importBatches,
} from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { parseStatement, type CardSource, type ParsedRow } from '@/app/lib/csv'
import { normalizeKey, prettify, masterCategoryFor } from '@/app/lib/normalize'

export type ImportResult =
  | { ok: true; source: CardSource; inserted: number; skipped: number; period: string }
  | { ok: false; error: string }

type ContainsRule = { pattern: string; merchantId: number; priority: number }

/** Resolve every row to a merchant id, creating merchants/rules as needed. */
async function resolveMerchants(rows: ParsedRow[]): Promise<Map<number, number>> {
  // Load existing rules + categories once.
  const rules = await db
    .select({
      pattern: merchantRules.pattern,
      matchType: merchantRules.matchType,
      merchantId: merchantRules.merchantId,
      priority: merchantRules.priority,
    })
    .from(merchantRules)

  const exactMap = new Map<string, number>()
  const containsRules: ContainsRule[] = []
  for (const r of rules) {
    if (r.matchType === 'exact_key') exactMap.set(r.pattern, r.merchantId)
    else containsRules.push({ pattern: r.pattern, merchantId: r.merchantId, priority: r.priority })
  }
  // Most specific first: higher priority, then longer pattern.
  containsRules.sort((a, b) => b.priority - a.priority || b.pattern.length - a.pattern.length)

  const catRows = await db.select().from(categories)
  const catId = new Map(catRows.map((c) => [c.name, c.id]))

  const matchContains = (key: string): number | undefined => {
    for (const rule of containsRules) {
      if (key.includes(rule.pattern)) return rule.merchantId
    }
    return undefined
  }

  // rowIndex -> merchantId
  const result = new Map<number, number>()

  for (let i = 0; i < rows.length; i++) {
    const key = normalizeKey(rows[i].rawDescription)
    let merchantId = exactMap.get(key) ?? matchContains(key)

    if (merchantId === undefined) {
      const categoryName = masterCategoryFor(rows[i].rawCategory)
      const [created] = await db
        .insert(merchants)
        .values({
          name: prettify(key) || rows[i].rawDescription,
          categoryId: categoryName ? catId.get(categoryName) ?? null : null,
        })
        .returning({ id: merchants.id })
      merchantId = created.id
      await db.insert(merchantRules).values({
        pattern: key,
        matchType: 'exact_key',
        merchantId,
      })
      // Make it visible to later rows in this same batch.
      exactMap.set(key, merchantId)
    }
    result.set(i, merchantId)
  }
  return result
}

export async function importCsv(formData: FormData): Promise<ImportResult> {
  await requireAuth()

  const file = formData.get('file')
  const expectedRaw = formData.get('source')
  const expected =
    expectedRaw === 'master' || expectedRaw === 'amex' ? (expectedRaw as CardSource) : undefined

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Please choose a CSV file.' }
  }

  const text = await file.text()
  const result = await ingestStatement(text, file.name, expected)

  if (result.ok) {
    revalidatePath('/')
    revalidatePath('/trends')
    revalidatePath('/merchants')
    revalidatePath('/transactions')
  }
  return result
}

/**
 * Core ingest: parse -> resolve merchants -> dedup insert -> record batch.
 * No auth / no revalidate so it is reusable (e.g. in scripts/tests). The
 * importCsv action wraps this with auth + cache revalidation.
 */
export async function ingestStatement(
  text: string,
  filename: string,
  expected?: CardSource
): Promise<ImportResult> {
  let parsed
  try {
    parsed = parseStatement(text, expected)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not parse the file.' }
  }

  const { source, rows } = parsed
  if (rows.length === 0) {
    return { ok: false, error: 'No usable rows found in the file.' }
  }

  // Period label = latest transaction month in the file.
  const period = rows.map((r) => r.txnDate).sort().at(-1)!.slice(0, 7)

  const merchantByRow = await resolveMerchants(rows)

  const [batch] = await db
    .insert(importBatches)
    .values({
      source,
      filename,
      periodLabel: period,
      rowCount: rows.length,
    })
    .returning({ id: importBatches.id })

  const values = rows.map((r, i) => ({
    source: r.source,
    externalId: r.externalId,
    txnDate: r.txnDate,
    postedDate: r.postedDate,
    rawDescription: r.rawDescription,
    merchantId: merchantByRow.get(i)!,
    amount: r.amount.toFixed(2),
    rawCategory: r.rawCategory,
    cardLast4: r.cardLast4,
    country: r.country,
    isPayment: r.isPayment,
    batchId: batch.id,
  }))

  // Bulk insert; duplicates (same external_id) are skipped idempotently.
  const inserted = await db
    .insert(transactions)
    .values(values)
    .onConflictDoNothing({ target: transactions.externalId })
    .returning({ id: transactions.id })

  const insertedCount = inserted.length
  const skippedCount = rows.length - insertedCount

  await db
    .update(importBatches)
    .set({ insertedCount, skippedCount })
    .where(eq(importBatches.id, batch.id))

  return { ok: true, source, inserted: insertedCount, skipped: skippedCount, period }
}

/** Undo an import: delete its transactions and the batch record. */
export async function deleteBatch(batchId: number): Promise<void> {
  await requireAuth()
  await db.delete(transactions).where(eq(transactions.batchId, batchId))
  await db.delete(importBatches).where(eq(importBatches.id, batchId))
  revalidatePath('/')
  revalidatePath('/trends')
  revalidatePath('/merchants')
  revalidatePath('/transactions')
}

/** Used by the merchants page to offer a "clean up empty merchants" path. */
export async function pruneEmptyMerchants(): Promise<void> {
  await requireAuth()
  const used = await db
    .selectDistinct({ merchantId: transactions.merchantId })
    .from(transactions)
  const usedIds = new Set(used.map((u) => u.merchantId))
  const all = await db.select({ id: merchants.id }).from(merchants)
  const orphanIds = all.map((m) => m.id).filter((id) => !usedIds.has(id))
  if (orphanIds.length) {
    await db.delete(merchants).where(inArray(merchants.id, orphanIds))
  }
  revalidatePath('/merchants')
}
