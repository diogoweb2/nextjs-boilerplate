/**
 * Daily-digest builder. Computes a short, glanceable overview meant for a native
 * macOS notification fired by the local `sync/digest.ts` runner AFTER the day's
 * card syncs — so the owner gets a "go check the site" nudge without keeping a
 * browser tab open. Reuses the same analytics the dashboard renders.
 *
 * It reads each source's last import freshness directly (not a run-order signal),
 * so it self-reports a stale/failed sync even if one runner never fired — and a
 * new source (Tangerine) needs only an entry in SYNC_SOURCES.
 *
 * Served by GET /api/digest (token-authed, app/api/digest/route.ts).
 */
import { and, desc, eq, gte } from 'drizzle-orm'
import { db } from '@/db'
import { importBatches, transactions, merchants, categories, budgetGoals } from '@/db/schema'
import { loadAllFlows, anchorMonth, type EnrichedTxn } from '@/app/lib/analytics'
import { buildInsights } from '@/app/lib/insights'
import { computeBudget, FIXED_CATEGORIES, type CategoryMeta } from '@/app/lib/budget'
import { computeMonthBurndown, daysInMonth } from '@/app/lib/projection'
import { getBudgetSettings } from '@/app/actions/budget'
import { loadProjectionRules } from '@/app/actions/projection'
import { formatCurrency } from '@/app/lib/format'
import { SYNC_SOURCES, syncStale, formatSyncAge } from '@/app/lib/sync'

const DAY_MS = 24 * 60 * 60 * 1000

export type DigestSync = { source: string; label: string; lastSync: string | null; stale: boolean }
export type DigestSpend = {
  total: number
  count: number
  biggest: { merchant: string; amount: number } | null
}
export type DigestPace = { mtd: number; budget: number; projected: number; onPace: boolean }

export type Digest = {
  /** Anything the owner should act on (a stale sync or projected overspend). */
  alert: boolean
  /** Pre-formatted for the notification — the runner stays dumb. */
  title: string
  body: string
  sync: DigestSync[]
  newSpend: DigestSpend
  pace: DigestPace | null
  newMerchants: string[]
  outlier: { merchant: string; amount: number; typical: number } | null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function buildDigest(now: number = Date.now()): Promise<Digest> {
  const [allFlows, catRows, goalRows, settings, rules] = await Promise.all([
    loadAllFlows(),
    db.select().from(categories),
    db.select().from(budgetGoals),
    getBudgetSettings(),
    loadProjectionRules(),
  ])

  // 1. Sync health — last import per source, flagged stale past SYNC_STALE_MS.
  const sync: DigestSync[] = await Promise.all(
    SYNC_SOURCES.map(async ({ source, label }) => {
      const [row] = await db
        .select({ createdAt: importBatches.createdAt })
        .from(importBatches)
        .where(eq(importBatches.source, source))
        .orderBy(desc(importBatches.createdAt))
        .limit(1)
      const lastSync = row?.createdAt?.toISOString() ?? null
      return { source, label, lastSync, stale: syncStale(lastSync, now) }
    })
  )

  // 2. New charges since the last digest (~24h of freshly-imported expense rows).
  const since = new Date(now - DAY_MS)
  const recent = await db
    .select({ amount: transactions.amount, merchant: merchants.name })
    .from(transactions)
    .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
    .where(
      and(
        gte(transactions.createdAt, since),
        eq(transactions.flow, 'expense'),
        eq(transactions.isPayment, false)
      )
    )
  const charges = recent
    .map((r) => ({ merchant: r.merchant, amount: Number(r.amount) }))
    .filter((c) => c.amount > 0)
  const newSpend: DigestSpend = {
    total: round2(charges.reduce((s, c) => s + c.amount, 0)),
    count: charges.length,
    biggest: charges.length ? charges.reduce((m, c) => (c.amount > m.amount ? c : m)) : null,
  }

  // 3. Month pace — discretionary burn-down on the current (anchor) month.
  const expenses = allFlows.filter((t: EnrichedTxn) => t.flow === 'expense')
  const anchor = anchorMonth(expenses)
  const meta: CategoryMeta[] = catRows.map((c) => ({ id: c.id, name: c.name, color: c.color, kind: c.kind }))
  const savedGoals = new Map(goalRows.map((g) => [g.categoryId, Number(g.goalAmount)]))
  const budget = computeBudget(allFlows, meta, {
    targetNet: settings.targetNet,
    periodMode: settings.periodMode,
    savedGoals,
    rules,
  })
  let pace: DigestPace | null = null
  if (budget.hasData && anchor) {
    const monthBudget = budget.monthlyCap - budget.unavoidable.total
    const bd = computeMonthBurndown(allFlows, rules, anchor, monthBudget, FIXED_CATEGORIES)
    const asOfDay = bd.asOfIndex + 1
    // Straight-line the month-to-date discretionary burn to a month-end estimate.
    const projected = asOfDay > 0 ? round2((bd.spentToDate / asOfDay) * daysInMonth(anchor)) : bd.spentToDate
    pace = { mtd: bd.spentToDate, budget: bd.budget, projected, onPace: bd.onPace }
  }

  // 4. New / unusual — first-seen merchants and a larger-than-usual charge this month.
  const insights = buildInsights(expenses, 1, false, anchor)
  const newMerchants = insights.newMerchants.map((m) => m.name)
  const outlier = insights.outliers[0]
    ? {
        merchant: insights.outliers[0].merchant,
        amount: insights.outliers[0].amount,
        typical: insights.outliers[0].typical,
      }
    : null

  // ----- compose the notification -----
  const overPace = pace ? pace.projected > pace.budget : false
  const alert = sync.some((s) => s.stale) || overPace

  const title = `Budget ${alert ? '⚠️' : '✓'}${
    newSpend.count ? ` — ${formatCurrency(newSpend.total)} new` : ''
  }`

  const lines: string[] = []
  lines.push(
    sync.map((s) => `${s.label} ${s.stale ? `⚠️ ${formatSyncAge(s.lastSync, now)}` : '✓'}`).join(' · ')
  )
  if (newSpend.count) {
    const big = newSpend.biggest
      ? ` · top ${newSpend.biggest.merchant} ${formatCurrency(newSpend.biggest.amount)}`
      : ''
    lines.push(`${formatCurrency(newSpend.total)} new (${newSpend.count} charge${newSpend.count > 1 ? 's' : ''})${big}`)
  }
  if (pace) {
    const verdict = overPace ? `proj ${formatCurrency(pace.projected)} ⚠️ over` : 'on pace'
    lines.push(`MTD ${formatCurrency(pace.mtd)} / ${formatCurrency(pace.budget)} · ${verdict}`)
  }
  const unusual: string[] = []
  if (newMerchants.length) unusual.push(`New: ${newMerchants.slice(0, 3).join(', ')}`)
  if (outlier) unusual.push(`⚠️ ${outlier.merchant} ${formatCurrency(outlier.amount)}`)
  if (unusual.length) lines.push(unusual.join(' · '))

  return { alert, title, body: lines.join('\n'), sync, newSpend, pace, newMerchants, outlier }
}
