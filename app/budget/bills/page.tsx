import { EmptyHint } from '@/app/components/AppShell'
import { ProjectionSettings } from '@/app/components/ProjectionSettings'
import { loadProjectionPanel } from '@/app/actions/projection'

export const dynamic = 'force-dynamic'

export default async function BudgetBillsPage() {
  const { hasData, active, suggestions, unavoidable, addableMerchants } = await loadProjectionPanel()

  if (!hasData) {
    return <EmptyHint>No data yet. Import a statement from the Overview page.</EmptyHint>
  }

  return (
    <ProjectionSettings
      active={active}
      suggestions={suggestions}
      unavoidable={unavoidable}
      addableMerchants={addableMerchants}
    />
  )
}
