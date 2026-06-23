'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { categories } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'

function revalidateAll() {
  revalidatePath('/')
  revalidatePath('/trends')
  revalidatePath('/merchants')
  revalidatePath('/transactions')
  revalidatePath('/categories')
}

export async function createCategory(name: string, color: string): Promise<void> {
  await requireAuth()
  const trimmed = name.trim()
  if (!trimmed) return
  await db
    .insert(categories)
    .values({ name: trimmed, color: color || '#6366f1' })
    .onConflictDoNothing({ target: categories.name })
  revalidateAll()
}

export async function updateCategory(
  id: number,
  fields: { name?: string; color?: string }
): Promise<void> {
  await requireAuth()
  const patch: { name?: string; color?: string } = {}
  if (fields.name !== undefined && fields.name.trim()) patch.name = fields.name.trim()
  if (fields.color !== undefined) patch.color = fields.color
  if (Object.keys(patch).length === 0) return
  await db.update(categories).set(patch).where(eq(categories.id, id))
  revalidateAll()
}

/** Set a category's 50/30/20 bucket (see app/lib/fifty-thirty-twenty.ts). */
export async function updateCategoryBucket(
  id: number,
  bucket: 'needs' | 'wants' | 'savings' | 'none'
): Promise<void> {
  await requireAuth()
  if (!['needs', 'wants', 'savings', 'none'].includes(bucket)) return
  await db.update(categories).set({ bucket }).where(eq(categories.id, id))
  revalidateAll()
}

export async function deleteCategory(id: number): Promise<void> {
  await requireAuth()
  // Merchants/transactions referencing it are set null (see schema FK rules).
  await db.delete(categories).where(eq(categories.id, id))
  revalidateAll()
}
