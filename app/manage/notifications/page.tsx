import { Card } from '@/app/components/AppShell'
import { PushToggle } from '@/app/components/PushToggle'

export const dynamic = 'force-dynamic'

export default function ManageNotificationsPage() {
  return (
    <Card title="Notifications">
      <PushToggle />
    </Card>
  )
}
