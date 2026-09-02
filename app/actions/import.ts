'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { and, asc, eq, inArray, ilike } from 'drizzle-orm'
import { db } from '@/db'
import {
  transactions,
  merchants,
  merchantRules,
  merchantAmountRules,
  categories,
  importBatches,
  goalEntries,
  transferReviews,
  syncRuns,
} from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { parseStatement, type ImportSource, type ParsedRow } from '@/app/lib/csv'
import { normalizeKey, prettify, masterCategoryFor } from '@/app/lib/normalize'
import { reconcileNetZeroGoals, suggestedMortgageExtra } from '@/app/actions/goals'
import { runAutoFillForAllProjects } from '@/app/actions/projects'
import { maybeTriggerDigest } from '@/app/lib/digest'
import { applyPlannedSplits } from '@/app/lib/planned-splits'
import { isExtraMortgagePayment } from '@/app/lib/mortgage'

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
    // Fold the new rows into any auto-filling project (trip mode) right away.
    await runAutoFillForAllProjects()
    // If this was the last source still missing today, fire the digest right
    // away instead of waiting for the 11:15 job — e.g. hand-fixing the one
    // bank that failed automatically shouldn't mean waiting hours for a nudge.
    after(() => maybeTriggerDigest())
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

  // Apply merchant+amount rules first: auto-fill category and note on matching new
  // txns. A remembered merchant+amount is already explained, so matched txns are
  // excluded from the withdrawal/deposit prompts below.
  const remembered = await applyAmountRules(inserted.map((r) => r.id))
  const unexplained = inserted.map((r) => r.id).filter((id) => !remembered.has(id))

  // Queue investment transfers (out), unknown outbound withdrawals (out, e.g. an
  // internal Tangerine↔Scotia transfer), and unknown inbound deposits (in) for the
  // dashboard "what was this for?" prompt.
  //
  // Transfers get the FULL list, not `unexplained`: an amount rule only remembers
  // a category and a note, which is not the question a transfer review asks (which
  // goal did this money go to?). Letting it suppress the prompt is how the
  // recurring $900 iTrade transfer ended up silently auto-filed.
  await createTransferReviews(inserted.map((r) => r.id))
  await createWithdrawalReviews(unexplained)
  await createInboundReviews(unexplained)

  // Carve out anything the owner planned ahead of time (a $500 gift card inside
  // the Metro grocery run) before it can pollute the merchant's category.
  await applyPlannedSplits(inserted.map((r) => r.id))

  // Keep the net-zero recovery goal in sync (auto-complete / revive on new data).
  await reconcileNetZeroGoals()

  return { ok: true, source, inserted: insertedCount, skipped: skippedCount, period }
}

/**
 * After inserting new transactions, check each one against `merchant_amount_rules`.
 * A match (same merchant_id + exact amount) overwrites the transaction's category
 * and note with the saved rule — so recurring fixed payments like a monthly garage
 * transfer are auto-categorized and labelled without touching the merchant level.
 * Returns the ids of matched transactions so the caller can skip queueing them
 * for transfer review — a remembered amount is already decided.
 */
async function applyAmountRules(txnIds: number[]): Promise<Set<number>> {
  const matched = new Set<number>()
  if (txnIds.length === 0) return matched
  const rules = await db.select().from(merchantAmountRules)
  if (rules.length === 0) return matched

  const txns = await db
    .select({ id: transactions.id, merchantId: transactions.merchantId, amount: transactions.amount })
    .from(transactions)
    .where(inArray(transactions.id, txnIds))

  for (const txn of txns) {
    const rule = rules.find(
      (r) => r.merchantId === txn.merchantId && Number(r.amount) === Number(txn.amount)
    )
    if (rule) {
      matched.add(txn.id)
      await db
        .update(transactions)
        .set({ categoryId: rule.categoryId, note: rule.note })
        .where(eq(transactions.id, txn.id))
    }
  }
  return matched
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

/** A top-up bigger than this multiple of the recent norm is not routine. */
const MORTGAGE_EXTRA_OUTLIER_FACTOR = 2

/**
 * How far a top-up may sit from the card's "Extra needed" figure and still count
 * as "the owner paid what we asked". Wide enough to absorb the drift between the
 * moment the card was read and the moment the payment posts (the balance keeps
 * accruing interest and the regular payments keep landing), narrow enough that a
 * lump sum can never pass for the monthly ask.
 */
const MORTGAGE_SUGGESTION_TOLERANCE = 0.05

/**
 * The freshly-imported extra mortgage prepayments that are too big to trust as
 * routine — worth a review before they silently count as principal.
 *
 * "Too big" is relative, because the monthly top-up is deliberately variable
 * (whatever the payoff-by-50 projection asks for that month): more than
 * MORTGAGE_EXTRA_OUTLIER_FACTOR × the median of the last 6 extras. That leaves
 * the normal month — $1,100, $493.30, anything in that band — auto-classified and
 * silent, and catches the $4,000 / $7,000 lumps that might have been an
 * investment move instead. With no history yet, every extra gets reviewed.
 *
 * One override on top of that: a top-up matching the amount the Mortgage Freedom
 * card asked for that month (within MORTGAGE_SUGGESTION_TOLERANCE) is never
 * reviewed, whatever the history says. The owner paying exactly what the app
 * suggested is the app's own instruction coming back — there is nothing to
 * confirm, including on the very first import, when there is no median yet.
 */
async function outsizedMortgageExtras(insertedIds: number[]): Promise<{ id: number; amount: string }[]> {
  const all = await db
    .select({
      id: transactions.id,
      amount: transactions.amount,
      flow: transactions.flow,
      rawDescription: transactions.rawDescription,
      merchantName: merchants.name,
    })
    .from(transactions)
    .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
    .where(eq(merchants.name, 'Mortgage'))
    .orderBy(asc(transactions.txnDate))

  const extras = all.filter(isExtraMortgagePayment)
  const fresh = new Set(insertedIds)
  const priorAmounts = extras
    .filter((t) => !fresh.has(t.id))
    .map((t) => Math.abs(Number(t.amount)))
    .slice(-6)
    .sort((a, b) => a - b)
  const median = priorAmounts.length ? priorAmounts[Math.floor(priorAmounts.length / 2)] : 0

  // The ask, computed as of *before* this import — otherwise the top-up we are
  // about to judge would have already shrunk the recommendation it should match.
  const suggested = await suggestedMortgageExtra(insertedIds)
  const asSuggested = (amount: number) =>
    suggested !== null &&
    suggested > 0 &&
    Math.abs(amount - suggested) <= suggested * MORTGAGE_SUGGESTION_TOLERANCE

  return extras
    .filter((t) => {
      if (!fresh.has(t.id)) return false
      const amount = Math.abs(Number(t.amount))
      if (asSuggested(amount)) return false
      return median === 0 || amount > median * MORTGAGE_EXTRA_OUTLIER_FACTOR
    })
    .map((t) => ({ id: t.id, amount: t.amount }))
}

/**
 * Queue a Goals review for every freshly-imported investment transfer — the
 * "Investment (iTrade)" payee (the recurring $900 kitchen transfer and any other
 * blank-sub customer transfer), which the owner needs to attribute to a goal.
 *
 * Also queues the *unusually large* extra mortgage top-ups: `classifyScotia`
 * sends every "Mb-Transfer" customer transfer straight to Home / Mortgage at any
 * amount (the monthly top-up changes), which is right for the routine payment but
 * not necessarily for a one-off lump. `outsizedMortgageExtras` picks those out so
 * the owner can flip them to investment; routine top-ups auto-classify silently.
 *
 * suggestedGoalId is learned: the goal most often tagged on a prior transfer of
 * the same rounded amount. Idempotent (transactionId is unique).
 */
async function createTransferReviews(insertedIds: number[]): Promise<void> {
  if (insertedIds.length === 0) return

  const rows = [
    ...(await db
      .select({ id: transactions.id, amount: transactions.amount })
      .from(transactions)
      .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
      .where(
        and(
          inArray(transactions.id, insertedIds),
          eq(merchants.name, 'Investment (iTrade)')
        )
      )),
    ...(await outsizedMortgageExtras(insertedIds)),
  ]
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
 * The catch-all merchant labels bank-classify assigns to an *unidentified* bank
 * outflow — exactly the rows that might be an internal Tangerine↔Scotia transfer
 * (or any move we couldn't name). A recognized expense (Koodo, Highway 407, …)
 * never uses these, so it won't be queued.
 */
const AMBIGUOUS_OUTBOUND_MERCHANTS = ['E-Transfer Out', 'Bank Withdrawal', 'Cheque Withdrawal']

/**
 * Queue an outbound review for every freshly-imported *unidentified* bank
 * withdrawal so the owner can label it — most importantly the debit leg of an
 * internal transfer between the two chequing accounts (which would otherwise sit
 * as a spurious `Other`/wants expense, polluting spend analytics and the runway
 * burn). Picking "Internal transfer" flips it to `flow=transfer`; the Emergency
 * Fund still moves the account balance (it ignores flow). Idempotent.
 */
async function createWithdrawalReviews(insertedIds: number[]): Promise<void> {
  if (insertedIds.length === 0) return

  const rows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
    .where(
      and(
        inArray(transactions.id, insertedIds),
        inArray(transactions.source, ['tangerine', 'scotia']),
        eq(transactions.flow, 'expense'),
        inArray(merchants.name, AMBIGUOUS_OUTBOUND_MERCHANTS)
      )
    )

  for (const r of rows) {
    await db
      .insert(transferReviews)
      .values({ transactionId: r.id, direction: 'out' })
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
