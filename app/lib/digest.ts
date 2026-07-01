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
import {
  importBatches,
  transactions,
  merchants,
  categories,
  budgetGoals,
  syncRuns,
  digestRuns,
  monthReportPushes,
  dailyDigestPushes,
} from '@/db/schema'
import { loadAllFlows, anchorMonth, availableMonths, type EnrichedTxn } from '@/app/lib/analytics'
import { buildInsights } from '@/app/lib/insights'
import { computeBudget, FIXED_CATEGORIES, type CategoryMeta } from '@/app/lib/budget'
import { computeMonthBurndown, daysInMonth, pacePercent, unavoidableMerchantIds, type PaceLevel } from '@/app/lib/projection'
import { getBudgetSettings } from '@/app/actions/budget'
import { loadProjectionRules } from '@/app/actions/projection'
import { formatCurrency } from '@/app/lib/format'
import { SYNC_SOURCES, syncStale, mostRecentIso } from '@/app/lib/sync'
import { pushConfigured, sendPushToAll } from '@/app/lib/push'
import { buildMonthReport, buildReportNotification } from '@/app/lib/monthReport'
import { completedReportMonth } from '@/app/lib/reportSchedule'

const DAY_MS = 24 * 60 * 60 * 1000

export type DigestSync = { source: string; label: string; lastSync: string | null; stale: boolean }
export type DigestCharge = { merchant: string; amount: number; date: string }
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

/**
 * Discretionary charges to exclude from "new spend": the same fixed categories
 * (Home) and projected-bill merchants the burndown curve skips, so "$X new"
 * means new *discretionary* spend and lines up with the trajectory cards.
 */
export type SpendExclusion = { merchantIds: Set<number>; fixedCats: Set<string> }

/**
 * New charges since the last digest: the ~24h of freshly-imported expense rows
 * (by `createdAt`, not transaction date) that the daily notification reports as
 * "$X new". Unavoidable spend (`exclude`) is dropped so this matches the
 * discretionary curve. Shared so the dashboard lists the exact same charges,
 * sorted largest-first.
 */
export async function recentCharges(
  now: number = Date.now(),
  exclude?: SpendExclusion
): Promise<DigestCharge[]> {
  const since = new Date(now - DAY_MS)
  const recent = await db
    .select({
      amount: transactions.amount,
      merchant: merchants.name,
      merchantId: transactions.merchantId,
      category: categories.name,
      date: transactions.txnDate,
    })
    .from(transactions)
    .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        gte(transactions.createdAt, since),
        eq(transactions.flow, 'expense'),
        eq(transactions.isPayment, false)
      )
    )
  return recent
    .filter((r) => Number(r.amount) > 0)
    .filter(
      (r) =>
        !exclude || (!exclude.merchantIds.has(r.merchantId) && !exclude.fixedCats.has(r.category ?? ''))
    )
    .map((r) => ({ merchant: r.merchant, amount: Number(r.amount), date: r.date }))
    .sort((a, b) => b.amount - a.amount)
}

/** Roll a charge list up into the glanceable `$X new · N charges` summary. */
export function summarizeSpend(charges: DigestCharge[]): DigestSpend {
  return {
    total: round2(charges.reduce((s, c) => s + c.amount, 0)),
    count: charges.length,
    biggest: charges.length ? charges.reduce((m, c) => (c.amount > m.amount ? c : m)) : null,
  }
}

/** The digest's "$X new" summary — same window/exclusion as {@link recentCharges}. */
export async function recentSpend(now: number = Date.now(), exclude?: SpendExclusion): Promise<DigestSpend> {
  return summarizeSpend(await recentCharges(now, exclude))
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

  // 2. New discretionary charges since the last digest (~24h of freshly-imported
  //    expense rows), excluding the unavoidable spend the curve also ignores.
  const newSpend = await recentSpend(now, unavoidableMerchantIds(allFlows, rules, FIXED_CATEGORIES))

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

type PushResult = { sent: number; failed: number; skipped?: boolean }
export type DigestRunResult =
  | { monthReport: true; ym: string; note: { title: string; body: string; url?: string }; push: PushResult }
  | (Digest & { push: PushResult })

async function recordDigestRun(status: 'ok' | 'fail', error?: string): Promise<void> {
  await db.insert(digestRuns).values({ status, error: error ?? null })
}

/**
 * The daily-digest job: computes the digest (or, once a prior month is final,
 * its one-shot recap) and pushes it. Shared by the token-authed POST
 * /api/digest (the local launchd runner) and the session-authed manual retry
 * (`retryDailyDigest`), so a dashboard "Retry" click runs the exact same path
 * a healthy cron run would have. Every attempt — success or thrown error — is
 * recorded to `digest_runs` so DigestStatusBanner can surface a failure and so
 * a fresh run can tell "the last one failed" and push through even with no
 * new spend today (see `previousRunFailed` below).
 */
export async function runDailyDigestJob(
  failedSources: string[] = [],
  now: number = Date.now()
): Promise<DigestRunResult> {
  try {
    // The month before the current anchor (latest month with data) is final the
    // moment that newer-month data lands — no pending charge can predate it. So
    // once a completed month exists, push its recap (once) and skip the daily
    // digest. Fires on the first run after new-month data; the per-`ym` dedup
    // row caps it.
    const flows = await loadAllFlows()
    const ym = completedReportMonth(anchorMonth(flows.filter((t) => t.flow === 'expense')))
    if (ym && availableMonths(flows).includes(ym)) {
      const { report } = await buildMonthReport(ym)
      if (report && pushConfigured()) {
        // Insert-if-absent so later runs in the window can't double-send the recap.
        const claimed = await db
          .insert(monthReportPushes)
          .values({ ym })
          .onConflictDoNothing()
          .returning()
        if (claimed.length > 0) {
          const note = buildReportNotification(report)
          const push = await sendPushToAll({ title: note.title, body: note.body, url: note.url })
          await recordDigestRun('ok')
          return { monthReport: true, ym, note, push }
        }
      }
      // No data yet, push not configured, or already sent → fall through to the daily digest.
    }

    const digest = await buildDigest(now, failedSources)
    const hasNewData = digest.newSpend.count > 0

    // Gate on all sources having a successful run today (UTC date). Requires each
    // source to have status='ok' AND lastRunAt on today's UTC calendar date so that
    // yesterday's stale 'ok' doesn't count as today's sync being done.
    const todayUtc = new Date()
    todayUtc.setUTCHours(0, 0, 0, 0)
    const syncRunRows = await db
      .select({ source: syncRuns.source, status: syncRuns.status, lastRunAt: syncRuns.lastRunAt })
      .from(syncRuns)
    const allSyncsOk = SYNC_SOURCES.every(({ source }) => {
      const row = syncRunRows.find((r) => r.source === source)
      return row?.status === 'ok' && row.lastRunAt != null && row.lastRunAt >= todayUtc
    })

    // If the last attempt failed outright, the owner may have missed real news —
    // don't let "no new spend today" suppress the notification that things are
    // working again. Doubles as what makes the dashboard Retry button actually
    // push: the failed run it's reacting to is the "previous" one.
    const [lastRun] = await db
      .select({ status: digestRuns.status })
      .from(digestRuns)
      .orderBy(desc(digestRuns.lastRunAt))
      .limit(1)
    const previousRunFailed = lastRun?.status === 'fail'

    let push: PushResult
    if (!allSyncsOk || (!hasNewData && !previousRunFailed) || !pushConfigured()) {
      push = { sent: 0, failed: 0, skipped: true }
    } else {
      // Daily dedup: claim today's UTC date slot; if already claimed, skip.
      const today = todayUtc.toISOString().slice(0, 10)
      const claimed = await db
        .insert(dailyDigestPushes)
        .values({ date: today })
        .onConflictDoNothing()
        .returning()
      push = claimed.length > 0
        ? await sendPushToAll({ title: digest.title, body: digest.body, url: '/' })
        : { sent: 0, failed: 0, skipped: true }
    }

    await recordDigestRun('ok')
    return { ...digest, push }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordDigestRun('fail', message).catch(() => {})
    throw err
  }
}
