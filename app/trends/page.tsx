import { AppShell, Card, EmptyHint } from '@/app/components/AppShell'
import { PeriodSelector } from '@/app/components/PeriodSelector'
import { LineChart } from '@/app/components/charts/LineChart'
import { loadEnriched, buildTrends } from '@/app/lib/analytics'
import { parsePeriodParams } from '@/app/lib/params'
import { formatCurrency, formatMonth } from '@/app/lib/format'

export const dynamic = 'force-dynamic'

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { months, excludeSpecial } = parsePeriodParams(await searchParams)
  const all = await loadEnriched()
  const trends = buildTrends(all, months, excludeSpecial)

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
        <PeriodSelector />
      </div>

      {!trends.hasData ? (
        <Card>
          <EmptyHint>No data yet. Import a statement from the Overview page.</EmptyHint>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
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
                        <span className="tabular-nums text-[var(--muted)]">
                          {formatCurrency(c.total)}
                        </span>
                      </div>
                      {/* Mini sparkline bars */}
                      <div className="flex h-8 items-end gap-0.5">
                        {c.series.map((v, i) => (
                          <div
                            key={i}
                            className="flex-1 rounded-sm"
                            style={{
                              height: `${Math.max(4, (v / max) * 100)}%`,
                              background: c.color,
                              opacity: i === c.series.length - 1 ? 1 : 0.45,
                            }}
                            title={`${formatMonth(trends.months_labels[i])}: ${formatCurrency(v)}`}
                          />
                        ))}
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
