import Link from 'next/link'
import { buildMonthReport } from '@/app/lib/monthReport'
import { parsePeriodParams } from '@/app/lib/params'
import { ReportClient } from './ReportClient'
import './report-theme.css'

export const dynamic = 'force-dynamic'

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { month } = parsePeriodParams(await searchParams)
  const { report, months } = await buildMonthReport(month)

  if (!report) {
    return (
      <div className="report-80s flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="report-title text-3xl">No recap yet</h1>
        <p className="text-[var(--ink-dim)]">Import a couple of months of statements and your first report lands here.</p>
        <Link href="/" className="report-btn px-4 py-2 text-sm">← Back to the app</Link>
      </div>
    )
  }

  return <ReportClient report={report} months={months} />
}
