'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { projectionRules, merchants } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { isDemoSession } from '@/app/lib/demo'
import { loadAllFlows, anchorMonth } from '@/app/lib/analytics'
import { FIXED_CATEGORIES } from '@/app/lib/budget'
import {
  suggestProjectionRules,
  projectedAmountForMonth,
  monthlyUnavoidable,
} from '@/app/lib/projection'
import type { ProjectionRule, Cadence, AmountMode } from '@/app/lib/projection'

const CADENCES: Cadence[] = ['monthly', 'quarterly', 'annual', 'periodic']
const AMOUNT_MODES: AmountMode[] = ['seasonal', 'average', 'last', 'fixed']

/** Load enabled projection rules joined with their merchant name (lib view). */
export async function loadProjectionRules(): Promise<ProjectionRule[]> {
  if (await isDemoSession()) {
    const { demoProjectionRules } = await import('@/app/lib/demo-data')
    return demoProjectionRules()
  }
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

/**
 * Everything the projection editor needs: this month's unavoidable breakdown,
 * the active bills (with current projected/actual amount), auto-detected
 * suggestions, and merchants you can still add. Shared by the Settings page and
 * the dashboard's "unavoidable" modal so both stay in lockstep.
 */
export async function loadProjectionPanel() {
  // Read-only loader — no requireAuth (it would block demo reads); proxy.ts gates
  // navigation and the mutating rule actions below each guard writes themselves.
  const [all, rules, merchantRows] = (await isDemoSession())
    ? await (async () => {
        const d = await import('@/app/lib/demo-data')
        return [d.demoAllFlows(), d.demoProjectionRules(), d.demoMerchantRows()] as const
      })()
    : await Promise.all([loadAllFlows(), loadProjectionRules(), db.select().from(merchants)])
  const anchor = anchorMonth(all)

  const existing = new Set(rules.map((r) => r.merchantId))
  const dismissed = new Set(merchantRows.filter((m) => m.projectionDismissed).map((m) => m.id))
  const suggestions = suggestProjectionRules(all, existing, dismissed, FIXED_CATEGORIES)
  const active = rules.map((r) => {
    const { amount, actual } = anchor ? projectedAmountForMonth(r, all, anchor) : { amount: 0, actual: false }
    return { ...r, currentAmount: amount, actual }
  })
  const unavoidable = anchor ? monthlyUnavoidable(all, rules, anchor, FIXED_CATEGORIES) : { total: 0, lines: [] }
  const addableMerchants = merchantRows
    .filter((m) => !existing.has(m.id))
    .map((m) => ({ id: m.id, name: m.name }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { hasData: all.length > 0, active, suggestions, unavoidable, addableMerchants }
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
