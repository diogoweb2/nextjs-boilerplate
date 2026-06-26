import { InvestmentsManager } from '@/app/components/InvestmentsManager'
import { loadInvestmentsData } from '@/app/actions/investments'

export const dynamic = 'force-dynamic'

export default async function AccountsInvestmentsPage() {
  const data = await loadInvestmentsData()
  return <InvestmentsManager data={data} />
}
