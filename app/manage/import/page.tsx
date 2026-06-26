import { desc } from 'drizzle-orm'
import { db } from '@/db'
import { importBatches } from '@/db/schema'
import { Card } from '@/app/components/AppShell'
import { UploadDialog } from '@/app/components/UploadDialog'
import { BatchList } from '@/app/components/BatchList'
import { isDemoSession } from '@/app/lib/demo'

export const dynamic = 'force-dynamic'

export default async function ManageImportPage() {
  const demo = await isDemoSession()
  const batches = demo
    ? (await import('@/app/lib/demo-data')).demoImportBatches()
    : await db.select().from(importBatches).orderBy(desc(importBatches.createdAt)).limit(20)

  return (
    <Card title="Import a statement">
      {!demo && <UploadDialog />}
      {demo && (
        <p className="mb-4 text-sm text-[var(--muted)]">
          Uploads are disabled in the demo. Sign in to import your own statements.
        </p>
      )}
      <div className="mt-4 border-t border-[var(--border)] pt-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          Recent imports
        </h3>
        <BatchList
          batches={batches.map((b) => ({
            id: b.id,
            source: b.source,
            filename: b.filename,
            periodLabel: b.periodLabel,
            insertedCount: b.insertedCount,
            createdAt: b.createdAt.toISOString(),
          }))}
        />
      </div>
    </Card>
  )
}
