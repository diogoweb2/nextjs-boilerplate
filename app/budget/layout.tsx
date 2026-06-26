import { AppShell } from '@/app/components/AppShell'
import { SectionTabs } from '@/app/components/SectionTabs'

const TABS = [
  { href: '/budget', label: 'Planner', exact: true },
  { href: '/budget/bills', label: 'Bills' },
]

export default function BudgetLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-xl font-bold tracking-tight">Budget</h1>
      </div>
      <SectionTabs tabs={TABS} />
      {children}
    </AppShell>
  )
}
