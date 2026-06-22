'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, inArray, ilike } from 'drizzle-orm'
import { db } from '@/db'
import {
  transactions,
  merchants,
  merchantRules,
  categories,
  importBatches,
  goalEntries,
  transferReviews,
  syncRuns,
} from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { parseStatement, type ImportSource, type ParsedRow } from '@/app/lib/csv'
import { normalizeKey, prettify, masterCategoryFor } from '@/app/lib/normalize'
import { reconcileNetZeroGoals } from '@/app/actions/goals'

export type ImportResult =
  | { ok: true; source: ImportSource; inserted: number; skipped: number; period: string }
  | { ok: false; error: string }

const IMPORT_SOURCES: ImportSource[] = ['master', 'amex', 'tangerine', 'scotia']

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

  // Existing merchants by exact name, for resolving fixed bank payees
  // (Mortgage, Toronto Hydro, BGRS / Sirva, …) created by the classifier.
  const merchRows = await db.select({ id: merchants.id, name: merchants.name }).from(merchants)
  const merchantByName = new Map(merchRows.map((m) => [m.name, m.id]))

  const matchContains = (key: string): number | undefined => {
    for (const rule of containsRules) {
      if (key.includes(rule.pattern)) return rule.merchantId
    }
    return undefined
  }

  // rowIndex -> merchantId
  const result = new Map<number, number>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]

    // Bank rows with a fixed payee: find-or-create by name; on creation seed the
    // merchant's default category/recurring from the classifier (then the
    // transaction inherits them, so user edits to the merchant still win later).
    if (row.suggestedMerchant) {
      let merchantId = merchantByName.get(row.suggestedMerchant)
      if (merchantId === undefined) {
        const catName = row.suggestedCategory
        const [created] = await db
          .insert(merchants)
          .values({
            name: row.suggestedMerchant,
            categoryId: catName ? catId.get(catName) ?? null : null,
            defaultRecurring: row.isRecurring ?? false,
          })
          .returning({ id: merchants.id })
        merchantId = created.id
        merchantByName.set(row.suggestedMerchant, merchantId)
      }
      result.set(i, merchantId)
      continue
    }

    // Learning path: card rows and bank "pos purchase" rows resolve by key.
    const key = normalizeKey(row.rawDescription)
    let merchantId = exactMap.get(key) ?? matchContains(key)

    if (merchantId === undefined) {
      const categoryName = masterCategoryFor(row.rawCategory)
      const name = prettify(key) || row.rawDescription
      const [created] = await db
        .insert(merchants)
        .values({
          name,
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
      merchantByName.set(name, merchantId)
    }
    result.set(i, merchantId)
  }
  return result
}

/**
 * Mark a source healthy after a successful manual upload: clear the failure flags
 * and stamp lastSuccessAt = now, so the owner hand-fixing a sync counts as a fresh
 * successful sync (clears the dashboard banner *and* the stale "Xd ago" badge).
 * Best-effort: a missing row is unexpected here but handled by the insert.
 */
async function clearSyncFailure(source: ImportSource): Promise<void> {
  const now = new Date()
  await db
    .insert(syncRuns)
    .values({ source, status: 'ok', lastRunAt: now, lastSuccessAt: now, failureCount: 0 })
    .onConflictDoUpdate({
      target: syncRuns.source,
      set: { status: 'ok', error: null, failureCount: 0, lastRunAt: now, lastSuccessAt: now },
    })
}

export async function importCsv(formData: FormData): Promise<ImportResult> {
  await requireAuth()

  const file = formData.get('file')
  const expectedRaw = formData.get('source')
  const expected =
    typeof expectedRaw === 'string' && IMPORT_SOURCES.includes(expectedRaw as ImportSource)
      ? (expectedRaw as ImportSource)
      : undefined

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Please choose a CSV file.' }
  }

  const text = await file.text()
  const result = await ingestStatement(text, file.name, expected)

  if (result.ok) {
    // The owner fixing a broken sync by hand should silence its failure: clear
    // the dashboard banner for this source (the daily digest reconciles too).
    await clearSyncFailure(result.source)
    revalidatePath('/')
    revalidatePath('/trends')
    revalidatePath('/income')
    revalidatePath('/merchants')
    revalidatePath('/transactions')
    revalidatePath('/goals')
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
  expected?: ImportSource
): Promise<ImportResult> {
  let parsed
  try {
    parsed = parseStatement(text, expected)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not parse the file.' }
  }

  const { source, rows } = parsed
  if (rows.length === 0) {
    // A recognized export that simply had no transactions in the window — this
    // is a successful sync with nothing to insert, not an error.
    return { ok: true, source, inserted: 0, skipped: 0, period: new Date().toISOString().slice(0, 7) }
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
    flow: r.flow ?? 'expense',
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

  // Belair posts two payments once a year (car + house) — split them so the
  // analytics stay correct every year without manual edits.
  await reconcileBelairSplit()

  // Queue investment transfers (out) and unknown inbound deposits (in) for the
  // dashboard "what was this for?" prompt.
  await createTransferReviews(inserted.map((r) => r.id))
  await createInboundReviews(inserted.map((r) => r.id))

  // Keep the net-zero recovery goal in sync (auto-complete / revive on new data).
  await reconcileNetZeroGoals()

  return { ok: true, source, inserted: insertedCount, skipped: skippedCount, period }
}

/**
 * Belair insurance is billed once a year as two charges — one for the car, one
 * for the house, the house always the smaller amount. Per calendar year, send
 * the lowest-amount Belair charge to "Home" and the rest to "Cars" via
 * transaction-level category overrides. Re-runs idempotently after every import,
 * so next year's bill is split automatically. See BUSINESS_RULES.md.
 */
export async function reconcileBelairSplit(): Promise<void> {
  const cats = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
  const homeId = cats.find((c) => c.name === 'Home')?.id
  const carsId = cats.find((c) => c.name === 'Cars')?.id
  if (!homeId || !carsId) return

  const belair = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(ilike(merchants.name, 'belair%'))
  if (belair.length === 0) return

  const txns = await db
    .select({
      id: transactions.id,
      txnDate: transactions.txnDate,
      amount: transactions.amount,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(inArray(transactions.merchantId, belair.map((m) => m.id)))

  // Group by calendar year; in each year the cheapest charge is the house.
  const byYear = new Map<string, typeof txns>()
  for (const t of txns) {
    const year = t.txnDate.slice(0, 4)
    const group = byYear.get(year) ?? []
    group.push(t)
    byYear.set(year, group)
  }

  for (const group of byYear.values()) {
    if (group.length < 2) continue
    const lowest = group.reduce((lo, t) => (Number(t.amount) < Number(lo.amount) ? t : lo))
    for (const t of group) {
      const target = t.id === lowest.id ? homeId : carsId
      if (t.categoryId !== target) {
        await db.update(transactions).set({ categoryId: target }).where(eq(transactions.id, t.id))
      }
    }
  }
}

/**
 * Queue a Goals review for every freshly-imported investment transfer. The
 * classifier sends both the recurring $900 (kitchen) and any non-$1,100 customer
 * transfer to the "Investment (iTrade)" payee; those are the ones the owner needs
 * to attribute. The exact $1,100 → Mortgage is auto-classified and never queued.
 * suggestedGoalId is learned: the goal most often tagged on a prior transfer of
 * the same rounded amount. Idempotent (transactionId is unique).
 */
async function createTransferReviews(insertedIds: number[]): Promise<void> {
  if (insertedIds.length === 0) return

  const rows = await db
    .select({ id: transactions.id, amount: transactions.amount })
    .from(transactions)
    .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
    .where(
      and(
        inArray(transactions.id, insertedIds),
        eq(merchants.name, 'Investment (iTrade)')
      )
    )
  if (rows.length === 0) return

  // Learn amount → goal from prior tagged contributions (rounded to the dollar).
  const priorTags = await db
    .select({ goalId: goalEntries.goalId, amount: transactions.amount })
    .from(goalEntries)
    .innerJoin(transactions, eq(goalEntries.transactionId, transactions.id))
  const votes = new Map<number, Map<number, number>>() // roundedAmount -> goalId -> count
  for (const t of priorTags) {
    const key = Math.round(Number(t.amount))
    const inner = votes.get(key) ?? new Map<number, number>()
    inner.set(t.goalId, (inner.get(t.goalId) ?? 0) + 1)
    votes.set(key, inner)
  }
  const suggestFor = (amount: number): number | null => {
    const inner = votes.get(Math.round(amount))
    if (!inner) return null
    return [...inner.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }

  for (const r of rows) {
    await db
      .insert(transferReviews)
      .values({ transactionId: r.id, direction: 'out', suggestedGoalId: suggestFor(Number(r.amount)) })
      .onConflictDoNothing({ target: transferReviews.transactionId })
  }
}

/**
 * Queue an inbound Goals review for every freshly-imported unknown deposit (the
 * "Other Deposit" fallback in bank-classify). These are the ambiguous credits —
 * e.g. money pulled back from the investment account — that the owner needs to
 * label: a "spend from a goal" (income offsetting a real purchase), plain Other
 * Income, or an ignored inter-account move. Recognized income (salary, benefits,
 * insurance, …) is already classified and never lands here. Idempotent.
 */
async function createInboundReviews(insertedIds: number[]): Promise<void> {
  if (insertedIds.length === 0) return

  const rows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
    .where(
      and(
        inArray(transactions.id, insertedIds),
        eq(transactions.flow, 'income'),
        eq(merchants.name, 'Other Deposit')
      )
    )

  for (const r of rows) {
    await db
      .insert(transferReviews)
      .values({ transactionId: r.id, direction: 'in' })
      .onConflictDoNothing({ target: transferReviews.transactionId })
  }
}

/** Undo an import: delete its transactions and the batch record. */
export async function deleteBatch(batchId: number): Promise<void> {
  await requireAuth()
  await db.delete(transactions).where(eq(transactions.batchId, batchId))
  await db.delete(importBatches).where(eq(importBatches.id, batchId))
  revalidatePath('/')
  revalidatePath('/trends')
  revalidatePath('/income')
  revalidatePath('/merchants')
  revalidatePath('/transactions')
  revalidatePath('/goals')
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
