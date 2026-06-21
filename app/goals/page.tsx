import { AppShell } from '@/app/components/AppShell'
import { GoalsManager } from '@/app/components/GoalsManager'
import { loadGoalsData } from '@/app/actions/goals'

export const dynamic = 'force-dynamic'

export default async function GoalsPage() {
  const { goals, asOfYm, suggestNetZero, monthStats } = await loadGoalsData()
  return (
    <AppShell>
      <GoalsManager goals={goals} asOfYm={asOfYm} suggestNetZero={suggestNetZero} monthStats={monthStats} />
    </AppShell>
  )
}
