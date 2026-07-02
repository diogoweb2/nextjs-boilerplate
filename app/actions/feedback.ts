'use server'

import { revalidatePath } from 'next/cache'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { feedbackItems, type FeedbackKind } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'

function isKind(v: unknown): v is FeedbackKind {
  return v === 'bug' || v === 'idea'
}

export async function createFeedbackItem(kind: FeedbackKind, label: string): Promise<void> {
  await requireAuth()
  const trimmed = label.trim()
  if (!trimmed || !isKind(kind)) return
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${feedbackItems.sortOrder}), 0)` })
    .from(feedbackItems)
  await db.insert(feedbackItems).values({ kind, label: trimmed, sortOrder: Number(max) + 1 })
  revalidatePath('/manage/feedback')
}

export async function updateFeedbackItem(
  id: number,
  patch: { kind?: FeedbackKind; label?: string }
): Promise<void> {
  await requireAuth()
  const set: Record<string, unknown> = {}
  if (patch.kind !== undefined && isKind(patch.kind)) set.kind = patch.kind
  if (patch.label !== undefined && patch.label.trim()) set.label = patch.label.trim()
  if (Object.keys(set).length === 0) return
  await db.update(feedbackItems).set(set).where(eq(feedbackItems.id, id))
  revalidatePath('/manage/feedback')
}

export async function setFeedbackItemCompleted(id: number, completed: boolean): Promise<void> {
  await requireAuth()
  await db.update(feedbackItems).set({ completed }).where(eq(feedbackItems.id, id))
  revalidatePath('/manage/feedback')
}

/**
 * Persists a full drag-to-reorder: `orderedIds` is every item's id in the
 * desired order; each row's `sortOrder` is rewritten to its index.
 */
export async function reorderFeedbackItems(orderedIds: number[]): Promise<void> {
  await requireAuth()
  for (let i = 0; i < orderedIds.length; i++) {
    await db.update(feedbackItems).set({ sortOrder: i }).where(eq(feedbackItems.id, orderedIds[i]))
  }
  revalidatePath('/manage/feedback')
}
