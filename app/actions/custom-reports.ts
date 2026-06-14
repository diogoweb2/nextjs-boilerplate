'use server'

import { revalidatePath } from 'next/cache'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { customReports, type ReportSeries } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { loadEnriched } from '@/app/lib/analytics'
import {
  computeReportData,
  isReportRange,
  type ComputedReport,
  type ReportRange,
} from '@/app/lib/custom-reports'

/**
 * Coerce arbitrary client input into a clean series list. Drops empty lines
 * (no categories and no merchants) and keeps only integer ids.
 */
function sanitizeSeries(input: unknown): ReportSeries[] {
  if (!Array.isArray(input)) return []
  const ints = (v: unknown): number[] =>
    Array.isArray(v) ? [...new Set(v.filter((n) => Number.isInteger(n)) as number[])] : []
  return input
    .map((raw, i) => {
      const s = (raw ?? {}) as Record<string, unknown>
      const categoryIds = ints(s.categoryIds)
      const merchantIds = ints(s.merchantIds)
      const name = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : `Line ${i + 1}`
      const color = typeof s.color === 'string' ? s.color : '#6366f1'
      return { name, color, categoryIds, merchantIds }
    })
    .filter((s) => s.categoryIds.length > 0 || s.merchantIds.length > 0)
}

function sanitizeRange(input: unknown): ReportRange {
  return isReportRange(input) ? input : '6'
}

export type ReportInput = {
  name: string
  range: string
  series: ReportSeries[]
  pinned?: boolean
}

export async function createReport(input: ReportInput): Promise<void> {
  await requireAuth()
  const name = input.name?.trim() || 'Untitled report'
  const series = sanitizeSeries(input.series)
  if (series.length === 0) return
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${customReports.sortOrder}), 0)` })
    .from(customReports)
  await db.insert(customReports).values({
    name,
    range: sanitizeRange(input.range),
    series,
    pinned: input.pinned ?? false,
    sortOrder: Number(max) + 1,
  })
  revalidatePath('/custom')
}

export async function updateReport(
  id: number,
  patch: { name?: string; range?: string; series?: ReportSeries[]; pinned?: boolean }
): Promise<void> {
  await requireAuth()
  const set: Record<string, unknown> = { updatedAt: new Date() }
  if (patch.name !== undefined) set.name = patch.name.trim() || 'Untitled report'
  if (patch.range !== undefined) set.range = sanitizeRange(patch.range)
  if (patch.series !== undefined) set.series = sanitizeSeries(patch.series)
  if (patch.pinned !== undefined) set.pinned = patch.pinned
  await db.update(customReports).set(set).where(eq(customReports.id, id))
  revalidatePath('/custom')
}

export async function setReportPinned(id: number, pinned: boolean): Promise<void> {
  await requireAuth()
  await db
    .update(customReports)
    .set({ pinned, updatedAt: new Date() })
    .where(eq(customReports.id, id))
  revalidatePath('/custom')
}

export async function deleteReport(id: number): Promise<void> {
  await requireAuth()
  await db.delete(customReports).where(eq(customReports.id, id))
  revalidatePath('/custom')
}

/**
 * Compute a report's chart data on the server for the builder's live preview.
 * Keeps the per-transaction dedupe correct without shipping raw transactions to
 * the client.
 */
export async function previewReport(
  series: ReportSeries[],
  range: string
): Promise<ComputedReport> {
  await requireAuth()
  const all = await loadEnriched()
  return computeReportData(all, sanitizeSeries(series), sanitizeRange(range))
}
