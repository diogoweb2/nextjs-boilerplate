import { GoalsManager } from '@/app/components/GoalsManager'
import { loadGoalsData } from '@/app/actions/goals'

export const dynamic = 'force-dynamic'

export default async function AccountsGoalsPage() {
  const { goals, asOfYm, suggestNetZero, monthStats } = await loadGoalsData()
  return (
    <GoalsManager goals={goals} asOfYm={asOfYm} suggestNetZero={suggestNetZero} monthStats={monthStats} />
  )
}
