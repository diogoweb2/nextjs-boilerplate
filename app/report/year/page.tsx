import Link from 'next/link'
import { buildYearReport } from '@/app/lib/yearReport'
import { YearReportClient } from './YearReportClient'
import './report-90s-theme.css'

export const dynamic = 'force-dynamic'

export default async function YearReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const raw = params.year
  const requested = typeof raw === 'string' && /^\d{4}$/.test(raw) ? raw : null
  const { report, years } = await buildYearReport(requested)

  if (!report) {
    return (
      <div className="report-90s flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="report-title text-3xl">No year to review yet</h1>
        <p className="text-[var(--ink-dim)]">Import some statements and your first Year in Review lands here.</p>
        <Link href="/" className="report-btn px-4 py-2 text-sm">← Back to the app</Link>
      </div>
    )
  }

  return <YearReportClient report={report} years={years} />
}
