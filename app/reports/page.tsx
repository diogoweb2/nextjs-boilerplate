import Link from 'next/link'
import { Card, EmptyHint } from '@/app/components/AppShell'
import { PeriodSelector } from '@/app/components/PeriodSelector'
import { LineChart } from '@/app/components/charts/LineChart'
import { Donut } from '@/app/components/charts/Donut'
import { BarList } from '@/app/components/charts/BarList'
import { WeekdayChart } from '@/app/components/charts/WeekdayChart'
import { loadEnriched, buildTrends, buildOverview, anchorMonth, availableMonths, loadCategoryCredits } from '@/app/lib/analytics'
import { buildInsights } from '@/app/lib/insights'
import { parsePeriodParams } from '@/app/lib/params'
import { formatCurrency, formatCurrencyCompact, formatMonth, formatShortDate } from '@/app/lib/format'
import { loadNetWorth } from '@/app/actions/networth'

export const dynamic = 'force-dynamic'

export default async function ReportsTrendsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const rawParams = await searchParams
  const { months: parsedMonths, excludeSpecial } = parsePeriodParams(rawParams)
  const rawPeriod = Array.isArray(rawParams.period) ? rawParams.period[0] : rawParams.period

  const [all, credits] = await Promise.all([loadEnriched(), loadCategoryCredits()])

  let months = parsedMonths
  if (rawPeriod === 'year' || rawPeriod === 'all') {
    const anchor = anchorMonth(all)
    if (anchor) {
      if (rawPeriod === 'year') {
        months = Number(anchor.split('-')[1])
      } else {
        months = availableMonths(all).length || parsedMonths
      }
    }
  }

  const trends = buildTrends(all, months, excludeSpecial, null, credits)
  const netWorth = await loadNetWorth(trends.months_labels)
  const ov = buildOverview(all, months, excludeSpecial, null, credits)
  const insights = buildInsights(all, months, excludeSpecial)

  const totalValues = trends.total.map((t) => t.amount)
  const avg = totalValues.length ? totalValues.reduce((a, b) => a + b, 0) / totalValues.length : 0

  const momRows = trends.total
    .map((t, i) => {
      const prev = i > 0 ? trends.total[i - 1].amount : null
      const delta = prev !== null ? t.amount - prev : null
      return { ym: t.ym, amount: t.amount, delta }
    })
    .reverse()

  return (
    <>
      <div className="mb-5 flex justify-end">
        <PeriodSelector
          periodOptions={[2, 3, 6, 12]}
          extraOptions={[
            { label: 'YTD', period: 'year' },
            { label: 'All', period: 'all' },
          ]}
        />
      </div>

      {!trends.hasData ? (
        <Card>
          <EmptyHint>No data yet. Import a statement from the Overview page.</EmptyHint>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {netWorth.hasData && (
            <Card
              title="Net worth"
              action={
                <a href="/accounts/investments" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
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

          <Card
            title="Monthly spend"
            action={<span className="text-xs text-[var(--muted)]">avg {formatCurrency(avg)}/mo</span>}
          >
            <LineChart
              labels={trends.months_labels}
              series={[{ color: 'var(--accent)', values: totalValues }]}
            />
          </Card>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card title="By category">
              <ul className="flex flex-col gap-3">
                {trends.categories.slice(0, 8).map((c) => {
                  const max = Math.max(1, ...c.series)
                  return (
                    <li key={c.name} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-2 font-medium">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ background: c.color }}
                          />
                          {c.name}
                        </span>
                        <div className="flex flex-col items-end">
                          <span className="tabular-nums">{formatCurrency(c.total)}</span>
                          <span className="tabular-nums text-xs text-[var(--muted)]">
                            avg {formatCurrency(c.series.reduce((a, b) => a + b, 0) / c.series.length)}/mo
                          </span>
                        </div>
                      </div>
                      <div className="flex h-8 items-end gap-0.5">
                        {c.series.map((v, i) => {
                          const catParam = c.categoryId != null ? String(c.categoryId) : 'uncategorized'
                          const href = `/transactions?month=${trends.months_labels[i]}&category=${catParam}`
                          return (
                            <Link
                              key={i}
                              href={href}
                              className="flex-1 rounded-sm transition-opacity hover:opacity-100"
                              style={{
                                height: `${Math.max(4, (v / max) * 100)}%`,
                                background: c.color,
                                opacity: i === c.series.length - 1 ? 1 : 0.45,
                              }}
                              title={`${formatMonth(trends.months_labels[i])}: ${formatCurrency(v)} — click to view transactions`}
                            />
                          )
                        })}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </Card>

            <Card title="Month over month">
              <ul className="flex flex-col divide-y divide-[var(--border)]">
                {momRows.map((r) => (
                  <li key={r.ym} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="font-medium">{formatMonth(r.ym)}</span>
                    <div className="flex items-center gap-3">
                      <span className="tabular-nums">{formatCurrency(r.amount)}</span>
                      {r.delta !== null && Math.abs(r.delta) > 0.5 ? (
                        <span
                          className={`w-20 text-right text-xs tabular-nums font-medium ${
                            r.delta > 0 ? 'text-[var(--negative)]' : 'text-[var(--positive)]'
                          }`}
                        >
                          {r.delta > 0 ? '↑' : '↓'} {formatCurrency(Math.abs(r.delta))}
                        </span>
                      ) : (
                        <span className="w-20 text-right text-xs text-[var(--muted)]">—</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          {/* Where it went + top merchants */}
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

          {/* Spending by weekday */}
          <Card title="Spending by weekday">
            <WeekdayChart data={ov.byWeekday} />
            <p className="mt-3 text-xs text-[var(--muted)]">
              {Math.round(ov.weekendShare * 100)}% of spending happens on weekends.
            </p>
          </Card>

          {/* New & unusual */}
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
      )}
    </>
  )
}
