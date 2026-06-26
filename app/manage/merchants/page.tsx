import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { merchants, categories, transactions } from '@/db/schema'
import { Card, EmptyHint } from '@/app/components/AppShell'
import { MerchantsManager, type MerchantRow } from '@/app/components/MerchantsManager'
import { isDemoSession } from '@/app/lib/demo'

export const dynamic = 'force-dynamic'

export default async function ManageMerchantsPage() {
  const [merchantRows, catRows, totals, monthCounts] = (await isDemoSession())
    ? await (async () => {
        const d = await import('@/app/lib/demo-data')
        const agg = d.demoMerchantTotals()
        return [d.demoMerchantRows(), d.demoCategoryRows(), agg.totals, agg.monthCounts] as const
      })()
    : await Promise.all([
        db.select().from(merchants),
        db.select().from(categories).orderBy(categories.name),
        db
          .select({
            merchantId: transactions.merchantId,
            total: sql<string>`coalesce(sum(${transactions.amount}), 0)`,
            count: sql<number>`count(*)`,
          })
          .from(transactions)
          .where(eq(transactions.isPayment, false))
          .groupBy(transactions.merchantId),
        db
          .select({
            merchantId: transactions.merchantId,
            monthCount: sql<number>`count(distinct to_char(${transactions.txnDate}, 'YYYY-MM'))`,
          })
          .from(transactions)
          .where(eq(transactions.isPayment, false))
          .groupBy(transactions.merchantId),
      ])

  const totalsMap = new Map(
    totals.map((t) => [t.merchantId, { total: Number(t.total), count: Number(t.count) }])
  )
  const monthCountMap = new Map(
    monthCounts.map((r) => [r.merchantId, Number(r.monthCount)])
  )

  const rows: MerchantRow[] = merchantRows
    .map((m) => {
      const agg = totalsMap.get(m.id)
      return {
        id: m.id,
        name: m.name,
        categoryId: m.categoryId,
        defaultRecurring: m.defaultRecurring,
        defaultSpecial: m.defaultSpecial,
        total: agg?.total ?? 0,
        count: agg?.count ?? 0,
        monthCount: monthCountMap.get(m.id) ?? 0,
      }
    })
    .filter((m) => m.count > 0)

  return (
    <>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Rename, categorize, and group merchants. Changes apply to past and future
        uploads automatically. Select two or more to merge duplicates.
      </p>
      {rows.length === 0 ? (
        <Card>
          <EmptyHint>No merchants yet. Import a statement from the Overview page.</EmptyHint>
        </Card>
      ) : (
        <MerchantsManager
          merchants={rows}
          categories={catRows.map((c) => ({ id: c.id, name: c.name, color: c.color }))}
        />
      )}
    </>
  )
}
