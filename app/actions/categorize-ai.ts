'use server'

import { isNotNull } from 'drizzle-orm'
import { db } from '@/db'
import { categories, merchants } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { askOpenRouter, sliceJson, DEFAULT_MODEL } from '@/app/lib/openrouter'

export type CategorySuggestion = {
  txnId: number
  categoryId: number
  categoryName: string
  reason: string
}

export type SuggestResult =
  | { ok: true; suggestions: CategorySuggestion[]; model: string }
  | { ok: false; error: string }

export type SuggestInput = {
  id: number
  merchantName: string
  amount: number
  txnDate: string
}

/** How many already-categorized merchants per category go into the prompt as examples. */
const EXAMPLES_PER_CATEGORY = 6

/**
 * Ask a cheap model which existing category each uncategorized transaction most
 * likely belongs to. Suggestions only — nothing is written to the DB here; the
 * dashboard banner pre-selects them and the owner confirms (or changes) each one,
 * which then goes through the normal `setTxnCategory` merchant-teaching path.
 *
 * The model may only pick from the app's existing categories: anything it invents
 * (or any id it hallucinates) is dropped rather than shown.
 */
export async function suggestCategories(txns: SuggestInput[]): Promise<SuggestResult> {
  await requireAuth()
  if (txns.length === 0) return { ok: true, suggestions: [], model: DEFAULT_MODEL }

  const [catRows, taught] = await Promise.all([
    db.select().from(categories),
    db
      .select({ name: merchants.name, categoryId: merchants.categoryId })
      .from(merchants)
      .where(isNotNull(merchants.categoryId)),
  ])
  const pickable = catRows.filter((c) => c.name !== 'Uncategorized')
  if (pickable.length === 0) return { ok: false, error: 'No categories to choose from yet.' }

  // Ground the model in this household's own habits: a few merchants already
  // filed under each category beat any generic taxonomy prior.
  const examples = new Map<number, string[]>()
  for (const m of taught) {
    if (m.categoryId === null) continue
    const list = examples.get(m.categoryId) ?? []
    if (list.length < EXAMPLES_PER_CATEGORY && !list.includes(m.name)) list.push(m.name)
    examples.set(m.categoryId, list)
  }

  const catalogue = pickable
    .map((c) => {
      const ex = examples.get(c.id) ?? []
      return `${c.id}. ${c.name}${ex.length ? ` — e.g. ${ex.join(', ')}` : ''}`
    })
    .join('\n')

  const list = txns
    .map((t) => `${t.id} | ${t.merchantName} | $${t.amount.toFixed(2)} | ${t.txnDate}`)
    .join('\n')

  const system =
    'You categorize Canadian personal bank/credit-card transactions. ' +
    'Answer with JSON only: an array of {"txnId": number, "categoryId": number, "reason": string}. ' +
    'categoryId MUST be one of the ids given. reason is at most 8 words. ' +
    'Include every transaction exactly once. No prose, no markdown fences.'

  const prompt = `Categories (id. name — merchants already filed there):
${catalogue}

Transactions (id | merchant | amount | date):
${list}`

  let text: string
  try {
    text = await askOpenRouter({ system, prompt, title: 'Budget - categorize suggestions' })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 300) : String(e) }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(sliceJson(text, '['))
  } catch {
    return { ok: false, error: "The model's answer wasn't valid JSON." }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'The model did not return a list.' }

  const byId = new Map(pickable.map((c) => [c.id, c.name]))
  const wanted = new Set(txns.map((t) => t.id))
  const seen = new Set<number>()
  const suggestions: CategorySuggestion[] = []
  for (const raw of parsed) {
    const r = raw as { txnId?: unknown; categoryId?: unknown; reason?: unknown }
    const txnId = Number(r.txnId)
    const categoryId = Number(r.categoryId)
    const name = byId.get(categoryId)
    if (!wanted.has(txnId) || seen.has(txnId) || !name) continue
    seen.add(txnId)
    suggestions.push({
      txnId,
      categoryId,
      categoryName: name,
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 60) : '',
    })
  }
  if (suggestions.length === 0) return { ok: false, error: 'No usable suggestions came back.' }
  return { ok: true, suggestions, model: DEFAULT_MODEL }
}
