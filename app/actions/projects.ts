'use server'

import { and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm'
import { put, del } from '@vercel/blob'
import { revalidatePath } from 'next/cache'
import { db } from '@/db'
import {
  projects,
  projectTransactions,
  transactions,
  merchants,
  categories,
  type AutoFill,
} from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { cardholderName, getPersonNames } from '@/app/lib/cardholders'
import { isDemoSession } from '@/app/lib/demo'

const NO_CAT = { name: 'Uncategorized', color: '#94a3b8' }

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export type ProjectTxn = {
  id: number
  txnDate: string
  merchantName: string
  rawDescription: string
  amount: number
  categoryName: string
  categoryColor: string
  source: 'master' | 'amex' | 'tangerine' | 'scotia' | 'manual'
  country: string | null
  person: string
}

export type ProjectListItem = {
  id: number
  name: string
  emoji: string
  color: string
  coverImageUrl: string | null
  startDate: string | null
  endDate: string | null
  total: number
  count: number
}

export type ProjectDetail = {
  id: number
  name: string
  emoji: string
  color: string
  coverImageUrl: string | null
  startDate: string | null
  endDate: string | null
  notes: string | null
  autoFill: AutoFill | null
  total: number
  members: ProjectTxn[]
  /** Spend grouped by effective category, descending. */
  byCategory: { name: string; color: string; total: number; count: number }[]
  /** Spend grouped by who paid. */
  byPerson: { person: string; total: number }[]
}

export type ProjectPickerItem = { id: number; name: string; emoji: string }

export type DashboardProject = {
  id: number
  name: string
  emoji: string
  color: string
  startDate: string
  endDate: string | null
  total: number
  count: number
  /** 'upcoming' (starts in the future), 'active' (in window), 'wrapup' (ended, in the +10d tail). */
  phase: 'upcoming' | 'active' | 'wrapup'
  /** Whole days from today to startDate; negative once started. */
  daysUntilStart: number
}

// How many days before a project's start it begins showing on the dashboard.
const DASHBOARD_LEAD_DAYS = 21
// How many days after a project's end it keeps showing on the dashboard.
const DASHBOARD_TAIL_DAYS = 10

// The columns we join for an enriched member/candidate row.
type EnrichInput = {
  id: number
  txnDate: string
  rawDescription: string
  amount: string
  source: 'master' | 'amex' | 'tangerine' | 'scotia' | 'manual'
  country: string | null
  cardLast4: string | null
  txnCategoryId: number | null
  merchantName: string
  merchantCategoryId: number | null
}

function enrich(
  rows: EnrichInput[],
  catMap: Map<number, { name: string; color: string }>
): ProjectTxn[] {
  return rows.map((r) => {
    const effCatId = r.txnCategoryId ?? r.merchantCategoryId ?? null
    const cat = effCatId != null ? catMap.get(effCatId) : undefined
    return {
      id: r.id,
      txnDate: r.txnDate,
      merchantName: r.merchantName,
      rawDescription: r.rawDescription,
      amount: Number(r.amount),
      categoryName: cat?.name ?? NO_CAT.name,
      categoryColor: cat?.color ?? NO_CAT.color,
      source: r.source,
      country: r.country,
      person: cardholderName(r.cardLast4),
    }
  })
}

const MEMBER_COLUMNS = {
  id: transactions.id,
  txnDate: transactions.txnDate,
  rawDescription: transactions.rawDescription,
  amount: transactions.amount,
  source: transactions.source,
  country: transactions.country,
  cardLast4: transactions.cardLast4,
  txnCategoryId: transactions.categoryId,
  merchantName: merchants.name,
  merchantCategoryId: merchants.categoryId,
} as const

async function categoryMap(): Promise<Map<number, { name: string; color: string }>> {
  const cats = await db
    .select({ id: categories.id, name: categories.name, color: categories.color })
    .from(categories)
  return new Map(cats.map((c) => [c.id, { name: c.name, color: c.color }]))
}

// ---------------------------------------------------------------------------
// Loaders (no requireAuth — demo sessions read, never write)
// ---------------------------------------------------------------------------

export async function loadProjects(): Promise<ProjectListItem[]> {
  if (await isDemoSession()) {
    const d = await import('@/app/lib/demo-data')
    return d.demoProjects()
  }
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      emoji: projects.emoji,
      color: projects.color,
      coverImageUrl: projects.coverImageUrl,
      startDate: projects.startDate,
      endDate: projects.endDate,
      total: sql<string>`coalesce(sum(${transactions.amount}), 0)`,
      count: sql<number>`count(${transactions.id})`,
    })
    .from(projects)
    .leftJoin(
      projectTransactions,
      and(
        eq(projectTransactions.projectId, projects.id),
        eq(projectTransactions.dismissed, false),
        eq(projectTransactions.needsReview, false)
      )
    )
    .leftJoin(transactions, eq(transactions.id, projectTransactions.transactionId))
    .where(eq(projects.archived, false))
    .groupBy(projects.id)
    .orderBy(projects.sortOrder, projects.id)

  return rows.map((r) => ({
    ...r,
    total: Number(r.total),
    count: Number(r.count),
  }))
}

/** Add `days` to a YYYY-MM-DD date string, returning YYYY-MM-DD. */
function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Whole days between two YYYY-MM-DD strings (to - from). */
function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime()
  const b = new Date(`${to}T00:00:00`).getTime()
  return Math.round((b - a) / 86_400_000)
}

/**
 * Projects to surface on the Overview: any dated, non-archived, non-dismissed
 * project whose reminder window is current — from DASHBOARD_LEAD_DAYS before its
 * start through DASHBOARD_TAIL_DAYS after its end (end defaults to start). The
 * owner can permanently dismiss one (persisted via `dashboardDismissed`).
 */
export async function loadDashboardProjects(): Promise<DashboardProject[]> {
  if (await isDemoSession()) return []
  const today = new Date().toISOString().slice(0, 10)

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      emoji: projects.emoji,
      color: projects.color,
      startDate: projects.startDate,
      endDate: projects.endDate,
      total: sql<string>`coalesce(sum(${transactions.amount}), 0)`,
      count: sql<number>`count(${transactions.id})`,
    })
    .from(projects)
    .leftJoin(
      projectTransactions,
      and(
        eq(projectTransactions.projectId, projects.id),
        eq(projectTransactions.dismissed, false),
        eq(projectTransactions.needsReview, false)
      )
    )
    .leftJoin(transactions, eq(transactions.id, projectTransactions.transactionId))
    .where(
      and(
        eq(projects.archived, false),
        eq(projects.dashboardDismissed, false),
        sql`${projects.startDate} is not null`
      )
    )
    .groupBy(projects.id)
    .orderBy(projects.startDate)

  const out: DashboardProject[] = []
  for (const r of rows) {
    const startDate = r.startDate! // guaranteed by the WHERE
    const endDate = r.endDate
    const windowStart = shiftDate(startDate, -DASHBOARD_LEAD_DAYS)
    const windowEnd = shiftDate(endDate ?? startDate, DASHBOARD_TAIL_DAYS)
    if (today < windowStart || today > windowEnd) continue

    const daysUntilStart = daysBetween(today, startDate)
    const ended = today > (endDate ?? startDate)
    const phase: DashboardProject['phase'] = daysUntilStart > 0 ? 'upcoming' : ended ? 'wrapup' : 'active'

    out.push({
      id: r.id,
      name: r.name,
      emoji: r.emoji,
      color: r.color,
      startDate,
      endDate,
      total: Number(r.total),
      count: Number(r.count),
      phase,
      daysUntilStart,
    })
  }
  return out
}

export async function loadProjectDetail(id: number): Promise<ProjectDetail | null> {
  if (await isDemoSession()) {
    const d = await import('@/app/lib/demo-data')
    return d.demoProjectDetail(id)
  }
  const [p] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  if (!p) return null

  const catMap = await categoryMap()
  const memberRows = await db
    .select(MEMBER_COLUMNS)
    .from(projectTransactions)
    .innerJoin(transactions, eq(transactions.id, projectTransactions.transactionId))
    .innerJoin(merchants, eq(merchants.id, transactions.merchantId))
    .where(
      and(
        eq(projectTransactions.projectId, id),
        eq(projectTransactions.dismissed, false),
        eq(projectTransactions.needsReview, false)
      )
    )
    .orderBy(transactions.txnDate)

  const members = enrich(memberRows, catMap)
  const total = members.reduce((s, m) => s + m.amount, 0)

  const catAgg = new Map<string, { name: string; color: string; total: number; count: number }>()
  for (const m of members) {
    const key = m.categoryName
    const cur = catAgg.get(key) ?? { name: m.categoryName, color: m.categoryColor, total: 0, count: 0 }
    cur.total += m.amount
    cur.count += 1
    catAgg.set(key, cur)
  }

  const personAgg = new Map<string, number>()
  for (const m of members) personAgg.set(m.person, (personAgg.get(m.person) ?? 0) + m.amount)

  return {
    id: p.id,
    name: p.name,
    emoji: p.emoji,
    color: p.color,
    coverImageUrl: p.coverImageUrl,
    startDate: p.startDate,
    endDate: p.endDate,
    notes: p.notes,
    autoFill: (p.autoFill as AutoFill | null) ?? null,
    total,
    members,
    byCategory: [...catAgg.values()].sort((a, b) => b.total - a.total),
    byPerson: [...personAgg.entries()]
      .map(([person, total]) => ({ person, total }))
      .sort((a, b) => b.total - a.total),
  }
}

/**
 * Transactions auto-filled by runProjectAutoFill that were flagged as
 * recurring/bill-like and need the owner's review before being counted.
 * Shown in the "Auto-filled — needs review" section of the project detail.
 */
export async function loadAutoFillReviews(id: number): Promise<ProjectTxn[]> {
  if (await isDemoSession()) return []
  const catMap = await categoryMap()
  const rows = await db
    .select(MEMBER_COLUMNS)
    .from(projectTransactions)
    .innerJoin(transactions, eq(transactions.id, projectTransactions.transactionId))
    .innerJoin(merchants, eq(merchants.id, transactions.merchantId))
    .where(
      and(
        eq(projectTransactions.projectId, id),
        eq(projectTransactions.dismissed, false),
        eq(projectTransactions.needsReview, true)
      )
    )
    .orderBy(transactions.txnDate)
  return enrich(rows, catMap)
}

/**
 * "Suggested — review" rows for a project's detail page: transactions inside the
 * project's date window whose country is UNKNOWN (Amex / bank rows never carry a
 * country code, so we can't prove they were foreign), excluding payments and any
 * row that is already a member. The owner confirms or ignores each. Empty unless
 * the project has both a start and an end date.
 */
export async function loadProjectCandidates(id: number): Promise<ProjectTxn[]> {
  if (await isDemoSession()) return []
  const [p] = await db
    .select({ startDate: projects.startDate, endDate: projects.endDate })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)
  if (!p?.startDate || !p?.endDate) return []

  const catMap = await categoryMap()
  const existing = db
    .select({ id: projectTransactions.transactionId })
    .from(projectTransactions)
    .where(eq(projectTransactions.projectId, id))

  const rows = await db
    .select(MEMBER_COLUMNS)
    .from(transactions)
    .innerJoin(merchants, eq(merchants.id, transactions.merchantId))
    .where(
      and(
        sql`${transactions.txnDate} between ${p.startDate} and ${p.endDate}`,
        eq(transactions.flow, 'expense'),
        eq(transactions.isPayment, false),
        isNull(transactions.country),
        notInArray(transactions.id, existing)
      )
    )
    .orderBy(transactions.txnDate)

  return enrich(rows, catMap)
}

export async function loadProjectsForPicker(): Promise<ProjectPickerItem[]> {
  if (await isDemoSession()) {
    const d = await import('@/app/lib/demo-data')
    return d.demoProjects().map((p) => ({ id: p.id, name: p.name, emoji: p.emoji }))
  }
  return db
    .select({ id: projects.id, name: projects.name, emoji: projects.emoji })
    .from(projects)
    .where(eq(projects.archived, false))
    .orderBy(projects.sortOrder, projects.id)
}

/** Map of transactionId -> the projects it belongs to (for Activity badges). */
export async function loadProjectMemberships(): Promise<
  Record<number, ProjectPickerItem[]>
> {
  if (await isDemoSession()) return {}
  const rows = await db
    .select({
      txnId: projectTransactions.transactionId,
      id: projects.id,
      name: projects.name,
      emoji: projects.emoji,
    })
    .from(projectTransactions)
    .innerJoin(projects, eq(projects.id, projectTransactions.projectId))
    .where(
      and(
        eq(projectTransactions.dismissed, false),
        eq(projectTransactions.needsReview, false)
      )
    )

  const map: Record<number, ProjectPickerItem[]> = {}
  for (const r of rows) {
    ;(map[r.txnId] ??= []).push({ id: r.id, name: r.name, emoji: r.emoji })
  }
  return map
}

// ---------------------------------------------------------------------------
// Mutations (all behind requireAuth)
// ---------------------------------------------------------------------------

export type ProjectInput = {
  name: string
  emoji?: string
  color?: string
  startDate?: string | null
  endDate?: string | null
  notes?: string | null
  autoFill?: AutoFill | null
}

export async function createProject(input: ProjectInput): Promise<number> {
  await requireAuth()
  const name = input.name.trim()
  if (!name) throw new Error('Project needs a name')
  const [row] = await db
    .insert(projects)
    .values({
      name,
      emoji: input.emoji?.trim() || '🧳',
      color: input.color || '#6366f1',
      startDate: input.startDate || null,
      endDate: input.endDate || null,
      notes: input.notes?.trim() || null,
      autoFill: input.autoFill || null,
    })
    .returning({ id: projects.id })
  revalidatePath('/projects')

  // Immediately auto-fill if configured and dates are set.
  if (input.autoFill && input.startDate && input.endDate) {
    await _runProjectAutoFill(row.id)
  }

  return row.id
}

export async function updateProject(id: number, patch: Partial<ProjectInput>): Promise<void> {
  await requireAuth()
  const set: Record<string, unknown> = {}
  if (patch.name !== undefined) set.name = patch.name.trim()
  if (patch.emoji !== undefined) set.emoji = patch.emoji.trim() || '🧳'
  if (patch.color !== undefined) set.color = patch.color
  if (patch.startDate !== undefined) set.startDate = patch.startDate || null
  if (patch.endDate !== undefined) set.endDate = patch.endDate || null
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null
  if (patch.autoFill !== undefined) set.autoFill = patch.autoFill || null
  if (Object.keys(set).length === 0) return
  await db.update(projects).set(set).where(eq(projects.id, id))
  revalidatePath('/projects')
  revalidatePath(`/projects/${id}`)
}

/**
 * Stop showing a project's reminder on the Overview (persisted, cross-device).
 * Only allowed once the project is over (past end_date, which defaults to
 * start_date) — before then the reminder isn't dismissible.
 */
export async function dismissProjectFromDashboard(id: number): Promise<void> {
  await requireAuth()
  const [p] = await db
    .select({ startDate: projects.startDate, endDate: projects.endDate })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)
  if (!p) throw new Error('Project not found')
  const end = p.endDate ?? p.startDate
  const today = new Date().toISOString().slice(0, 10)
  if (!end || today <= end) throw new Error('Project is not done yet')
  await db.update(projects).set({ dashboardDismissed: true }).where(eq(projects.id, id))
  revalidatePath('/')
}

export async function deleteProject(id: number): Promise<void> {
  await requireAuth()
  const [p] = await db
    .select({ coverImageUrl: projects.coverImageUrl })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)
  if (p?.coverImageUrl) await del(p.coverImageUrl).catch(() => {})
  // project_transactions cascades on the FK.
  await db.delete(projects).where(eq(projects.id, id))
  revalidatePath('/projects')
}

export async function addTransactionsToProject(
  projectId: number,
  txnIds: number[]
): Promise<void> {
  await requireAuth()
  const ids = [...new Set(txnIds)].filter((n) => Number.isInteger(n))
  if (ids.length === 0) return
  await db
    .insert(projectTransactions)
    .values(ids.map((transactionId) => ({ projectId, transactionId, dismissed: false, needsReview: false })))
    .onConflictDoUpdate({
      target: [projectTransactions.projectId, projectTransactions.transactionId],
      set: { dismissed: false, needsReview: false },
    })
  revalidatePath('/projects')
  revalidatePath(`/projects/${projectId}`)
  revalidatePath('/transactions')
}

/**
 * Mark suggested candidates as "not part of this project" so they stop appearing
 * in the project's "Suggested — review" list. Stored as a dismissed (tombstone)
 * membership row — not a member, just a suppression. Re-adding the txn later
 * (here or from Activity) flips it back to a real member.
 */
export async function dismissCandidates(projectId: number, txnIds: number[]): Promise<void> {
  await requireAuth()
  const ids = [...new Set(txnIds)].filter((n) => Number.isInteger(n))
  if (ids.length === 0) return
  await db
    .insert(projectTransactions)
    .values(ids.map((transactionId) => ({ projectId, transactionId, dismissed: true, needsReview: false })))
    .onConflictDoUpdate({
      target: [projectTransactions.projectId, projectTransactions.transactionId],
      set: { dismissed: true },
    })
  revalidatePath('/projects')
  revalidatePath(`/projects/${projectId}`)
}

export async function removeTransactionsFromProject(
  projectId: number,
  txnIds: number[]
): Promise<void> {
  await requireAuth()
  const ids = [...new Set(txnIds)].filter((n) => Number.isInteger(n))
  if (ids.length === 0) return
  await db
    .delete(projectTransactions)
    .where(
      and(
        eq(projectTransactions.projectId, projectId),
        inArray(projectTransactions.transactionId, ids)
      )
    )
  revalidatePath('/projects')
  revalidatePath(`/projects/${projectId}`)
  revalidatePath('/transactions')
}

/**
 * Approve auto-fill review items: flip needsReview → false so they become
 * confirmed members counted in the project total.
 */
export async function approveAutoFillReview(projectId: number, txnIds: number[]): Promise<void> {
  await requireAuth()
  const ids = [...new Set(txnIds)].filter((n) => Number.isInteger(n))
  if (ids.length === 0) return
  await db
    .update(projectTransactions)
    .set({ needsReview: false })
    .where(
      and(
        eq(projectTransactions.projectId, projectId),
        inArray(projectTransactions.transactionId, ids)
      )
    )
  revalidatePath('/projects')
  revalidatePath(`/projects/${projectId}`)
}

/**
 * Internal auto-fill logic. Queries all credit-card (master/amex) transactions
 * in the project's date window for the configured cardholder(s), then inserts:
 *  - needsReview = false → non-recurring: auto-added as a project member
 *  - needsReview = true  → recurring/bill-like: shown in "needs review" section
 * Uses onConflictDoNothing so existing user decisions (manual adds, dismissals,
 * or previously approved reviews) are never overwritten.
 */
async function _runProjectAutoFill(
  projectId: number
): Promise<{ added: number; review: number }> {
  const [p] = await db
    .select({
      autoFill: projects.autoFill,
      startDate: projects.startDate,
      endDate: projects.endDate,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)

  if (!p?.autoFill || !p.startDate || !p.endDate) return { added: 0, review: 0 }

  const { partnerCards } = getPersonNames()

  // Build the card-owner filter (credit cards only).
  let cardFilter: ReturnType<typeof inArray> | ReturnType<typeof or> | undefined
  if (p.autoFill === 'partner') {
    if (partnerCards.length === 0) return { added: 0, review: 0 }
    cardFilter = inArray(transactions.cardLast4, partnerCards)
  } else if (p.autoFill === 'self') {
    // Rows with null cardLast4 or a card not in PARTNER_CARDS belong to self.
    cardFilter =
      partnerCards.length > 0
        ? or(isNull(transactions.cardLast4), notInArray(transactions.cardLast4, partnerCards))
        : undefined
  }
  // 'both': no card filter

  // Subquery: all txn IDs already tracked (member, review, or dismissed).
  const existing = db
    .select({ id: projectTransactions.transactionId })
    .from(projectTransactions)
    .where(eq(projectTransactions.projectId, projectId))

  const conditions = [
    sql`${transactions.txnDate} between ${p.startDate} and ${p.endDate}`,
    eq(transactions.flow, 'expense'),
    eq(transactions.isPayment, false),
    inArray(transactions.source, ['master', 'amex'] as const),
    notInArray(transactions.id, existing),
    cardFilter,
  ].filter(Boolean) as Parameters<typeof and>

  const rows = await db
    .select({
      id: transactions.id,
      txnIsRecurring: transactions.isRecurring,
      merchantDefaultRecurring: merchants.defaultRecurring,
    })
    .from(transactions)
    .innerJoin(merchants, eq(merchants.id, transactions.merchantId))
    .where(and(...conditions))

  if (rows.length === 0) return { added: 0, review: 0 }

  const toInsert = rows.map((r) => ({
    projectId,
    transactionId: r.id,
    dismissed: false,
    // Effectively recurring = true → send to review (likely a bill, not a trip expense).
    needsReview: r.txnIsRecurring ?? r.merchantDefaultRecurring ?? false,
  }))

  await db.insert(projectTransactions).values(toInsert).onConflictDoNothing()

  revalidatePath('/projects')
  revalidatePath(`/projects/${projectId}`)

  return {
    added: toInsert.filter((r) => !r.needsReview).length,
    review: toInsert.filter((r) => r.needsReview).length,
  }
}

/** Public action: re-run auto-fill to pick up new transactions since last fill. */
export async function runProjectAutoFill(
  projectId: number
): Promise<{ added: number; review: number }> {
  await requireAuth()
  return _runProjectAutoFill(projectId)
}

/**
 * Upload/replace a project's cover photo in Vercel Blob and store the public URL.
 * Needs BLOB_READ_WRITE_TOKEN in the environment (create a Blob store in Vercel).
 * The old blob, if any, is deleted so we don't leak orphans.
 */
export async function setProjectCover(formData: FormData): Promise<void> {
  await requireAuth()
  const projectId = Number(formData.get('projectId'))
  const file = formData.get('file')
  if (!Number.isInteger(projectId) || !(file instanceof File) || file.size === 0) {
    throw new Error('Missing project or file')
  }
  if (!file.type.startsWith('image/')) throw new Error('Cover must be an image')

  const [p] = await db
    .select({ coverImageUrl: projects.coverImageUrl })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (!p) throw new Error('Project not found')

  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  const blob = await put(`projects/${projectId}-${Date.now()}.${ext}`, file, {
    access: 'public',
    contentType: file.type,
  })
  if (p.coverImageUrl) await del(p.coverImageUrl).catch(() => {})

  await db
    .update(projects)
    .set({ coverImageUrl: blob.url })
    .where(eq(projects.id, projectId))
  revalidatePath('/projects')
  revalidatePath(`/projects/${projectId}`)
}

export async function removeProjectCover(projectId: number): Promise<void> {
  await requireAuth()
  const [p] = await db
    .select({ coverImageUrl: projects.coverImageUrl })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (p?.coverImageUrl) await del(p.coverImageUrl).catch(() => {})
  await db.update(projects).set({ coverImageUrl: null }).where(eq(projects.id, projectId))
  revalidatePath('/projects')
  revalidatePath(`/projects/${projectId}`)
}
