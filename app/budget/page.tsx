import { db } from '@/db'
import { categories, budgetGoals } from '@/db/schema'
import { Card, EmptyHint } from '@/app/components/AppShell'
import { BudgetPlanner } from '@/app/components/BudgetPlanner'
import { loadAllFlows } from '@/app/lib/analytics'
import { computeBudget, type CategoryMeta } from '@/app/lib/budget'
import { getBudgetSettings } from '@/app/actions/budget'
import { loadProjectionRules } from '@/app/actions/projection'
import { loadTfsaRoomSummary } from '@/app/actions/investments'
import { formatCurrency } from '@/app/lib/format'
import { isDemoSession } from '@/app/lib/demo'

export const dynamic = 'force-dynamic'

export default async function BudgetPage() {
  const demo = await isDemoSession()
  const [all, catRows, goalRows, settings, rules] = demo
    ? await (async () => {
        const d = await import('@/app/lib/demo-data')
        return [d.demoAllFlows(), d.demoCategoryRows(), d.demoBudgetGoalRows(), d.demoBudgetSettings(), d.demoProjectionRules()] as const
      })()
    : await Promise.all([
        loadAllFlows(),
        db.select().from(categories),
        db.select().from(budgetGoals),
        getBudgetSettings(),
        loadProjectionRules(),
      ])

  const tfsa = await loadTfsaRoomSummary()

  const meta: CategoryMeta[] = catRows.map((c) => ({ id: c.id, name: c.name, color: c.color, kind: c.kind }))
  const savedGoals = new Map(goalRows.map((g) => [g.categoryId, Number(g.goalAmount)]))
  const data = computeBudget(all, meta, {
    targetNet: settings.targetNet,
    periodMode: settings.periodMode,
    savedGoals,
    rules,
    budgetedMonth: settings.budgetedMonth,
  })

  return (
    <>
      {tfsa.hasTfsa && (
        <a
          href="/accounts/investments"
          className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 transition-colors hover:border-[var(--accent)]"
        >
          <div>
            <p className="text-xs text-[var(--muted)]">
              {tfsa.overContributed ? '⚠️ TFSA over-contributed' : 'TFSA room left to invest'}
            </p>
            <p className={`text-lg font-bold tabular-nums ${tfsa.overContributed ? 'text-[var(--negative)]' : ''}`}>
              {formatCurrency(tfsa.roomLeft)}
            </p>
          </div>
          <span className="text-right text-xs text-[var(--muted)]">
            {formatCurrency(tfsa.contributedThisYear)} contributed this year
            <span className="ml-1 text-[var(--accent)]">→</span>
          </span>
        </a>
      )}

      {!data.hasData ? (
        <Card>
          <EmptyHint>No data yet. Import a statement from the Overview page.</EmptyHint>
        </Card>
      ) : (
        <BudgetPlanner data={data} autoPropose={!demo} />
      )}
    </>
  )
}
