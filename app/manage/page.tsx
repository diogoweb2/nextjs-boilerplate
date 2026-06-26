import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { categories, merchants, transactions } from '@/db/schema'
import { CategoriesManager, type CategoryManageRow } from '@/app/components/CategoriesManager'
import { isDemoSession } from '@/app/lib/demo'

export const dynamic = 'force-dynamic'

export default async function ManageCategoriesPage() {
  const [catRows, txnCounts, merchantCats] = (await isDemoSession())
    ? await (async () => {
        const d = await import('@/app/lib/demo-data')
        const counts = d.demoCategoryCounts()
        return [d.demoCategoryRows(), counts.txnCounts, counts.merchantCats] as const
      })()
    : await Promise.all([
        db.select().from(categories).orderBy(categories.name),
        db
          .select({ categoryId: transactions.categoryId, count: sql<number>`count(*)` })
          .from(transactions)
          .groupBy(transactions.categoryId),
        db
          .select({ categoryId: merchants.categoryId, count: sql<number>`count(*)` })
          .from(transactions)
          .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
          .where(sql`${transactions.categoryId} is null`)
          .groupBy(merchants.categoryId),
      ])

  const counts = new Map<number, number>()
  for (const r of txnCounts) {
    if (r.categoryId != null) counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + Number(r.count))
  }
  for (const r of merchantCats) {
    if (r.categoryId != null) counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + Number(r.count))
  }

  const rows: CategoryManageRow[] = catRows.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    count: counts.get(c.id) ?? 0,
    bucket: c.bucket,
  }))

  return (
    <>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Recolor or rename anytime — charts update everywhere. The bucket drives the
        dashboard 50/30/20 rule (Needs / Wants / Savings).
      </p>
      <CategoriesManager categories={rows} />
    </>
  )
}
