import { desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { importBatches, categories, budgetGoals, syncRuns, backupRuns } from '@/db/schema'
import { AppShell, Card, EmptyHint } from '@/app/components/AppShell'
import { UploadDialog } from '@/app/components/UploadDialog'
import { PeriodSelector } from '@/app/components/PeriodSelector'
import { SyncStatusBar } from '@/app/components/SyncStatusBar'
import { SyncErrorBanner, type SyncFailure } from '@/app/components/SyncErrorBanner'
import { BackupStatusBanner } from '@/app/components/BackupStatusBanner'
import { backupStale } from '@/app/lib/backup'
import { SYNC_SOURCES, mostRecentIso } from '@/app/lib/sync'
import { StatCard } from '@/app/components/charts/StatCard'
import { Donut } from '@/app/components/charts/Donut'
import { BarList } from '@/app/components/charts/BarList'
import { WeekdayChart } from '@/app/components/charts/WeekdayChart'
import { InsightCard } from '@/app/components/InsightCard'
import { BatchList } from '@/app/components/BatchList'
import { BurndownTrajectory } from '@/app/components/BurndownTrajectory'
import { NetBudgetTrajectory } from '@/app/components/NetBudgetTrajectory'
import { loadAllFlows, buildOverview, availableMonths, anchorMonth, periodWindow } from '@/app/lib/analytics'
import { buildInsights, type InsightCard as InsightCardData } from '@/app/lib/insights'
import { parsePeriodParams } from '@/app/lib/params'
import { computeBudget, FIXED_CATEGORIES, type CategoryMeta } from '@/app/lib/budget'
import { computeBudgetRule } from '@/app/lib/fifty-thirty-twenty'
import { BudgetRuleChart } from '@/app/components/charts/BudgetRuleChart'
import { computeRunwayInputs, buildScenarios } from '@/app/lib/runway'
import { RunwayWidget } from '@/app/components/charts/RunwayWidget'
import { SafeToMoveWidget } from '@/app/components/charts/SafeToMoveWidget'
import {
  loadEmergencyFund,
  loadOutstandingCardBalance,
  recordAndLoadRunwayHistory,
} from '@/app/actions/emergency'
import { loadCashflowPlan } from '@/app/actions/cashflow'
import { loadNetWorth } from '@/app/actions/networth'
import { LineChart } from '@/app/components/charts/LineChart'
import { addMonths, monthsBetween } from '@/app/lib/mortgage'
import { computeMonthBurndown, computePeriodBurndown, type BurndownData } from '@/app/lib/projection'
import { getBudgetSettings } from '@/app/actions/budget'
import { loadProjectionRules } from '@/app/actions/projection'
import { loadPendingReviews, loadManualSavingsContributions } from '@/app/actions/goals'
import { isDemoSession } from '@/app/lib/demo'
import { TransferReview } from '@/app/components/TransferReview'
import {
  formatCurrency,
  formatCurrencyCompact,
  formatMonth,
  formatShortDate,
} from '@/app/lib/format'

export const dynamic = 'force-dynamic'

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const rawParams = await searchParams
  const { months: parsedMonths, excludeSpecial, month, current: currentParam, all: allParam } = parsePeriodParams(rawParams)
  const rawPeriod = Array.isArray(rawParams.period) ? rawParams.period[0] : rawParams.period
  const ytd = rawPeriod === 'year'
  const allTime = allParam
  // Default to "Current" (the in-progress month) when nothing is chosen.
  const current = currentParam || (!rawParams.period && !rawParams.month && !rawParams.months)

  const lastSyncQuery = (source: (typeof SYNC_SOURCES)[number]['source']) =>
    db
      .select({ createdAt: importBatches.createdAt })
      .from(importBatches)
      .where(eq(importBatches.source, source))
      .orderBy(desc(importBatches.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.createdAt?.toISOString() ?? null)

  // Most recent successful database backup (sync/backup → /api/backup-status),
  // used to warn on the dashboard when backups have gone stale.
  const lastBackupQuery = () =>
    db
      .select({ lastSuccessAt: backupRuns.lastSuccessAt })
      .from(backupRuns)
      .where(eq(backupRuns.status, 'ok'))
      .orderBy(desc(backupRuns.lastSuccessAt))
      .limit(1)
      .then((rows) => rows[0]?.lastSuccessAt?.toISOString() ?? null)

  const demo = await isDemoSession()
  const [allFlows, catRows, goalRows, settings, rules, batches, syncTimes, syncRunRows, pendingReviews, backupLastSuccess] = demo
    ? await (async () => {
        const d = await import('@/app/lib/demo-data')
        return [
          d.demoAllFlows(),
          d.demoCategoryRows(),
          d.demoBudgetGoalRows(),
          d.demoBudgetSettings(),
          d.demoProjectionRules(),
          d.demoImportBatches(),
          d.demoSyncTimes(),
          [] as (typeof syncRuns.$inferSelect)[],
          d.demoPendingReviews(),
          null as string | null,
        ] as const
      })()
    : await Promise.all([
        loadAllFlows(),
        db.select().from(categories),
        db.select().from(budgetGoals),
        getBudgetSettings(),
        loadProjectionRules(),
        db.select().from(importBatches).orderBy(desc(importBatches.createdAt)).limit(8),
        Promise.all(SYNC_SOURCES.map((s) => lastSyncQuery(s.source))),
        db.select().from(syncRuns),
        loadPendingReviews(),
        lastBackupQuery(),
      ])
  // Banks whose latest automated sync reported a failure — surfaced as a banner.
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
  const failedLabels = new Set(syncFailures.map((f) => f.label))
  const syncEntries = SYNC_SOURCES.map((s, i) => {
    const run = syncRunRows.find((r) => r.source === s.source)
    // Freshness counts empty-but-successful syncs (no batch), not just imports.
    const lastSync = mostRecentIso(syncTimes[i], run?.lastSuccessAt?.toISOString() ?? null)
    return { label: s.label, lastSync, failed: failedLabels.has(s.label) }
  })
  const all = allFlows.filter((t) => t.flow === 'expense')

  const anchor = anchorMonth(all)
  const months_available = availableMonths(all)
  const earliestYm = months_available[0] ?? null
  // "All" = every month of history; YTD = Jan of the anchor year → anchor.
  const months =
    allTime && anchor && earliestYm
      ? monthsBetween(earliestYm, anchor) + 1
      : ytd && anchor
        ? Number(anchor.slice(5, 7))
        : parsedMonths
  // "Current" scopes the page to the anchor month (like picking that exact month).
  const exactMonth = month ?? (current ? anchor : null)
  const ov = buildOverview(all, months, excludeSpecial, exactMonth)
  if (ytd) ov.periodLabel = 'Year to date'
  if (allTime) ov.periodLabel = 'All time'

  // Months (ascending) for the net-worth trend — respects the selected period.
  const ymRange = (start: string, end: string): string[] => {
    const out: string[] = []
    for (let ym = start; monthsBetween(ym, end) >= 0; ym = addMonths(ym, 1)) out.push(ym)
    return out
  }
  const netWorthMonths =
    !anchor
      ? []
      : exactMonth
        ? [exactMonth]
        : current
          ? [anchor]
          : ymRange(addMonths(anchor, -(months - 1)), anchor)
  const netWorth = await loadNetWorth(netWorthMonths)
  const insights = buildInsights(all, months, excludeSpecial, exactMonth)

  // Spending direction subtext for the Total-spend tile (same-period compare).
  const periodWord = exactMonth || months === 1 ? 'month' : 'period'
  const spendDiff = ov.gross - ov.prevGross
  const totalSpendHint =
    ov.prevGross > 0
      ? spendDiff < 0
        ? `You spent ${formatCurrency(-spendDiff)} less than the previous ${periodWord} (same period). Nice work.`
        : spendDiff > 0
          ? `You spent ${formatCurrency(spendDiff)} more than the previous ${periodWord} (same period).`
          : `Same as the previous ${periodWord}(same period).`
      : ov.refunds < 0
        ? `${formatCurrency(Math.abs(ov.refunds))} refunded`
        : undefined

  // Headline stats (transactions, avg, biggest) now live as insight cards rather
  // than KPI tiles. Prepended to the analytical insights so they lead the section.
  const countDiff = ov.count - ov.prevCount
  const statInsights: InsightCardData[] = [
    {
      title: `${ov.count} purchases`,
      detail:
        ov.prevCount > 0
          ? countDiff === 0
            ? `Same as the previous ${periodWord}.`
            : `${Math.abs(countDiff)} ${countDiff > 0 ? 'more' : 'fewer'} than the previous ${periodWord}.`
          : 'purchases in this period',
      tone: 'neutral',
    },
    {
      title: `${formatCurrency(ov.avg)} average purchase`,
      detail:
        ov.prevAvg > 0
          ? `Previously ${formatCurrency(ov.prevAvg)} per purchase.`
          : 'per transaction',
      tone: 'neutral',
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
    })
  }
  const allInsightCards = ov.hasData ? [...statInsights, ...insights.cards] : []

  // Discretionary burn-down for the trajectory widget (day-by-day for a single
  // month, month-by-month otherwise). Budget reflects live /budget settings.
  const meta: CategoryMeta[] = catRows.map((c) => ({ id: c.id, name: c.name, color: c.color, kind: c.kind }))
  const savedGoals = new Map(goalRows.map((g) => [g.categoryId, Number(g.goalAmount)]))
  const budget = computeBudget(allFlows, meta, {
    targetNet: settings.targetNet,
    periodMode: settings.periodMode,
    savedGoals,
    rules,
  })
  // Per-category monthly goal, scaled to the displayed window for the tile bars.
  // "Current"/single-month views show 1 month; multi-month periods show `months`.
  const periodMonths = exactMonth ? 1 : months
  const goalByName = new Map(budget.categories.map((c) => [c.name, c.goal]))
  const monthBudget = budget.monthlyCap - budget.unavoidable.total
  let burndown: BurndownData | null = null
  if (budget.hasData && anchor) {
    const singleMonth = current || months === 1 || Boolean(month)
    if (singleMonth) {
      burndown = computeMonthBurndown(allFlows, rules, exactMonth ?? anchor, monthBudget, FIXED_CATEGORIES)
    } else {
      const { start, end } = periodWindow(anchor, months)
      burndown = computePeriodBurndown(allFlows, rules, start, end, monthBudget, FIXED_CATEGORIES)
    }
  }

  // 50/30/20 rule for the selected period (same window as the Overview above).
  const manualContributions = await loadManualSavingsContributions()
  const ruleWindow = exactMonth
    ? { start: exactMonth, end: exactMonth }
    : anchor
      ? periodWindow(anchor, months)
      : null
  const bucketMeta = catRows.map((c) => ({ name: c.name, kind: c.kind, bucket: c.bucket }))
  const budgetRule = ruleWindow
    ? computeBudgetRule(allFlows, bucketMeta, {
        start: ruleWindow.start,
        end: ruleWindow.end,
        manualContributions,
      })
    : null

  // Emergency-fund runway (stable monthly average, independent of the selector).
  const [emergency, outstandingCards, cashflowPlan] = await Promise.all([
    loadEmergencyFund(),
    loadOutstandingCardBalance(),
    loadCashflowPlan(),
  ])
  const runwayInputs = computeRunwayInputs(allFlows, bucketMeta)
  const earnerNames = {
    self: process.env.SELF_NAME ?? 'Me',
    partner: process.env.PARTNER_NAME ?? 'Partner',
  }
  // Worst-case runway (higher earner loses job) → recorded daily for the trend.
  const availableCash = Math.max(0, emergency.total - outstandingCards)
  const worstMonths = buildScenarios(runwayInputs, availableCash, false, earnerNames).scenarios.reduce<
    number | null
  >((worst, s) => (s.months === null ? worst : worst === null ? s.months : Math.min(worst, s.months)), null)
  const runwayHistory = emergency.hasData ? await recordAndLoadRunwayHistory(worstMonths) : []

  return (
    <AppShell>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Overview</h1>
          <p className="text-sm text-[var(--muted)]">
            {ov.anchor
              ? month
                ? ov.periodLabel
                : `${ov.periodLabel} · through ${formatMonth(ov.anchor)}`
              : 'Upload a statement to begin'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <SyncStatusBar entries={syncEntries} />
          <PeriodSelector
            showCurrent
            availableMonths={months_available}
            leadingExtraOptions={[{ label: 'YTD', period: 'year' }]}
            extraOptions={[{ label: 'All', period: 'all' }]}
          />
        </div>
      </div>

      {syncFailures.length > 0 && (
        <div className="mb-5">
          <SyncErrorBanner failures={syncFailures} />
        </div>
      )}

      {backupStale(backupLastSuccess) && (
        <div className="mb-5">
          <BackupStatusBanner lastSuccessAt={backupLastSuccess} />
        </div>
      )}

      {pendingReviews.length > 0 && (
        <div className="mb-5">
          <TransferReview reviews={pendingReviews} />
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
          {/* Net worth — chequing + investments (TFSA/RESP) − mortgage owed */}
          {netWorth.hasData && (
            <Card
              title="Net worth"
              action={
                <a href="/investments" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                  investments →
                </a>
              }
            >
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-3xl font-bold tabular-nums">{formatCurrency(netWorth.netWorth)}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Chequing {formatCurrencyCompact(netWorth.assets.chequing)} + Investments{' '}
                    {formatCurrencyCompact(netWorth.assets.investments)} − Mortgage{' '}
                    {formatCurrencyCompact(netWorth.liabilities.mortgage)}
                  </p>
                </div>
              </div>
              {netWorth.series.length > 1 && (
                <div className="mt-4">
                  <LineChart
                    labels={netWorth.series.map((p) => p.ym)}
                    series={[{ color: '#10b981', values: netWorth.series.map((p) => p.value), name: 'Net worth' }]}
                  />
                </div>
              )}
            </Card>
          )}

          {/* Total spend + per-category quick tiles — tap to see that category's transactions */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Total spend"
              value={formatCurrency(ov.gross)}
              current={ov.gross}
              previous={ov.prevGross}
              invertColors
              hint={totalSpendHint}
            />
            {ov.categoryCards
              .filter((c) => c.name !== 'Uncategorized' || c.amount !== 0)
              .map((c) => (
              <StatCard
                key={c.name}
                label={c.label}
                value={formatCurrency(c.amount)}
                current={c.amount}
                previous={c.prevAmount}
                invertColors
                accent={c.color}
                budget={(goalByName.get(c.name) ?? 0) * periodMonths}
                href={`/transactions?category=${encodeURIComponent(c.name)}${month ? `&month=${month}` : ''}`}
              />
              ))}
          </div>

          {/* Net trajectory — burndown + budget trajectory side by side */}
          {(burndown || budget.hasData) && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              {burndown && (
                <Card
                  title="Net trajectory"
                  action={
                    <a href="/budget" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                      goal from budget →
                    </a>
                  }
                >
                  <BurndownTrajectory data={burndown} periodLabel={ov.periodLabel} />
                </Card>
              )}
              {budget.hasData && (
                <Card
                  title="Net trajectory"
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

          {/* 50/30/20 rule + emergency-fund runway, side by side */}
          {(budgetRule?.hasData || emergency.hasData) && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              {budgetRule?.hasData && (
                <Card
                  title="50/30/20 rule"
                  action={
                    <a href="/categories" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                      edit buckets →
                    </a>
                  }
                >
                  <BudgetRuleChart data={budgetRule} />
                </Card>
              )}

              <Card
                title="Emergency runway"
                action={
                  <a href="/goals" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                    fund →
                  </a>
                }
              >
                {emergency.hasData ? (
                  <div className="flex flex-col gap-4">
                    <RunwayWidget
                      fund={emergency.total}
                      committed={outstandingCards}
                      inputs={runwayInputs}
                      names={earnerNames}
                      history={runwayHistory}
                    />
                    <div className="border-t border-[var(--border)] pt-4">
                      <SafeToMoveWidget plan={cashflowPlan} />
                    </div>
                  </div>
                ) : (
                  <EmptyHint>
                    Set your chequing balances on the Goals page to see how many months your
                    emergency fund would cover.
                  </EmptyHint>
                )}
              </Card>
            </div>
          )}

          {/* Insights */}
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

          {/* Category + merchants */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card title="Where it went">
              {ov.byCategory.length ? (
                <Donut
                  total={ov.gross}
                  segments={ov.byCategory.map((c) => ({
                    name: c.name,
                    color: c.color,
                    amount: c.amount,
                    pct: c.pct,
                  }))}
                />
              ) : (
                <EmptyHint>No categorized spend in this period.</EmptyHint>
              )}
            </Card>

            <Card title="Top merchants">
              {ov.topMerchants.length ? (
                <BarList
                  items={ov.topMerchants.map((m) => ({
                    label: m.name,
                    amount: m.amount,
                    sublabel: `${m.count} txn`,
                  }))}
                />
              ) : (
                <EmptyHint>No merchants in this period.</EmptyHint>
              )}
            </Card>
          </div>

          {/* Weekday + top transactions */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card title="Spending by weekday">
              <WeekdayChart data={ov.byWeekday} />
              <p className="mt-3 text-xs text-[var(--muted)]">
                {Math.round(ov.weekendShare * 100)}% of spending happens on weekends.
              </p>
            </Card>

            <Card title="Biggest purchases">
              <ul className="flex flex-col divide-y divide-[var(--border)]">
                {ov.topTransactions.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <span className="block truncate font-medium">{t.merchant}</span>
                      <span className="text-xs text-[var(--muted)]">
                        {formatShortDate(t.date)} · {t.category}
                      </span>
                    </div>
                    <span className="shrink-0 font-semibold tabular-nums">
                      {formatCurrency(t.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          {/* Subscriptions + new merchants */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card title="Recurring & subscriptions">
              {insights.subscriptions.length ? (
                <ul className="flex flex-col divide-y divide-[var(--border)]">
                  {insights.subscriptions.map((s) => (
                    <li key={s.name} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{s.name}</span>
                        {!s.chargedThisPeriod && (
                          <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                            not this period
                          </span>
                        )}
                      </span>
                      <span className="tabular-nums font-medium">
                        {s.amount > 0 ? formatCurrency(s.amount) : '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyHint>
                  Mark merchants as subscriptions on the Merchants page to track them here.
                </EmptyHint>
              )}
            </Card>

            <Card title="New & unusual">
              <div className="flex flex-col gap-3">
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                    New merchants
                  </h3>
                  {insights.newMerchants.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {insights.newMerchants.map((m) => (
                        <span
                          key={m.name}
                          className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs"
                        >
                          {m.name} · {formatCurrencyCompact(m.amount)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--muted)]">None this period.</p>
                  )}
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                    Larger than usual
                  </h3>
                  {insights.outliers.length ? (
                    <ul className="flex flex-col gap-1">
                      {insights.outliers.map((o, i) => (
                        <li key={i} className="flex justify-between gap-2 text-xs">
                          <span className="truncate">
                            {o.merchant}{' '}
                            <span className="text-[var(--muted)]">({formatShortDate(o.date)})</span>
                          </span>
                          <span className="shrink-0 tabular-nums font-medium">
                            {formatCurrency(o.amount)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-[var(--muted)]">Nothing unusual.</p>
                  )}
                </div>
              </div>
            </Card>
          </div>

          {/* Upload + imports */}
          <Card title="Import a statement">
            <UploadDialog />
            <div className="mt-4 border-t border-[var(--border)] pt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                Recent imports
              </h3>
              <BatchList
                batches={batches.map((b) => ({
                  id: b.id,
                  source: b.source,
                  filename: b.filename,
                  periodLabel: b.periodLabel,
                  insertedCount: b.insertedCount,
                  createdAt: b.createdAt.toISOString(),
                }))}
              />
            </div>
          </Card>
        </div>
      )}
    </AppShell>
  )
}
