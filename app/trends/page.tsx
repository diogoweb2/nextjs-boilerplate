import Link from 'next/link'
import { AppShell, Card, EmptyHint } from '@/app/components/AppShell'
import { PeriodSelector } from '@/app/components/PeriodSelector'
import { LineChart } from '@/app/components/charts/LineChart'
import { loadEnriched, buildTrends, anchorMonth, availableMonths } from '@/app/lib/analytics'
import { parsePeriodParams } from '@/app/lib/params'
import { formatCurrency, formatCurrencyCompact, formatMonth } from '@/app/lib/format'
import { loadNetWorth } from '@/app/actions/networth'

export const dynamic = 'force-dynamic'

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const rawParams = await searchParams
  const { months: parsedMonths, excludeSpecial } = parsePeriodParams(rawParams)
  const rawPeriod = Array.isArray(rawParams.period) ? rawParams.period[0] : rawParams.period

  const all = await loadEnriched()

  let months = parsedMonths
  if (rawPeriod === 'year' || rawPeriod === 'all') {
    const anchor = anchorMonth(all)
    if (anchor) {
      if (rawPeriod === 'year') {
        // Jan of anchor year through anchor month (inclusive)
        months = Number(anchor.split('-')[1])
      } else {
        // All months with any data
        months = availableMonths(all).length || parsedMonths
      }
    }
  }

  const trends = buildTrends(all, months, excludeSpecial)
  const netWorth = await loadNetWorth(trends.months_labels)

  const totalValues = trends.total.map((t) => t.amount)
  const avg = totalValues.length ? totalValues.reduce((a, b) => a + b, 0) / totalValues.length : 0

  // Month-over-month change table (most recent first).
  const momRows = trends.total
    .map((t, i) => {
      const prev = i > 0 ? trends.total[i - 1].amount : null
      const delta = prev !== null ? t.amount - prev : null
      return { ym: t.ym, amount: t.amount, delta }
    })
    .reverse()

  return (
    <AppShell>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Trends</h1>
          <p className="text-sm text-[var(--muted)]">How spending evolves month over month</p>
        </div>
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
                      {/* Mini sparkline bars */}
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
        </div>
      )}
    </AppShell>
  )
}
