'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { budgetSettings, budgetGoals } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { isDemoSession } from '@/app/lib/demo'
import type { PeriodMode } from '@/app/lib/budget'

export type BudgetSettingsView = { targetNet: number; periodMode: PeriodMode; budgetedMonth: string | null }

/** Read the singleton settings row, creating it with defaults on first access. */
export async function getBudgetSettings(): Promise<BudgetSettingsView> {
  if (await isDemoSession()) {
    const { demoBudgetSettings } = await import('@/app/lib/demo-data')
    return demoBudgetSettings()
  }
  const [row] = await db.select().from(budgetSettings).limit(1)
  if (row) return { targetNet: Number(row.targetNet), periodMode: row.periodMode, budgetedMonth: row.budgetedMonth }
  return { targetNet: 0, periodMode: 'year', budgetedMonth: null }
}

export async function saveSettings(patch: { targetNet?: number; periodMode?: PeriodMode }): Promise<void> {
  await requireAuth()
  const [existing] = await db.select().from(budgetSettings).limit(1)
  const set: Record<string, unknown> = { updatedAt: new Date() }
  if (patch.targetNet !== undefined && Number.isFinite(patch.targetNet)) {
    set.targetNet = String(Math.round(patch.targetNet * 100) / 100)
  }
  if (patch.periodMode === 'year' || patch.periodMode === '12mo') set.periodMode = patch.periodMode

  if (existing) {
    await db.update(budgetSettings).set(set).where(eq(budgetSettings.id, existing.id))
  } else {
    await db.insert(budgetSettings).values({
      targetNet: String(set.targetNet ?? '0'),
      periodMode: (set.periodMode as PeriodMode) ?? 'year',
    })
  }
  revalidatePath('/budget')
}

/** Upsert a single category's goal override (unique on categoryId). */
export async function saveGoal(categoryId: number, amount: number): Promise<void> {
  await requireAuth()
  if (!Number.isInteger(categoryId) || !Number.isFinite(amount)) return
  const value = String(Math.round(Math.max(0, amount) * 100) / 100)
  await db
    .insert(budgetGoals)
    .values({ categoryId, goalAmount: value })
    .onConflictDoUpdate({
      target: budgetGoals.categoryId,
      set: { goalAmount: value, updatedAt: new Date() },
    })
  revalidatePath('/budget')
}

/** Clear all goal overrides → back to the AI-suggested defaults. */
export async function resetGoals(): Promise<void> {
  await requireAuth()
  await db.delete(budgetGoals)
  revalidatePath('/budget')
}

/** Batch-upsert multiple category goals (e.g., auto-balance or seasonal proposal). */
export async function saveAllGoals(goals: Record<number, number>): Promise<void> {
  await requireAuth()
  await upsertGoals(goals)
  revalidatePath('/budget')
}

/** Shared upsert loop (no auth/revalidate) used by saveAllGoals & the monthly commit. */
async function upsertGoals(goals: Record<number, number>): Promise<void> {
  for (const [catIdStr, amount] of Object.entries(goals)) {
    const categoryId = Number(catIdStr)
    if (!Number.isInteger(categoryId) || !Number.isFinite(amount)) continue
    const value = String(Math.round(Math.max(0, amount) * 100) / 100)
    await db
      .insert(budgetGoals)
      .values({ categoryId, goalAmount: value })
      .onConflictDoUpdate({
        target: budgetGoals.categoryId,
        set: { goalAmount: value, updatedAt: new Date() },
      })
  }
}

/**
 * Mark `month` (YYYY-MM) as the budgeted month, idempotently. When `goals` is
 * given (the month genuinely advanced) the seasonal proposal is written as the
 * new starting budget; when omitted (first-ever run) we only record the marker
 * so existing manual goals are never clobbered. The re-read guard makes a double
 * client fire a no-op.
 */
export async function commitMonthlyBudget(month: string, goals?: Record<number, number>): Promise<void> {
  await requireAuth()
  if (!/^\d{4}-\d{2}$/.test(month)) return
  const [existing] = await db.select().from(budgetSettings).limit(1)
  if (existing?.budgetedMonth === month) return // already done this month
  if (goals) await upsertGoals(goals)
  if (existing) {
    await db.update(budgetSettings).set({ budgetedMonth: month, updatedAt: new Date() }).where(eq(budgetSettings.id, existing.id))
  } else {
    await db.insert(budgetSettings).values({ budgetedMonth: month })
  }
  revalidatePath('/budget')
}
