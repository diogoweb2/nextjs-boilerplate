import { AppShell } from '@/app/components/AppShell'
import { SectionTabs } from '@/app/components/SectionTabs'

const TABS = [
  { href: '/manage', label: 'Categories', exact: true },
  { href: '/manage/merchants', label: 'Merchants' },
  { href: '/manage/projects', label: 'Projects' },
  { href: '/manage/notifications', label: 'Notifications' },
  { href: '/manage/import', label: 'Import' },
]

export default function ManageLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-xl font-bold tracking-tight">Manage</h1>
      </div>
      <SectionTabs tabs={TABS} />
      {children}
    </AppShell>
  )
}
