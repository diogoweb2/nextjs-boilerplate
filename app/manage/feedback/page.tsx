import { asc } from 'drizzle-orm'
import { db } from '@/db'
import { feedbackItems } from '@/db/schema'
import { FeedbackManager } from '@/app/components/FeedbackManager'
import { isDemoSession } from '@/app/lib/demo'

export const dynamic = 'force-dynamic'

export default async function ManageFeedbackPage() {
  const items = (await isDemoSession())
    ? []
    : await db.select().from(feedbackItems).orderBy(asc(feedbackItems.sortOrder), asc(feedbackItems.createdAt))

  return (
    <>
      <p className="mb-4 text-sm text-[var(--muted)]">
        A running list of bugs to fix and ideas to build. Mark one complete to move it out of the active list.
      </p>
      <FeedbackManager items={items} />
    </>
  )
}
