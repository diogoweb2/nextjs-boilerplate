import { AppShell } from '@/app/components/AppShell'
import { PlannedSplitsManager } from '@/app/components/PlannedSplitsManager'
import { loadPlannedSplits, loadPlannedSplitOptions } from '@/app/actions/planned-splits'

export const dynamic = 'force-dynamic'

/**
 * Activity › Planned — "future custom imports" (BUSINESS_RULES.md §22). Written
 * on the phone at the till, applied by the next import.
 */
export default async function PlannedSplitsPage() {
  const [rows, options] = await Promise.all([loadPlannedSplits(), loadPlannedSplitOptions()])

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight">Planned splits</h1>
        <p className="text-sm text-[var(--muted)]">
          Tell the importer about a purchase before it posts, so it lands in the right category on
          arrival. <a href="/transactions" className="underline">Back to Activity</a>
        </p>
      </div>
      <PlannedSplitsManager rows={rows} options={options} />
    </AppShell>
  )
}
