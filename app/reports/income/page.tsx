import { Card, EmptyHint } from '@/app/components/AppShell'
import { StatCard } from '@/app/components/charts/StatCard'
import { BarList } from '@/app/components/charts/BarList'
import { IncomeCharts } from '@/app/components/IncomeCharts'
import { loadAllFlows } from '@/app/lib/analytics'
import { buildIncome, type IncomeAccount } from '@/app/lib/income'
import { isReportRange, type ReportRange } from '@/app/lib/custom-reports'
import { formatCurrency, formatCurrencyCompact, formatMonth } from '@/app/lib/format'

export const dynamic = 'force-dynamic'

export default async function ReportsIncomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const rawRange = Array.isArray(sp.range) ? sp.range[0] : sp.range
  const range: ReportRange = isReportRange(rawRange) ? rawRange : '6'
  const rawAccount = Array.isArray(sp.account) ? sp.account[0] : sp.account
  const account: IncomeAccount =
    rawAccount === 'tangerine' || rawAccount === 'scotia' ? rawAccount : 'all'
  const special = Array.isArray(sp.special) ? sp.special[0] : sp.special
  const excludeSpecial = special === '0'

  const all = await loadAllFlows()
  const names = {
    self: process.env.SELF_NAME ?? 'Me',
    partner: process.env.PARTNER_NAME ?? 'Partner',
  }
  const data = buildIncome(all, range, { account, excludeSpecial }, names)

  if (!data.hasData) {
    return (
      <Card>
        <EmptyHint>
          No bank income yet. Import a Tangerine or Scotia CSV from the Overview page to populate
          this view.
        </EmptyHint>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Total income"
          value={formatCurrency(data.totalIncomeSum)}
          hint={`avg ${formatCurrencyCompact(data.avgIncome)}/mo`}
        />
        <StatCard
          label="Total spending"
          value={formatCurrency(data.totalSpendSum)}
          hint={`avg ${formatCurrencyCompact(data.avgSpend)}/mo`}
        />
        <StatCard
          label="Net (income − spend)"
          value={formatCurrency(data.netSum)}
          hint={data.netSum >= 0 ? 'saved over period' : 'overspent over period'}
        />
        <StatCard
          label="Savings rate"
          value={`${Math.round(data.savingsRate * 100)}%`}
          hint="of income kept"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label="Best month"
          value={data.best ? formatCurrencyCompact(data.best.net) : '—'}
          hint={data.best ? formatMonth(data.best.ym) : undefined}
        />
        <StatCard
          label="Worst month"
          value={data.worst ? formatCurrencyCompact(data.worst.net) : '—'}
          hint={data.worst ? formatMonth(data.worst.ym) : undefined}
        />
      </div>

      <IncomeCharts data={data} range={range} account={account} excludeSpecial={excludeSpecial} />

      <Card title="Income by source">
        {data.bySource.length ? (
          <BarList
            items={data.bySource.map((s) => ({
              label: s.name,
              amount: s.amount,
              sublabel: `${Math.round(s.pct * 100)}%`,
              color: s.color,
            }))}
          />
        ) : (
          <EmptyHint>No income in this period.</EmptyHint>
        )}
      </Card>
    </div>
  )
}
