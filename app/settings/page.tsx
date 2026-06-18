import { db } from '@/db'
import { merchants } from '@/db/schema'
import { AppShell, Card, EmptyHint } from '@/app/components/AppShell'
import { ProjectionSettings } from '@/app/components/ProjectionSettings'
import { PushToggle } from '@/app/components/PushToggle'
import { loadAllFlows, anchorMonth } from '@/app/lib/analytics'
import { FIXED_CATEGORIES } from '@/app/lib/budget'
import {
  suggestProjectionRules,
  projectedAmountForMonth,
  monthlyUnavoidable,
} from '@/app/lib/projection'
import { loadProjectionRules } from '@/app/actions/projection'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const [all, rules, merchantRows] = await Promise.all([
    loadAllFlows(),
    loadProjectionRules(),
    db.select().from(merchants),
  ])
  const anchor = anchorMonth(all)

  const existing = new Set(rules.map((r) => r.merchantId))
  const dismissed = new Set(merchantRows.filter((m) => m.projectionDismissed).map((m) => m.id))
  const suggestions = suggestProjectionRules(all, existing, dismissed, FIXED_CATEGORIES)

  const active = rules.map((r) => {
    const { amount, actual } = anchor ? projectedAmountForMonth(r, all, anchor) : { amount: 0, actual: false }
    return { ...r, currentAmount: amount, actual }
  })

  const unavoidable = anchor ? monthlyUnavoidable(all, rules, anchor, FIXED_CATEGORIES) : { total: 0, lines: [] }

  // Every merchant not already a rule — for adding an annual/rare bill (e.g.
  // Belair) the auto-detector can't infer from a single occurrence.
  const addableMerchants = merchantRows
    .filter((m) => !existing.has(m.id))
    .map((m) => ({ id: m.id, name: m.name }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-[var(--muted)]">
          Projected bills you can&apos;t control — used to size the monthly budget and the Net trajectory.
          Mortgage &amp; Property Tax are always fixed; everyday spend you control (groceries, dining) is
          intentionally left out.
        </p>
      </div>

      <div className="mb-5">
        <Card title="Notifications">
          <PushToggle />
        </Card>
      </div>

      {all.length === 0 ? (
        <Card>
          <EmptyHint>No data yet. Import a statement from the Overview page.</EmptyHint>
        </Card>
      ) : (
        <ProjectionSettings
          active={active}
          suggestions={suggestions}
          unavoidable={unavoidable}
          addableMerchants={addableMerchants}
        />
      )}
    </AppShell>
  )
}
