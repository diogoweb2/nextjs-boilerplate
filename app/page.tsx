import { desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { importBatches, categories, budgetGoals, syncRuns, backupRuns, digestRuns, dailyDigestPushes } from '@/db/schema'
import { AppShell, Card, EmptyHint } from '@/app/components/AppShell'
import { UploadDialog } from '@/app/components/UploadDialog'
import { PeriodSelector } from '@/app/components/PeriodSelector'
import { SyncStatusBar } from '@/app/components/SyncStatusBar'
import { SyncErrorBanner, type SyncFailure } from '@/app/components/SyncErrorBanner'
import { BackupStatusBanner } from '@/app/components/BackupStatusBanner'
import { DigestStatusBanner } from '@/app/components/DigestStatusBanner'
import { backupStale } from '@/app/lib/backup'
import { SYNC_SOURCES, mostRecentIso } from '@/app/lib/sync'
import { StatCard } from '@/app/components/charts/StatCard'
import { InsightCard } from '@/app/components/InsightCard'
import { BurndownTrajectory } from '@/app/components/BurndownTrajectory'
import { NetBudgetTrajectory } from '@/app/components/NetBudgetTrajectory'
import { loadAllFlows, buildOverview, availableMonths, anchorMonth, categoryCredits } from '@/app/lib/analytics'
import { buildInsights, type InsightCard as InsightCardData } from '@/app/lib/insights'
import { loadAlertDismissals, loadRenewalDismissals } from '@/app/actions/subscriptions'
import { buildRenewalWarnings } from '@/app/lib/renewal-watch'
import { RenewalWarningBanner } from '@/app/components/RenewalWarningBanner'
import { parsePeriodParams } from '@/app/lib/params'
import { computeBudget, FIXED_CATEGORIES, type CategoryMeta } from '@/app/lib/budget'
import { computeMonthBurndown, monthlyUnavoidable, unavoidableMerchantIds, type BurndownData } from '@/app/lib/projection'
import { getBudgetSettings } from '@/app/actions/budget'
import { loadProjectionRules } from '@/app/actions/projection'
import { recentCharges } from '@/app/lib/digest'
import { loadPendingReviews, loadGoalsData, mortgageSyncHealth } from '@/app/actions/goals'
import { loadSurplusPrompts } from '@/app/actions/surplus'
import { loadDashboardProjects } from '@/app/actions/projects'
import { ProjectReminderBanner } from '@/app/components/ProjectReminderBanner'
import { loadEmergencyFund } from '@/app/actions/emergency'
import { loadCcPaymentHistory, loadBillDismissals, loadCcExpectedPayment } from '@/app/actions/bills'
import { buildBillCalendar, buildBillReminders } from '@/app/lib/bill-calendar'
import { BillsCalendar } from '@/app/components/BillsCalendar'
import { BillReminderBanner } from '@/app/components/BillReminderBanner'
import { isDemoSession } from '@/app/lib/demo'
import { TransferReview } from '@/app/components/TransferReview'
import { OtherCategoryBanner } from '@/app/components/OtherCategoryBanner'
import { ReportReminder } from '@/app/components/ReportReminder'
import { YearReportReminder } from '@/app/components/YearReportReminder'
import { completedReportMonth, completedYearReportYear } from '@/app/lib/reportSchedule'
import { SurplusAllocation } from '@/app/components/SurplusAllocation'
import { GoalsSummary } from '@/app/components/GoalsSummary'
import { buildBudgetInsights } from '@/app/lib/dashboard-insights'
import { computePaceAlerts } from '@/app/lib/pace-alerts'
import { PaceAlertModal } from '@/app/components/PaceAlertModal'
import {
  formatCurrency,
  formatCurrencyCompact,
} from '@/app/lib/format'

export const dynamic = 'force-dynamic'

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const rawParams = await searchParams
  const { excludeSpecial, month } = parsePeriodParams(rawParams)

  const lastSyncQuery = (source: (typeof SYNC_SOURCES)[number]['source']) =>
    db
      .select({ createdAt: importBatches.createdAt })
      .from(importBatches)
      .where(eq(importBatches.source, source))
      .orderBy(desc(importBatches.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.createdAt?.toISOString() ?? null)

  const lastBackupQuery = () =>
    db
      .select({ lastSuccessAt: backupRuns.lastSuccessAt })
      .from(backupRuns)
      .where(eq(backupRuns.status, 'ok'))
      .orderBy(desc(backupRuns.lastSuccessAt))
      .limit(1)
      .then((rows) => rows[0]?.lastSuccessAt?.toISOString() ?? null)

  const lastDigestRunQuery = () =>
    db
      .select({ status: digestRuns.status, lastRunAt: digestRuns.lastRunAt, error: digestRuns.error })
      .from(digestRuns)
      .orderBy(desc(digestRuns.lastRunAt))
      .limit(1)
      .then((rows) => rows[0] ?? null)

  // Last daily notification actually pushed (dailyDigestPushes only gets a row
  // when a push goes out, so this is a true "last notified" timestamp).
  const lastDigestPushQuery = () =>
    db
      .select({ sentAt: dailyDigestPushes.sentAt })
      .from(dailyDigestPushes)
      .orderBy(desc(dailyDigestPushes.sentAt))
      .limit(1)
      .then((rows) => rows[0]?.sentAt?.toISOString() ?? null)

  const demo = await isDemoSession()
  const [
    allFlows,
    catRows,
    goalRows,
    settings,
    rules,
    syncTimes,
    syncRunRows,
    pendingReviews,
    backupLastSuccess,
    surplusPrompts,
    lastDigestRun,
    lastDigestPush,
  ] = demo
    ? await (async () => {
        const d = await import('@/app/lib/demo-data')
        return [
          d.demoAllFlows(),
          d.demoCategoryRows(),
          d.demoBudgetGoalRows(),
          d.demoBudgetSettings(),
          d.demoProjectionRules(),
          d.demoSyncTimes(),
          [] as (typeof syncRuns.$inferSelect)[],
          d.demoPendingReviews(),
          null as string | null,
          d.demoSurplusPrompts(),
          null as { status: string; lastRunAt: Date; error: string | null } | null,
          null as string | null,
        ] as const
      })()
    : await Promise.all([
        loadAllFlows(),
        db.select().from(categories),
        db.select().from(budgetGoals),
        getBudgetSettings(),
        loadProjectionRules(),
        Promise.all(SYNC_SOURCES.map((s) => lastSyncQuery(s.source))),
        db.select().from(syncRuns),
        loadPendingReviews(),
        lastBackupQuery(),
        loadSurplusPrompts(),
        lastDigestRunQuery(),
        lastDigestPushQuery(),
      ])

  const syncFailures: SyncFailure[] = SYNC_SOURCES.flatMap((s) => {
    const run = syncRunRows.find((r) => r.source === s.source)
    if (!run || run.status !== 'fail') return []
    return [{
      label: s.label,
      lastSuccessAt: run.lastSuccessAt?.toISOString() ?? null,
      error: run.error,
      failureCount: run.failureCount,
    }]
  })
  // Partial-failure warning: the Scotia sync exported its CSV fine (status 'ok')
  // but the mortgage balance scrape came up empty, so the latest balance snapshot
  // lags behind the run. Detected by comparing the newest snapshot date to
  // Scotia's last success — no extra plumbing. Only warns once a balance has been
  // recorded before (so it never fires for a mortgage that was never synced).
  const scotiaRun = syncRunRows.find((r) => r.source === 'scotia')
  const scotiaOk = scotiaRun?.status === 'ok' && scotiaRun.lastSuccessAt
  const mortgageHealth = demo ? { balanceDate: null, rateCheckedAt: null } : await mortgageSyncHealth()
  const syncWarnings: string[] = []
  if (
    scotiaOk &&
    mortgageHealth.balanceDate &&
    mortgageHealth.balanceDate < scotiaRun!.lastSuccessAt!.toISOString().slice(0, 10)
  ) {
    syncWarnings.push(
      `Scotia synced OK but the mortgage balance didn't update (last read ${mortgageHealth.balanceDate}). ` +
        `The transaction CSV imported; only the mortgage scrape is failing.`,
    )
  }
  // Rate is scraped monthly and retries daily until it works, so a rateCheckedAt
  // older than ~5 weeks (or never, while a balance is being tracked) means the
  // rate scrape is broken even though Scotia otherwise syncs.
  if (scotiaOk && mortgageHealth.balanceDate) {
    const RATE_STALE_MS = 38 * 864e5
    const ageMs = mortgageHealth.rateCheckedAt
      ? Date.now() - new Date(mortgageHealth.rateCheckedAt).getTime()
      : Infinity
    if (ageMs > RATE_STALE_MS) {
      const last = mortgageHealth.rateCheckedAt
        ? `last succeeded ${mortgageHealth.rateCheckedAt.slice(0, 10)}`
        : 'has never succeeded'
      syncWarnings.push(
        `Scotia's mortgage interest-rate check ${last} — the monthly rate scrape may be broken ` +
          `(it retries daily until it works).`,
      )
    }
  }

  const failedLabels = new Set(syncFailures.map((f) => f.label))
  const syncEntries = SYNC_SOURCES.map((s, i) => {
    const run = syncRunRows.find((r) => r.source === s.source)
    const lastSync = mostRecentIso(syncTimes[i], run?.lastSuccessAt?.toISOString() ?? null)
    return { label: s.label, lastSync, failed: failedLabels.has(s.label) }
  })

  const all = allFlows.filter((t) => t.flow === 'expense')

  // Anchor = latest transaction month present in the data (§5), over ALL flows —
  // not just expenses — so a payday on the 1st of a new month rolls the period
  // forward immediately instead of waiting for the first card charge to post.
  const anchor = anchorMonth(allFlows)
  const months_available = availableMonths(all)
  // The just-completed month (the one before the in-progress anchor), shown only
  // if it has data — the device-local report reminder nags about it until seen.
  const dueReportMonth = completedReportMonth(anchor)
  const reminderReportMonth =
    dueReportMonth && months_available.includes(dueReportMonth) ? dueReportMonth : null
  // The just-completed YEAR (the one before the anchor's), shown only if it has
  // data — the device-local Year-in-Review reminder nags until seen/dismissed.
  const dueReportYear = completedYearReportYear(anchor)
  const reminderReportYear =
    dueReportYear && months_available.some((m) => m.slice(0, 4) === dueReportYear)
      ? dueReportYear
      : null
  // Dashboard always shows a single month; default to the current (anchor) month.
  const exactMonth = month ?? anchor

  const otherTxns = all.filter(
    (t) =>
      (t.categoryName === 'Other' || t.categoryName === 'Uncategorized') &&
      !t.categorizeDismissed &&
      exactMonth &&
      t.txnDate.slice(0, 7) === exactMonth
  ).map((t) => ({ id: t.id, merchantName: t.merchantName, amount: t.amount, txnDate: t.txnDate, category: t.categoryName }))
  const ov = buildOverview(all, 1, excludeSpecial, exactMonth, categoryCredits(allFlows))

  const insights = buildInsights(all, 1, excludeSpecial, exactMonth, await loadAlertDismissals())

  const spendDiff = ov.gross - ov.prevGross
  const totalSpendHint =
    ov.prevGross > 0
      ? spendDiff < 0
        ? `You spent ${formatCurrency(-spendDiff)} less than the previous month (same period). Nice work.`
        : spendDiff > 0
          ? `You spent ${formatCurrency(spendDiff)} more than the previous month (same period).`
          : 'Same as the previous month (same period).'
      : ov.refunds < 0
        ? `${formatCurrency(Math.abs(ov.refunds))} refunded`
        : undefined

  const countDiff = ov.count - ov.prevCount
  const txnMonthParam = exactMonth ? `?month=${exactMonth}` : ''
  const statInsights: InsightCardData[] = [
    {
      title: `${ov.count} purchases`,
      detail:
        ov.prevCount > 0
          ? countDiff === 0
            ? 'Same as the previous month.'
            : `${Math.abs(countDiff)} ${countDiff > 0 ? 'more' : 'fewer'} than the previous month.`
          : 'purchases in this period',
      tone: 'neutral',
      href: `/transactions${txnMonthParam}`,
    },
    {
      title: `${formatCurrency(ov.avg)} average purchase`,
      detail:
        ov.prevAvg > 0
          ? `Previously ${formatCurrency(ov.prevAvg)} per purchase.`
          : 'per transaction',
      tone: 'neutral',
      href: `/transactions${txnMonthParam}`,
    },
  ]
  if (ov.topTransactions.length) {
    statInsights.push({
      title: 'Biggest purchases',
      detail: ov.topTransactions
        .slice(0, 3)
        .map((t) => `${t.merchant} · ${formatCurrencyCompact(t.amount)}`)
        .join(', '),
      tone: 'neutral',
      href: `/transactions${txnMonthParam}`,
    })
  }

  const meta: CategoryMeta[] = catRows.map((c) => ({ id: c.id, name: c.name, color: c.color, kind: c.kind }))
  const savedGoals = new Map(goalRows.map((g) => [g.categoryId, Number(g.goalAmount)]))
  const budget = computeBudget(allFlows, meta, {
    targetNet: settings.targetNet,
    periodMode: settings.periodMode,
    savedGoals,
    rules,
  })
  const goalByName = new Map(budget.categories.map((c) => [c.name, c.goal]))
  // Unavoidable must match the month the burndown displays. budget.unavoidable is
  // the anchor month's; right after a month rolls over the new anchor month has
  // barely any bills posted/projected yet, so using it while viewing a past month
  // would inflate that month's discretionary pool (and its pace %).
  const burndownMonth = exactMonth ?? anchor
  const burndownUnavoidable =
    burndownMonth && burndownMonth !== budget.anchor
      ? monthlyUnavoidable(allFlows, rules, burndownMonth, FIXED_CATEGORIES)
      : budget.unavoidable
  const monthBudget = budget.monthlyCap - burndownUnavoidable.total
  let burndown: BurndownData | null = null
  if (budget.hasData && burndownMonth) {
    burndown = computeMonthBurndown(allFlows, rules, burndownMonth, monthBudget, FIXED_CATEGORIES)
  }
  const newCharges = burndown
    ? await recentCharges(Date.now(), unavoidableMerchantIds(allFlows, rules, FIXED_CATEGORIES))
    : []

  const emergency = await loadEmergencyFund()
  const goalsSummary = await loadGoalsData()
  const dashboardProjects = demo ? [] : await loadDashboardProjects()

  // Bills & recurring calendar (§19): every projected bill on its expected day,
  // plus a top-of-page reminder for bills expected within the next 2 days.
  const todayIso = new Date().toISOString().slice(0, 10)
  const ccPayments = demo ? [] : await loadCcPaymentHistory()
  const ccExpected = demo ? null : await loadCcExpectedPayment()
  const billCalendar =
    budget.hasData && exactMonth
      ? buildBillCalendar(allFlows, rules, exactMonth, FIXED_CATEGORIES, ccPayments, todayIso, ccExpected)
      : null
  const billReminders = demo
    ? []
    : buildBillReminders(allFlows, rules, FIXED_CATEGORIES, ccPayments, todayIso, await loadBillDismissals(), ccExpected)

  // Annual-subscription renewal warnings (§18b): declared-yearly subs due to
  // recharge within ~1 month, so the owner can cancel first. Skipped in the demo.
  const renewalWarnings = demo
    ? []
    : buildRenewalWarnings(
        allFlows,
        new Date().toISOString().slice(0, 10),
        await loadRenewalDismissals()
      )

  // Tapping a digest push that carried "🔥 running hot" lines lands on
  // /?paceAlert=1 — recompute the live hot list (no hysteresis: the modal shows
  // everything currently hot, even categories already alerted) and open the modal.
  const showPaceModal = rawParams.paceAlert === '1'
  const paceAlerts = showPaceModal ? computePaceAlerts(budget) : []

  const budgetInsights = buildBudgetInsights(budget, burndown)
  const allInsightCards = ov.hasData ? [...budgetInsights, ...statInsights, ...insights.cards] : []

  return (
    <AppShell>
      {showPaceModal && <PaceAlertModal alerts={paceAlerts} />}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-sm text-[var(--muted)]">
            {ov.anchor ? ov.periodLabel : 'Upload a statement to begin'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <SyncStatusBar entries={syncEntries} lastNotified={lastDigestPush} />
          <PeriodSelector
            monthDropdownOnly
            currentMonthDefault
            availableMonths={months_available}
          />
        </div>
      </div>

      <YearReportReminder year={reminderReportYear} />
      <ReportReminder month={reminderReportMonth} />

      {billReminders.length > 0 && (
        <div className="mb-5">
          <BillReminderBanner reminders={billReminders} />
        </div>
      )}

      {renewalWarnings.length > 0 && (
        <div className="mb-5">
          <RenewalWarningBanner warnings={renewalWarnings} />
        </div>
      )}

      {dashboardProjects.length > 0 && (
        <div className="mb-5">
          <ProjectReminderBanner projects={dashboardProjects} />
        </div>
      )}

      {(syncFailures.length > 0 || syncWarnings.length > 0) && (
        <div className="mb-5">
          <SyncErrorBanner failures={syncFailures} warnings={syncWarnings} />
        </div>
      )}

      {backupStale(backupLastSuccess) && (
        <div className="mb-5">
          <BackupStatusBanner lastSuccessAt={backupLastSuccess} />
        </div>
      )}

      {lastDigestRun?.status === 'fail' && (
        <div className="mb-5">
          <DigestStatusBanner lastRunAt={lastDigestRun.lastRunAt.toISOString()} error={lastDigestRun.error} />
        </div>
      )}

      {pendingReviews.length > 0 && (
        <div className="mb-5">
          <TransferReview reviews={pendingReviews} />
        </div>
      )}

      {surplusPrompts.length > 0 && (
        <div className="mb-5">
          <SurplusAllocation prompts={surplusPrompts} />
        </div>
      )}

      {otherTxns.length > 0 && (
        <div className="mb-5">
          <OtherCategoryBanner transactions={otherTxns} month={exactMonth} />
        </div>
      )}

      {emergency.hasData && (() => {
        const scotia = emergency.accounts.find((a) => a.source === 'scotia')
        const tangerine = emergency.accounts.find((a) => a.source === 'tangerine')
        if (!scotia && !tangerine) return null
        return (
          <div className="mb-5 flex flex-wrap gap-2">
            {[tangerine, scotia].filter(Boolean).map((a) => (
              <span
                key={a!.source}
                className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-sm font-semibold tabular-nums"
              >
                <span className="font-normal text-[var(--muted)]">{a!.label} </span>
                {formatCurrency(a!.balance)}
              </span>
            ))}
          </div>
        )
      })()}

      {!ov.hasData ? (
        <Card title="Get started">
          <p className="mb-4 text-sm text-[var(--muted)]">
            Upload your monthly credit-card CSV exports. We&apos;ll consolidate them, clean up
            merchant names, and surface where your money goes.
          </p>
          <UploadDialog />
          <EmptyHint>No transactions yet — your charts appear here after the first import.</EmptyHint>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {/* Total spend + per-category quick tiles */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              hero
              label="Total spend"
              value={formatCurrency(ov.gross)}
              current={ov.gross}
              previous={ov.prevGross}
              invertColors
              hint={totalSpendHint}
            />
            {ov.categoryCards.map((c) => (
              <StatCard
                key={c.name}
                label={c.label}
                value={formatCurrency(c.amount)}
                current={c.amount}
                previous={c.prevAmount}
                invertColors
                accent={c.color}
                budget={(goalByName.get(c.name) ?? 0) * 1}
                href={`/transactions?category=${encodeURIComponent(c.name)}${month ? `&month=${month}` : ''}`}
                reportHref={`/category?name=${encodeURIComponent(c.name)}`}
              />
            ))}
          </div>

          {/* Net trajectory — burndown + year trajectory side by side */}
          {(burndown || budget.hasData) && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              {burndown && (
                <Card
                  title="Net trajectory (Month)"
                  action={
                    <a href="/budget" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                      goal from budget →
                    </a>
                  }
                >
                  <BurndownTrajectory
                    data={burndown}
                    periodLabel={ov.periodLabel}
                    newCharges={newCharges}
                    unavoidableTotal={burndownUnavoidable.total}
                  />
                </Card>
              )}
              {budget.hasData && (
                <Card
                  title="Net trajectory (Year)"
                  action={
                    <span className="text-xs text-[var(--muted)]">cumulative net → Dec 31 target</span>
                  }
                >
                  <NetBudgetTrajectory
                    labels={budget.monthly.labels}
                    cumulativeNet={budget.monthly.cumulativeNet}
                    currentIndex={budget.currentMonthIndex}
                    completedBaseline={budget.completedBaseline}
                    targetNet={budget.targetNet}
                    monthsRemaining={budget.monthsRemaining}
                    onTrack={budget.completedBaseline + budget.monthsRemaining * (budget.income - budget.categories.reduce((s, c) => s + (savedGoals.get(c.categoryId) ?? c.goal), 0)) >= budget.targetNet - 0.5}
                  />
                </Card>
              )}
            </div>
          )}

          {/* Bills & recurring calendar — what's hitting this month and when */}
          {billCalendar && (
            <Card
              title="Bills calendar"
              action={
                <a href="/budget/bills" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                  manage bills →
                </a>
              }
            >
              <BillsCalendar calendar={billCalendar} todayIso={todayIso} />
            </Card>
          )}

          {/* Goals summary — read-only mini view of /accounts */}
          <GoalsSummary goals={goalsSummary.goals} />

          {/* Quick insights */}
          {allInsightCards.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-semibold">Top insights</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {allInsightCards.map((c, i) => (
                  <InsightCard key={i} card={c} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </AppShell>
  )
}
