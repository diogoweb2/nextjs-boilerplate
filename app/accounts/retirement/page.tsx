import { RetirementPlan } from '@/app/components/RetirementPlan'
import { loadRetirementData } from '@/app/actions/retirement'

export const dynamic = 'force-dynamic'

export default async function AccountsRetirementPage() {
  const data = await loadRetirementData()
  return <RetirementPlan data={data} />
}
