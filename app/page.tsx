import { desc } from 'drizzle-orm'
import { db } from '@/db'
import { importBatches } from '@/db/schema'
import { AppShell, Card, EmptyHint } from '@/app/components/AppShell'
import { UploadDialog } from '@/app/components/UploadDialog'
import { PeriodSelector } from '@/app/components/PeriodSelector'
import { StatCard } from '@/app/components/charts/StatCard'
import { Donut } from '@/app/components/charts/Donut'
import { BarList } from '@/app/components/charts/BarList'
import { WeekdayChart } from '@/app/components/charts/WeekdayChart'
import { InsightCard } from '@/app/components/InsightCard'
import { BatchList } from '@/app/components/BatchList'
import { loadEnriched, buildOverview, availableMonths } from '@/app/lib/analytics'
import { buildInsights } from '@/app/lib/insights'
import { parsePeriodParams } from '@/app/lib/params'
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
  const { months, excludeSpecial, month } = parsePeriodParams(await searchParams)
  const all = await loadEnriched()
  const ov = buildOverview(all, months, excludeSpecial, month)
  const months_available = availableMonths(all)
  const insights = buildInsights(all, months, excludeSpecial, month)

  const batches = await db
    .select()
    .from(importBatches)
    .orderBy(desc(importBatches.createdAt))
    .limit(8)

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
        <PeriodSelector availableMonths={months_available} />
      </div>

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
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Total spend"
              value={formatCurrency(ov.gross)}
              current={ov.gross}
              previous={ov.prevGross}
              invertColors
              hint={ov.refunds < 0 ? `${formatCurrency(Math.abs(ov.refunds))} refunded` : undefined}
            />
            <StatCard label="Transactions" value={String(ov.count)} hint="purchases in period" />
            <StatCard label="Avg purchase" value={formatCurrency(ov.avg)} hint="per transaction" />
            <StatCard
              label="Biggest purchase"
              value={ov.largest ? formatCurrencyCompact(ov.largest.amount) : '—'}
              hint={ov.largest ? ov.largest.merchant : undefined}
            />
          </div>

          {/* Insights */}
          {insights.cards.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-semibold">Top insights</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {insights.cards.map((c, i) => (
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
