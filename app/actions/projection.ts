'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { projectionRules, merchants } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import type { ProjectionRule, Cadence, AmountMode } from '@/app/lib/projection'

const CADENCES: Cadence[] = ['monthly', 'quarterly', 'annual', 'periodic']
const AMOUNT_MODES: AmountMode[] = ['seasonal', 'average', 'last', 'fixed']

/** Load enabled projection rules joined with their merchant name (lib view). */
export async function loadProjectionRules(): Promise<ProjectionRule[]> {
  const rows = await db
    .select({
      merchantId: projectionRules.merchantId,
      merchantName: merchants.name,
      label: projectionRules.label,
      cadence: projectionRules.cadence,
      amountMode: projectionRules.amountMode,
      fixedAmount: projectionRules.fixedAmount,
      enabled: projectionRules.enabled,
    })
    .from(projectionRules)
    .innerJoin(merchants, eq(projectionRules.merchantId, merchants.id))

  return rows
    .filter((r) => r.enabled)
    .map((r) => ({
      merchantId: r.merchantId,
      merchantName: r.merchantName,
      label: r.label,
      cadence: r.cadence as Cadence,
      amountMode: r.amountMode as AmountMode,
      fixedAmount: r.fixedAmount === null ? null : Number(r.fixedAmount),
    }))
}

type RuleInput = {
  merchantId: number
  label?: string
  cadence?: Cadence
  amountMode?: AmountMode
  fixedAmount?: number | null
}

function clean(patch: RuleInput) {
  const set: Record<string, unknown> = {}
  if (patch.label !== undefined) set.label = patch.label.slice(0, 80)
  if (patch.cadence && CADENCES.includes(patch.cadence)) set.cadence = patch.cadence
  if (patch.amountMode && AMOUNT_MODES.includes(patch.amountMode)) set.amountMode = patch.amountMode
  if (patch.fixedAmount !== undefined) {
    set.fixedAmount =
      patch.fixedAmount === null || !Number.isFinite(patch.fixedAmount)
        ? null
        : String(Math.round(Math.max(0, patch.fixedAmount) * 100) / 100)
  }
  return set
}

/** Add (or re-enable) a projection rule for a merchant, defaulting its label. */
export async function addProjectionRule(patch: RuleInput): Promise<void> {
  await requireAuth()
  if (!Number.isInteger(patch.merchantId)) return
  const [m] = await db.select().from(merchants).where(eq(merchants.id, patch.merchantId)).limit(1)
  if (!m) return
  const set = clean(patch)
  await db
    .insert(projectionRules)
    .values({
      merchantId: patch.merchantId,
      label: (set.label as string) ?? m.name,
      cadence: (set.cadence as Cadence) ?? 'monthly',
      amountMode: (set.amountMode as AmountMode) ?? 'average',
      fixedAmount: (set.fixedAmount as string | null) ?? null,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: projectionRules.merchantId,
      set: { ...set, enabled: true },
    })
  revalidatePath('/settings')
  revalidatePath('/budget')
  revalidatePath('/')
}

export async function updateProjectionRule(patch: RuleInput): Promise<void> {
  await requireAuth()
  if (!Number.isInteger(patch.merchantId)) return
  const set = clean(patch)
  if (Object.keys(set).length === 0) return
  await db.update(projectionRules).set(set).where(eq(projectionRules.merchantId, patch.merchantId))
  revalidatePath('/settings')
  revalidatePath('/budget')
  revalidatePath('/')
}

export async function removeProjectionRule(merchantId: number): Promise<void> {
  await requireAuth()
  if (!Number.isInteger(merchantId)) return
  await db.delete(projectionRules).where(eq(projectionRules.merchantId, merchantId))
  revalidatePath('/settings')
  revalidatePath('/budget')
  revalidatePath('/')
}

/** Mark a merchant so the auto-detector stops suggesting it as a projected bill. */
export async function dismissSuggestion(merchantId: number): Promise<void> {
  await requireAuth()
  if (!Number.isInteger(merchantId)) return
  await db.update(merchants).set({ projectionDismissed: true }).where(eq(merchants.id, merchantId))
  revalidatePath('/settings')
}
