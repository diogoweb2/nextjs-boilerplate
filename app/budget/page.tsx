import { db } from '@/db'
import { categories, budgetGoals } from '@/db/schema'
import { AppShell, Card, EmptyHint } from '@/app/components/AppShell'
import { BudgetPlanner } from '@/app/components/BudgetPlanner'
import { loadAllFlows } from '@/app/lib/analytics'
import { computeBudget, type CategoryMeta } from '@/app/lib/budget'
import { getBudgetSettings } from '@/app/actions/budget'

export const dynamic = 'force-dynamic'

export default async function BudgetPage() {
  const [all, catRows, goalRows, settings] = await Promise.all([
    loadAllFlows(),
    db.select().from(categories),
    db.select().from(budgetGoals),
    getBudgetSettings(),
  ])

  const meta: CategoryMeta[] = catRows.map((c) => ({ id: c.id, name: c.name, color: c.color, kind: c.kind }))
  const savedGoals = new Map(goalRows.map((g) => [g.categoryId, Number(g.goalAmount)]))
  const data = computeBudget(all, meta, {
    targetNet: settings.targetNet,
    periodMode: settings.periodMode,
    savedGoals,
  })

  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-xl font-bold tracking-tight">Budget</h1>
        <p className="text-sm text-[var(--muted)]">
          How much can I spend this month — excluding unavoidable bills — to finish the year net 0?
        </p>
      </div>

      {!data.hasData ? (
        <Card>
          <EmptyHint>No data yet. Import a statement from the Overview page.</EmptyHint>
        </Card>
      ) : (
        <BudgetPlanner data={data} />
      )}
    </AppShell>
  )
}
