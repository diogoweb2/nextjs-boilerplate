import { Card, EmptyHint } from '@/app/components/AppShell'
import { ProjectionSettings } from '@/app/components/ProjectionSettings'
import { loadProjectionPanel } from '@/app/actions/projection'
import { loadAllFlows, anchorMonth } from '@/app/lib/analytics'
import { buildInsights } from '@/app/lib/insights'
import { isDemoSession } from '@/app/lib/demo'
import { formatCurrency } from '@/app/lib/format'

export const dynamic = 'force-dynamic'

export default async function BudgetBillsPage() {
  const { hasData, active, suggestions, unavoidable, addableMerchants } = await loadProjectionPanel()

  if (!hasData) {
    return <EmptyHint>No data yet. Import a statement from the Overview page.</EmptyHint>
  }

  const demo = await isDemoSession()
  const allFlows = demo
    ? (await import('@/app/lib/demo-data')).demoAllFlows()
    : await loadAllFlows()

  const expenses = allFlows.filter((t) => t.flow === 'expense')
  const anchor = anchorMonth(expenses)
  const insights = buildInsights(expenses, 3, false, anchor)
  const { subscriptions } = insights

  return (
    <>
      <ProjectionSettings
        active={active}
        suggestions={suggestions}
        unavoidable={unavoidable}
        addableMerchants={addableMerchants}
      />

      {subscriptions.length > 0 && (
        <div className="mt-5">
          <Card title="Recurring & subscriptions">
            <ul className="flex flex-col divide-y divide-[var(--border)]">
              {subscriptions.map((s) => (
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
          </Card>
        </div>
      )}
    </>
  )
}
