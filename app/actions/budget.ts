'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { budgetSettings, budgetGoals } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import type { PeriodMode } from '@/app/lib/budget'

/** Read the singleton settings row, creating it with defaults on first access. */
export async function getBudgetSettings(): Promise<{ targetNet: number; periodMode: PeriodMode }> {
  const [row] = await db.select().from(budgetSettings).limit(1)
  if (row) return { targetNet: Number(row.targetNet), periodMode: row.periodMode }
  return { targetNet: 0, periodMode: 'year' }
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
