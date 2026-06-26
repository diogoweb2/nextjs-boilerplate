import { db } from '@/db'
import { categories, customReports } from '@/db/schema'
import { Card, EmptyHint } from '@/app/components/AppShell'
import {
  CustomReports,
  type CategoryOption,
  type MerchantOption,
  type SavedReport,
} from '@/app/components/CustomReports'
import { loadEnriched } from '@/app/lib/analytics'
import {
  buildWhereToCut,
  computeReportData,
  isReportRange,
  type ReportRange,
} from '@/app/lib/custom-reports'
import { formatCurrency } from '@/app/lib/format'
import { isDemoSession } from '@/app/lib/demo'

export const dynamic = 'force-dynamic'

export default async function ReportsCustomPage() {
  const [all, catRows, reportRows] = (await isDemoSession())
    ? await (async () => {
        const d = await import('@/app/lib/demo-data')
        return [d.demoAllFlows().filter((t) => t.flow === 'expense'), d.demoCategoryRows(), d.demoCustomReports()] as const
      })()
    : await Promise.all([
        loadEnriched(),
        db.select().from(categories).orderBy(categories.name),
        db.select().from(customReports).orderBy(customReports.sortOrder),
      ])

  const hasData = all.length > 0

  const categoryOptions: CategoryOption[] = catRows.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
  }))

  const merchTotals = new Map<number, MerchantOption>()
  for (const t of all) {
    if (t.amount <= 0) continue
    const e = merchTotals.get(t.merchantId) ?? { id: t.merchantId, name: t.merchantName, total: 0 }
    e.total += t.amount
    merchTotals.set(t.merchantId, e)
  }
  const merchantOptions = [...merchTotals.values()].sort((a, b) => b.total - a.total)

  const reports: SavedReport[] = reportRows.map((r) => {
    const range: ReportRange = isReportRange(r.range) ? r.range : '6'
    return {
      id: r.id,
      name: r.name,
      pinned: r.pinned,
      range,
      series: r.series,
      computed: computeReportData(all, r.series, range),
    }
  })

  const whereToCut = buildWhereToCut(all)

  if (!hasData) {
    return (
      <Card>
        <EmptyHint>No data yet. Import a statement from the Overview page.</EmptyHint>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {whereToCut.length > 0 && (
        <Card
          title="Where to cut"
          action={
            <span className="text-xs text-[var(--muted)]">this month vs your 6-mo average</span>
          }
        >
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {whereToCut.map((c) => (
              <li key={c.name} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.color }} />
                  {c.name}
                </span>
                <div className="flex items-center gap-3 text-xs">
                  <span className="tabular-nums text-[var(--muted)]">
                    {formatCurrency(c.current)} vs {formatCurrency(c.average)}
                  </span>
                  <span className="w-24 text-right font-semibold tabular-nums text-[var(--negative)]">
                    ↑ {formatCurrency(c.over)} over
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <CustomReports
        categories={categoryOptions}
        merchants={merchantOptions}
        reports={reports}
      />
    </div>
  )
}
