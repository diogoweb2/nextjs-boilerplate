import { Card, EmptyHint } from '@/app/components/AppShell'
import { StatCard } from '@/app/components/charts/StatCard'
import { CashflowCharts } from '@/app/components/CashflowCharts'
import { loadAllFlows, availableMonths } from '@/app/lib/analytics'
import { buildCashflowSankey } from '@/app/lib/cashflow-sankey'
import { isReportRange, type ReportRange } from '@/app/lib/custom-reports'
import { formatCurrency, formatMonth } from '@/app/lib/format'

export const dynamic = 'force-dynamic'

export default async function ReportsCashflowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const rawRange = Array.isArray(sp.range) ? sp.range[0] : sp.range
  const range: ReportRange = isReportRange(rawRange) ? rawRange : '3'
  const special = Array.isArray(sp.special) ? sp.special[0] : sp.special
  const excludeSpecial = special === '0'

  const all = await loadAllFlows()
  const monthOptions = availableMonths(all) // newest first
  const rawMonth = Array.isArray(sp.month) ? sp.month[0] : sp.month
  const month = rawMonth && monthOptions.includes(rawMonth) ? rawMonth : null

  const names = {
    self: process.env.SELF_NAME ?? 'Me',
    partner: process.env.PARTNER_NAME ?? 'Partner',
  }
  const data = buildCashflowSankey(all, range, names, { excludeSpecial, month })

  if (!data.hasData) {
    return (
      <Card>
        <EmptyHint>No data in this period yet. Import a statement from the Overview page.</EmptyHint>
      </Card>
    )
  }

  const first = data.months[0]
  const last = data.months[data.months.length - 1]
  const periodLabel =
    first && last && first !== last ? `${formatMonth(first)} – ${formatMonth(last)}` : last ? formatMonth(last) : ''

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Income" value={formatCurrency(data.totalIncome)} hint={periodLabel} />
        <StatCard label="Spending" value={formatCurrency(data.totalSpend)} hint={periodLabel} />
        <StatCard
          label={data.net >= 0 ? 'Saved' : 'Overspent'}
          value={formatCurrency(Math.abs(data.net))}
          hint={
            data.totalIncome > 0
              ? `${Math.round((data.net / data.totalIncome) * 100)}% of income`
              : undefined
          }
        />
      </div>

      <Card title="Cash flow">
        <CashflowCharts
          data={data}
          range={range}
          month={month}
          monthOptions={monthOptions}
          excludeSpecial={excludeSpecial}
        />
        <p className="mt-3 text-xs text-[var(--muted)]">
          Income sources flow into spending categories. Reimbursements net against their category;
          transfers and card payments are excluded. Click a category bar to see its transactions.
        </p>
      </Card>
    </div>
  )
}
