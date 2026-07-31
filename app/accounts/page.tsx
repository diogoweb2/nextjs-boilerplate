import { GoalsManager } from '@/app/components/GoalsManager'
import { loadGoalsData, loadSpendCategories, loadGoalSpendLog } from '@/app/actions/goals'

export const dynamic = 'force-dynamic'

export default async function AccountsGoalsPage() {
  const [{ goals, asOfYm, suggestNetZero, monthStats }, spendCategories, spendLog] = await Promise.all([
    loadGoalsData(),
    loadSpendCategories(),
    loadGoalSpendLog(),
  ])
  return (
    <GoalsManager
      goals={goals}
      asOfYm={asOfYm}
      suggestNetZero={suggestNetZero}
      monthStats={monthStats}
      spendCategories={spendCategories}
      spendLog={spendLog}
    />
  )
}
