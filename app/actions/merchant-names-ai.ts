'use server'

import { revalidatePath } from 'next/cache'
import { desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import { merchants, merchantNameRuns, transactions } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { askOpenRouter, sliceJson } from '@/app/lib/openrouter'

/**
 * AI merchant-name cleanup, the in-app half of scripts/merchant-names.ts (which
 * uses the Claude CLI subscription instead). Same contract everywhere: the model
 * proposes, nothing is written until the owner clicks.
 *
 * Renaming is all it takes for future imports to be right: `merchant_rules.exact_key`
 * maps the normalized statement key to the merchant ROW, and the displayed name is
 * just `merchants.name` (BUSINESS_RULES §3). So the next statement carrying the same
 * key resolves to the same row and shows the cleaned-up name automatically.
 */

export type NameProposal = {
  merchantId: number
  current: string
  newName: string
  why: string
  txns: number
}

export type NameSuggestResult =
  | { ok: true; proposals: NameProposal[]; reviewed: number; since: string | null }
  | { ok: false; error: string }

/** Merchants per model call — one bad batch stays cheap to redo. */
const BATCH = 40

type Candidate = { id: number; name: string; txns: number; samples: string[] }

/** Raw statement lines are the real evidence for what a merchant is — the prettified name alone isn't. */
async function loadCandidates(where?: SQL | undefined): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: merchants.id,
      name: merchants.name,
      txns: sql<number>`count(${transactions.id})::int`,
      samples: sql<string[]>`(array_agg(distinct ${transactions.rawDescription}))[1:3]`,
    })
    .from(merchants)
    .leftJoin(transactions, eq(transactions.merchantId, merchants.id))
    .where(where)
    .groupBy(merchants.id)
    .orderBy(desc(sql`count(${transactions.id})`))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    txns: Number(r.txns),
    samples: (r.samples ?? []).filter(Boolean).slice(0, 3),
  }))
}

function prompt(batch: Candidate[]): string {
  const list = batch
    .map((m) => `${m.id} | name: ${m.name} | ${m.txns} txns | raw: ${m.samples.join(' ~ ') || '(none)'}`)
    .join('\n')

  return `These are merchant records from a Canadian family's budgeting app (Ontario). Each line is:
id | name | transaction count | raw statement lines

${list}

For each merchant, decide whether the stored NAME should be improved into what a person would actually call this place. Improve when the name is bank noise: truncations ("PPARK", "MECP"), missing spaces, ALLCAPS gibberish, processor prefixes (SQ*, TST*, PAYPAL*), city/store codes, or a brand written unrecognizably.

Rules for the new name:
- Title Case, human, specific: "Arrowhead Park Parking", "Uniqlo Union Station", "GoodLife Fitness".
- Keep the brand's real spelling; keep a location only when it distinguishes ("Metro Bloor St").
- Never invent a business the raw text doesn't support. If unsure, leave it alone.
- No store numbers, processor prefixes, provinces or postal codes.
- Leave generic bank labels alone: E-Transfer Out, Bank Withdrawal, Cheque Withdrawal, Payment, Interest and similar.

Return ONLY a JSON array, one object per merchant you would CHANGE (omit the ones you'd leave as-is):
[{"id": 123, "newName": "Arrowhead Park Parking", "why": "MECP = Muskoka; PPARK = park parking"}]
"why" is at most 12 words. No markdown fences, no commentary.`
}

async function askForNames(batch: Candidate[]): Promise<NameProposal[]> {
  const text = await askOpenRouter({
    system:
      'You clean up merchant names from Canadian bank statements. Answer with JSON only: ' +
      'an array of {"id": number, "newName": string, "why": string}. No prose, no markdown fences.',
    prompt: prompt(batch),
    title: 'Budget - merchant name cleanup',
  })
  const parsed: unknown = JSON.parse(sliceJson(text, '['))
  if (!Array.isArray(parsed)) throw new Error('The model did not return a list.')

  const known = new Map(batch.map((m) => [m.id, m]))
  const out: NameProposal[] = []
  const seen = new Set<number>()
  for (const raw of parsed) {
    const p = raw as { id?: unknown; newName?: unknown; why?: unknown }
    const m = known.get(Number(p.id))
    const newName = typeof p.newName === 'string' ? p.newName.trim() : ''
    // Drop hallucinated ids, duplicates and no-op renames rather than showing them as changes.
    if (!m || seen.has(m.id) || !newName || newName === m.name) continue
    seen.add(m.id)
    out.push({
      merchantId: m.id,
      current: m.name,
      newName: newName.slice(0, 80),
      why: typeof p.why === 'string' ? p.why.slice(0, 80) : '',
      txns: m.txns,
    })
  }
  return out
}

/** The watermark: when the last batch review ran. Null = never, so the first batch sees everything. */
async function lastRunAt(): Promise<Date | null> {
  const [row] = await db
    .select({ ranAt: merchantNameRuns.ranAt })
    .from(merchantNameRuns)
    .orderBy(desc(merchantNameRuns.ranAt))
    .limit(1)
  return row?.ranAt ?? null
}

/** How many merchants the next batch would look at — drives the button's label. */
export async function newMerchantCount(): Promise<{ count: number; since: string | null }> {
  const since = await lastRunAt()
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(merchants)
    .where(since ? gt(merchants.createdAt, since) : undefined)
  return { count: Number(row?.n ?? 0), since: since ? since.toISOString() : null }
}

/**
 * Batch review of every merchant first seen since the last batch run. Suggestions
 * only — `applyMerchantNames` is what writes, and that is also what moves the
 * watermark, so nothing is skipped just because you looked at it.
 */
export async function suggestNewMerchantNames(): Promise<NameSuggestResult> {
  await requireAuth()
  const since = await lastRunAt()
  const candidates = await loadCandidates(since ? gt(merchants.createdAt, since) : undefined)
  if (candidates.length === 0) {
    return { ok: true, proposals: [], reviewed: 0, since: since ? since.toISOString() : null }
  }

  const proposals: NameProposal[] = []
  try {
    for (let i = 0; i < candidates.length; i += BATCH) {
      proposals.push(...(await askForNames(candidates.slice(i, i + BATCH))))
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 300) : String(e) }
  }
  return {
    ok: true,
    proposals,
    reviewed: candidates.length,
    since: since ? since.toISOString() : null,
  }
}

/** One merchant, on demand — the ✨ button next to a name. Never moves the watermark. */
export async function suggestMerchantName(
  merchantId: number
): Promise<{ ok: true; proposal: NameProposal | null } | { ok: false; error: string }> {
  await requireAuth()
  const [candidate] = await loadCandidates(eq(merchants.id, merchantId))
  if (!candidate) return { ok: false, error: 'Merchant not found.' }
  try {
    const [proposal] = await askForNames([candidate])
    return { ok: true, proposal: proposal ?? null }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 300) : String(e) }
  }
}

/**
 * Write the accepted renames. `recordRun` is set by the batch flow only: it stamps
 * the watermark so the next batch starts where this one ended.
 */
export async function applyMerchantNames(
  items: { id: number; name: string }[],
  opts?: { recordRun?: boolean; reviewed?: number }
): Promise<void> {
  await requireAuth()
  const clean = items
    .map((i) => ({ id: Number(i.id), name: i.name.trim() }))
    .filter((i) => Number.isFinite(i.id) && i.name.length > 0)

  if (clean.length > 0) {
    const ids = clean.map((i) => i.id)
    const existing = await db
      .select({ id: merchants.id })
      .from(merchants)
      .where(inArray(merchants.id, ids))
    const live = new Set(existing.map((m) => m.id))
    for (const i of clean) {
      if (!live.has(i.id)) continue
      await db.update(merchants).set({ name: i.name }).where(eq(merchants.id, i.id))
    }
  }

  if (opts?.recordRun) {
    await db.insert(merchantNameRuns).values({
      source: 'app',
      reviewed: opts.reviewed ?? 0,
      renamed: clean.length,
    })
  }

  revalidatePath('/manage/merchants')
  revalidatePath('/transactions')
  revalidatePath('/')
}
