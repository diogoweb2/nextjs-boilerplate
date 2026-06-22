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
import { importBatches, transactions, merchants, categories, budgetGoals, syncRuns } from '@/db/schema'
import { loadAllFlows, anchorMonth, type EnrichedTxn } from '@/app/lib/analytics'
import { buildInsights } from '@/app/lib/insights'
import { computeBudget, FIXED_CATEGORIES, type CategoryMeta } from '@/app/lib/budget'
import { computeMonthBurndown, daysInMonth, pacePercent, type PaceLevel } from '@/app/lib/projection'
import { getBudgetSettings } from '@/app/actions/budget'
import { loadProjectionRules } from '@/app/actions/projection'
import { formatCurrency } from '@/app/lib/format'
import { SYNC_SOURCES, syncStale, mostRecentIso } from '@/app/lib/sync'

const DAY_MS = 24 * 60 * 60 * 1000

export type DigestSync = { source: string; label: string; lastSync: string | null; stale: boolean }
export type DigestSpend = {
  total: number
  count: number
  biggest: { merchant: string; amount: number } | null
}
export type DigestPace = {
  mtd: number
  budget: number
  projected: number
  onPace: boolean
  pct: number
  level: PaceLevel
}

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

export async function buildDigest(now: number = Date.now(), failedSources: string[] = []): Promise<Digest> {
  const [allFlows, catRows, goalRows, settings, rules] = await Promise.all([
    loadAllFlows(),
    db.select().from(categories),
    db.select().from(budgetGoals),
    getBudgetSettings(),
    loadProjectionRules(),
  ])

  // Per-source run health: drives both freshness (lastSuccessAt counts empty
  // syncs that import no batch) and the failure reconciliation further down.
  const runRows = await db
    .select({ source: syncRuns.source, status: syncRuns.status, lastSuccessAt: syncRuns.lastSuccessAt })
    .from(syncRuns)
  const runBySource = new Map(runRows.map((r) => [r.source, r]))

  // 1. Sync health — last import or successful run per source, flagged stale.
  const sync: DigestSync[] = await Promise.all(
    SYNC_SOURCES.map(async ({ source, label }) => {
      const [row] = await db
        .select({ createdAt: importBatches.createdAt })
        .from(importBatches)
        .where(eq(importBatches.source, source))
        .orderBy(desc(importBatches.createdAt))
        .limit(1)
      const lastSync = mostRecentIso(
        row?.createdAt?.toISOString() ?? null,
        runBySource.get(source)?.lastSuccessAt?.toISOString() ?? null
      )
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
    const status = pacePercent(bd)
    pace = { mtd: bd.spentToDate, budget: bd.budget, projected, onPace: bd.onPace, pct: status.pct, level: status.level }
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

  // The runner reports failures from its local per-source status files, but a
  // manual re-upload marks that source ok in sync_runs. Honour that override so
  // a hand-fixed bank stops being named here.
  const clearedSources = new Set(
    runRows.filter((r) => r.status === 'ok').map((r) => r.source)
  )
  const labelToSource = new Map(SYNC_SOURCES.map((s) => [s.label, s.source]))
  const activeFailures = failedSources.filter((label) => {
    const src = labelToSource.get(label)
    return !src || !clearedSources.has(src)
  })

  // ----- compose the notification -----
  const overPace = pace ? pace.projected > pace.budget : false
  const alert = sync.some((s) => s.stale) || overPace || activeFailures.length > 0

  // Title: total spent since the last import (unchanged copy).
  const title = `Budget ${alert ? '⚠️' : '✓'}${
    newSpend.count ? ` — ${formatCurrency(newSpend.total)} new` : ''
  }`

  // Body: pace verdict + headroom %, then a failed-sync line if any runners gave up.
  const PACE_LABEL: Record<PaceLevel, string> = {
    great: 'On pace ✓',
    close: 'Cutting it close ⚠',
    below: 'Behind pace ✗',
  }
  const paceStr = pace ? `${PACE_LABEL[pace.level]} · ${pace.pct >= 0 ? '+' : ''}${pace.pct}%` : ''
  const failStr = activeFailures.length > 0 ? `Failed: ${activeFailures.join(', ')}` : ''
  const body = [paceStr, failStr].filter(Boolean).join('\n')

  return { alert, title, body, sync, newSpend, pace, newMerchants, outlier }
}
