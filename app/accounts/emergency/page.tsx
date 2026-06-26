import { EmergencyFund } from '@/app/components/EmergencyFund'
import { loadEmergencyFund } from '@/app/actions/emergency'

export const dynamic = 'force-dynamic'

export default async function AccountsEmergencyPage() {
  const data = await loadEmergencyFund()
  return <EmergencyFund data={data} />
}
