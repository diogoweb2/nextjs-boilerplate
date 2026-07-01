import { db } from '@/db'
import { categories, budgetGoals } from '@/db/schema'
import { Card, EmptyHint } from '@/app/components/AppShell'
import { BudgetPlanner } from '@/app/components/BudgetPlanner'
import { BudgetRuleChart } from '@/app/components/charts/BudgetRuleChart'
import { loadAllFlows, anchorMonth } from '@/app/lib/analytics'
import { computeBudget, type CategoryMeta } from '@/app/lib/budget'
import { computeBudgetRule } from '@/app/lib/fifty-thirty-twenty'
import { getBudgetSettings } from '@/app/actions/budget'
import { loadProjectionRules } from '@/app/actions/projection'
import { loadTfsaRoomSummary } from '@/app/actions/investments'
import { loadManualSavingsContributions } from '@/app/actions/goals'
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
  const manualContributions = demo
    ? (await import('@/app/lib/demo-data')).demoManualSavingsContributions()
    : await loadManualSavingsContributions()

  const meta: CategoryMeta[] = catRows.map((c) => ({ id: c.id, name: c.name, color: c.color, kind: c.kind }))
  const savedGoals = new Map(goalRows.map((g) => [g.categoryId, Number(g.goalAmount)]))
  const data = computeBudget(all, meta, {
    targetNet: settings.targetNet,
    periodMode: settings.periodMode,
    savedGoals,
    rules,
    budgetedMonth: settings.budgetedMonth,
  })

  // Same anchor computeBudget derives internally (over all flows, §5) — keeps the
  // 50/30/20 range in sync instead of lagging behind a payday-only new month.
  const anchor = anchorMonth(all)
  const bucketMeta = catRows.map((c) => ({ name: c.name, kind: c.kind, bucket: c.bucket }))
  const budgetRule = anchor
    ? computeBudgetRule(all, bucketMeta, {
        start: anchor,
        end: anchor,
        manualContributions,
      })
    : null

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
        <>
          <BudgetPlanner data={data} autoPropose={!demo} />

          {budgetRule?.hasData && (
            <div className="mt-5">
              <Card
                title="50/30/20 rule"
                action={
                  <a href="/manage" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                    edit buckets →
                  </a>
                }
              >
                <BudgetRuleChart data={budgetRule} month={anchor} />
              </Card>
            </div>
          )}
        </>
      )}
    </>
  )
}
