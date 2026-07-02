import { AppShell } from '@/app/components/AppShell'
import { SectionTabs } from '@/app/components/SectionTabs'

const TABS = [
  { href: '/reports', label: 'Trends', exact: true },
  { href: '/reports/income', label: 'Income' },
  { href: '/reports/cashflow', label: 'Cash flow' },
  { href: '/reports/custom', label: 'Custom' },
]

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-xl font-bold tracking-tight">Reports</h1>
      </div>
      <SectionTabs tabs={TABS} />
      {children}
    </AppShell>
  )
}
