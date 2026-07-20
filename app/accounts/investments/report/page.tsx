import Link from 'next/link'
import { loadInvestmentReport } from '@/app/actions/investmentReport'
import { InvestmentReportClient } from '@/app/components/InvestmentReportClient'

export const dynamic = 'force-dynamic'

export default async function InvestmentReportPage() {
  const report = await loadInvestmentReport()
  return (
    <div className="flex flex-col gap-4">
      <Link href="/accounts/investments" className="self-start text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)]">
        ← Back to Investments
      </Link>
      <InvestmentReportClient report={report} />
    </div>
  )
}
