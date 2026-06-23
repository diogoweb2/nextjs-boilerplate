import { AppShell } from '@/app/components/AppShell'
import { GoalsManager } from '@/app/components/GoalsManager'
import { EmergencyFund } from '@/app/components/EmergencyFund'
import { loadGoalsData } from '@/app/actions/goals'
import { loadEmergencyFund } from '@/app/actions/emergency'

export const dynamic = 'force-dynamic'

export default async function GoalsPage() {
  const [{ goals, asOfYm, suggestNetZero, monthStats }, emergency] = await Promise.all([
    loadGoalsData(),
    loadEmergencyFund(),
  ])
  return (
    <AppShell>
      <GoalsManager goals={goals} asOfYm={asOfYm} suggestNetZero={suggestNetZero} monthStats={monthStats} />
      <div className="mt-5">
        <EmergencyFund data={emergency} />
      </div>
    </AppShell>
  )
}
