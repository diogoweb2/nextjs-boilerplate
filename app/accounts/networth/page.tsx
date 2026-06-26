import { Card, EmptyHint } from '@/app/components/AppShell'
import { LineChart } from '@/app/components/charts/LineChart'
import { loadEnriched, buildTrends, anchorMonth } from '@/app/lib/analytics'
import { loadNetWorth } from '@/app/actions/networth'
import { formatCurrency, formatCurrencyCompact } from '@/app/lib/format'

export const dynamic = 'force-dynamic'

export default async function AccountsNetWorthPage() {
  const all = await loadEnriched()
  const anchor = anchorMonth(all)
  const months = anchor ? Number(anchor.split('-')[1]) : 12
  const trends = buildTrends(all, months, false)
  const netWorth = await loadNetWorth(trends.months_labels)

  if (!netWorth.hasData) {
    return (
      <Card>
        <EmptyHint>
          No net-worth data yet. Set up your emergency fund and investments to see this view.
        </EmptyHint>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <Card title="Net worth">
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

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <Card title="Chequing">
          <p className="text-2xl font-bold tabular-nums">{formatCurrency(netWorth.assets.chequing)}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">Tangerine + Scotia</p>
        </Card>
        <Card title="Investments">
          <p className="text-2xl font-bold tabular-nums">{formatCurrency(netWorth.assets.investments)}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">TFSA + RESP</p>
        </Card>
        <Card title="Mortgage remaining">
          <p className="text-2xl font-bold tabular-nums text-[var(--negative)]">
            {formatCurrency(netWorth.liabilities.mortgage)}
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">outstanding balance</p>
        </Card>
      </div>
    </div>
  )
}
