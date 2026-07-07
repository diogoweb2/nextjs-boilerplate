import { Card } from '@/app/components/AppShell'
import { ThemeToggle } from '@/app/components/ThemeToggle'

// Matches the rest of /manage: the shared nav reads search params at request time.
export const dynamic = 'force-dynamic'

export default function ManageAppearancePage() {
  return (
    <>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Pick how Pereira Lope$ looks on this device. The numbers stay just as alarming
        either way.
      </p>
      <Card title="Appearance">
        <ThemeToggle />
      </Card>
    </>
  )
}
