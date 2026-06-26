import { AppShell } from '@/app/components/AppShell'
import { SectionTabs } from '@/app/components/SectionTabs'

const TABS = [
  { href: '/accounts', label: 'Goals', exact: true },
  { href: '/accounts/emergency', label: 'Emergency' },
  { href: '/accounts/investments', label: 'Investments' },
  { href: '/accounts/networth', label: 'Net worth' },
]

export default function AccountsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-xl font-bold tracking-tight">Accounts</h1>
      </div>
      <SectionTabs tabs={TABS} />
      {children}
    </AppShell>
  )
}
