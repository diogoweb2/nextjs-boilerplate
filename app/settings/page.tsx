import { AppShell, Card, EmptyHint } from '@/app/components/AppShell'
import { ProjectionSettings } from '@/app/components/ProjectionSettings'
import { PushToggle } from '@/app/components/PushToggle'
import { loadProjectionPanel } from '@/app/actions/projection'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const { hasData, active, suggestions, unavoidable, addableMerchants } = await loadProjectionPanel()

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

      {!hasData ? (
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
