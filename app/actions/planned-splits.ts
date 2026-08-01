'use server'

/**
 * Planned splits (BUSINESS_RULES.md §22) — CRUD for the "future custom import"
 * rules plus the dashboard confirmation/warning feed. The matching itself lives
 * in `app/lib/planned-splits.ts` because the importer runs without a session.
 */

import { revalidatePath } from 'next/cache'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { plannedSplits, merchants, categories, goals } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { isDemoSession } from '@/app/lib/demo'
import { PLANNED_SPLIT_STALE_DAYS, daysSince } from '@/app/lib/planned-splits'

export type PlannedSplitRow = {
  id: number
  merchantId: number | null
  merchantLabel: string
  minAmount: number | null
  splitAmount: number
  label: string
  categoryId: number | null
  categoryName: string | null
  goalId: number | null
  goalName: string | null
  goalEmoji: string | null
  status: 'pending' | 'applied'
  appliedAt: string | null
  appliedTransactionId: number | null
  createdAt: string
  waitingDays: number
}

export type PlannedSplitOptions = {
  merchants: { id: number; name: string }[]
  categories: { id: number; name: string }[]
  goals: { id: number; name: string; emoji: string }[]
}

function revalidateAll() {
  revalidatePath('/')
  revalidatePath('/transactions')
  revalidatePath('/transactions/planned')
  revalidatePath('/goals')
}

export async function loadPlannedSplits(): Promise<PlannedSplitRow[]> {
  if (await isDemoSession()) return []
  const rows = await db
    .select({
      r: plannedSplits,
      categoryName: categories.name,
      goalName: goals.name,
      goalEmoji: goals.emoji,
    })
    .from(plannedSplits)
    .leftJoin(categories, eq(plannedSplits.categoryId, categories.id))
    .leftJoin(goals, eq(plannedSplits.goalId, goals.id))
    // 'pending' > 'applied' alphabetically, so desc puts the live rules on top.
    .orderBy(desc(plannedSplits.status), desc(plannedSplits.createdAt))

  return rows.map(({ r, categoryName, goalName, goalEmoji }) => ({
    id: r.id,
    merchantId: r.merchantId,
    merchantLabel: r.merchantLabel,
    minAmount: r.minAmount != null ? Number(r.minAmount) : null,
    splitAmount: Number(r.splitAmount),
    label: r.label,
    categoryId: r.categoryId,
    categoryName: categoryName ?? null,
    goalId: r.goalId,
    goalName: goalName ?? null,
    goalEmoji: goalEmoji ?? null,
    status: r.status,
    appliedAt: r.appliedAt ? r.appliedAt.toISOString().slice(0, 10) : null,
    appliedTransactionId: r.appliedTransactionId,
    createdAt: r.createdAt.toISOString().slice(0, 10),
    waitingDays: daysSince(r.createdAt),
  }))
}

/** Payees / categories / goals for the form pickers. */
export async function loadPlannedSplitOptions(): Promise<PlannedSplitOptions> {
  if (await isDemoSession()) return { merchants: [], categories: [], goals: [] }
  const [merchantRows, categoryRows, goalRows] = await Promise.all([
    db.select({ id: merchants.id, name: merchants.name }).from(merchants).orderBy(asc(merchants.name)),
    db.select({ id: categories.id, name: categories.name }).from(categories).orderBy(asc(categories.name)),
    db
      .select({ id: goals.id, name: goals.name, emoji: goals.emoji })
      .from(goals)
      .where(and(eq(goals.kind, 'savings'), eq(goals.archived, false)))
      .orderBy(asc(goals.sortOrder)),
  ])
  return { merchants: merchantRows, categories: categoryRows, goals: goalRows }
}

export type PlannedSplitAlert = {
  id: number
  label: string
  merchantLabel: string
  splitAmount: number
  goalName: string | null
  status: 'applied' | 'stale'
  appliedTransactionId: number | null
  waitingDays: number
}

/**
 * Dashboard feed: rules that just fired (so the owner can confirm the import did
 * the right thing) and rules still waiting after a week (so a typo'd merchant or
 * a purchase that never posted doesn't sit unnoticed). Dismissed rows are hidden.
 */
export async function loadPlannedSplitAlerts(): Promise<PlannedSplitAlert[]> {
  if (await isDemoSession()) return []
  const rows = await db
    .select({ r: plannedSplits, goalName: goals.name })
    .from(plannedSplits)
    .leftJoin(goals, eq(plannedSplits.goalId, goals.id))
    .where(isNull(plannedSplits.dismissedAt))
    .orderBy(desc(plannedSplits.createdAt))

  const out: PlannedSplitAlert[] = []
  for (const { r, goalName } of rows) {
    const waitingDays = daysSince(r.createdAt)
    const status =
      r.status === 'applied'
        ? 'applied'
        : waitingDays >= PLANNED_SPLIT_STALE_DAYS
          ? 'stale'
          : null
    if (!status) continue
    out.push({
      id: r.id,
      label: r.label,
      merchantLabel: r.merchantLabel,
      splitAmount: Number(r.splitAmount),
      goalName: goalName ?? null,
      status,
      appliedTransactionId: r.appliedTransactionId,
      waitingDays,
    })
  }
  return out
}

export type PlannedSplitInput = {
  merchantLabel: string
  merchantId?: number | null
  minAmount?: number | null
  splitAmount: number
  label: string
  categoryId?: number | null
  goalId?: number | null
}

/** Resolve the typed payee to an existing merchant (case-insensitive) if there is one. */
async function resolveMerchant(input: PlannedSplitInput): Promise<number | null> {
  if (input.merchantId != null && Number.isInteger(input.merchantId)) {
    const [m] = await db
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.id, input.merchantId))
      .limit(1)
    if (m) return m.id
  }
  const name = input.merchantLabel.trim()
  if (!name) return null
  const [byName] = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.name, name))
    .limit(1)
  return byName?.id ?? null
}

function clean(input: PlannedSplitInput) {
  const splitAmount = Math.round(Math.abs(input.splitAmount) * 100) / 100
  const min =
    input.minAmount == null || !Number.isFinite(input.minAmount) || input.minAmount <= 0
      ? null
      : Math.round(Math.abs(input.minAmount) * 100) / 100
  return {
    merchantLabel: input.merchantLabel.trim(),
    // numeric columns are read/written as strings by drizzle.
    minAmount: min != null ? min.toFixed(2) : null,
    splitAmount: splitAmount.toFixed(2),
    label: input.label.trim(),
    categoryId: input.categoryId ?? null,
    goalId: input.goalId ?? null,
  }
}

export async function createPlannedSplit(input: PlannedSplitInput): Promise<void> {
  await requireAuth()
  const v = clean(input)
  if (!v.merchantLabel || !v.label || !(Number(v.splitAmount) > 0)) return
  await db.insert(plannedSplits).values({ ...v, merchantId: await resolveMerchant(input) })
  revalidateAll()
}

export async function updatePlannedSplit(id: number, input: PlannedSplitInput): Promise<void> {
  await requireAuth()
  const v = clean(input)
  if (!v.merchantLabel || !v.label || !(Number(v.splitAmount) > 0)) return
  // Editing a rule puts it back on watch: an applied rule that was fixed should
  // fire again on the next import rather than stay a stale confirmation.
  await db
    .update(plannedSplits)
    .set({
      ...v,
      merchantId: await resolveMerchant(input),
      status: 'pending',
      // Restart the "waiting" clock so a just-fixed rule doesn't warn instantly.
      createdAt: new Date(),
      appliedAt: null,
      appliedTransactionId: null,
      dismissedAt: null,
    })
    .where(eq(plannedSplits.id, id))
  revalidateAll()
}

export async function deletePlannedSplit(id: number): Promise<void> {
  await requireAuth()
  await db.delete(plannedSplits).where(eq(plannedSplits.id, id))
  revalidateAll()
}

/**
 * Dismiss a dashboard alert. An applied rule has done its job, so dismissing
 * deletes it outright; a stale pending rule only gets its warning silenced —
 * the rule keeps waiting for its charge.
 */
export async function dismissPlannedSplitAlert(id: number): Promise<void> {
  await requireAuth()
  const [row] = await db.select().from(plannedSplits).where(eq(plannedSplits.id, id)).limit(1)
  if (!row) return
  if (row.status === 'applied') {
    await db.delete(plannedSplits).where(eq(plannedSplits.id, id))
  } else {
    await db.update(plannedSplits).set({ dismissedAt: new Date() }).where(eq(plannedSplits.id, id))
  }
  revalidateAll()
}
