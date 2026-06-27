import Link from 'next/link'
import { AppShell, Card, EmptyHint } from '@/app/components/AppShell'
import { LineChart } from '@/app/components/charts/LineChart'
import { PeriodSelector } from '@/app/components/PeriodSelector'
import { loadEnriched, buildTrends, anchorMonth, availableMonths, loadCategoryCredits } from '@/app/lib/analytics'
import { formatCurrency, formatMonth } from '@/app/lib/format'

export const dynamic = 'force-dynamic'

export default async function CategoryHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const rawParams = await searchParams
  const rawName = Array.isArray(rawParams.name) ? rawParams.name[0] : rawParams.name
  const categoryName = rawName ?? ''

  const rawMonths = Number(Array.isArray(rawParams.months) ? rawParams.months[0] : rawParams.months)
  const period = Array.isArray(rawParams.period) ? rawParams.period[0] : rawParams.period

  const [all, credits] = await Promise.all([loadEnriched(), loadCategoryCredits()])
  const anchor = anchorMonth(all)

  let months = [3, 6, 12].includes(rawMonths) ? rawMonths : 12
  if (period === 'all' && anchor) {
    months = availableMonths(all).length || 12
  }

  const trends = buildTrends(all, months, false, null, credits)
  const cat = trends.categories.find((c) => c.name === categoryName)

  const monthlyRows = cat
    ? trends.months_labels.map((ym, i) => ({ ym, amount: cat.series[i] ?? 0 })).reverse()
    : []

  const avg = cat && cat.series.length
    ? cat.series.reduce((a, b) => a + b, 0) / cat.series.length
    : 0

  const dotStyle = cat ? { background: cat.color } : {}

  return (
    <AppShell>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            ← Overview
          </Link>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            {cat && <span className="inline-block h-3 w-3 rounded-full" style={dotStyle} />}
            {categoryName || 'Category'}
          </h1>
        </div>
        <PeriodSelector
          showSpecialToggle={false}
          periodOptions={[3, 6, 12]}
          extraOptions={[{ label: 'All', period: 'all' }]}
        />
      </div>

      {!cat ? (
        <Card title={categoryName}>
          <EmptyHint>No spending found for this category in the selected period.</EmptyHint>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          <Card
            title="Monthly spend"
            action={<span className="text-xs text-[var(--muted)]">avg {formatCurrency(avg)}/mo</span>}
          >
            <LineChart
              labels={trends.months_labels}
              series={[{ color: cat.color, values: cat.series, name: categoryName }]}
            />
          </Card>

          <Card title="Month by month">
            <ul className="flex flex-col divide-y divide-[var(--border)]">
              {monthlyRows.map((r) => (
                <li key={r.ym} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <Link
                    href={`/transactions?month=${r.ym}&category=${encodeURIComponent(categoryName)}`}
                    className="font-medium hover:text-[var(--accent)]"
                  >
                    {formatMonth(r.ym)}
                  </Link>
                  <span className="tabular-nums">
                    {r.amount > 0 ? formatCurrency(r.amount) : <span className="text-[var(--muted)]">—</span>}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </AppShell>
  )
}
