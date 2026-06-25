import { AppShell } from '@/app/components/AppShell'
import { InvestmentsManager } from '@/app/components/InvestmentsManager'
import { loadInvestmentsData } from '@/app/actions/investments'

export const dynamic = 'force-dynamic'

export default async function InvestmentsPage() {
  const data = await loadInvestmentsData()
  return (
    <AppShell>
      <InvestmentsManager data={data} />
    </AppShell>
  )
}
