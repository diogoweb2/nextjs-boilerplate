import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { merchants, categories, transactions } from '@/db/schema'
import Link from 'next/link'
import { AppShell, Card, EmptyHint } from '@/app/components/AppShell'
import { MerchantsManager, type MerchantRow } from '@/app/components/MerchantsManager'

export const dynamic = 'force-dynamic'

export default async function MerchantsPage() {
  const [merchantRows, catRows, totals, monthCounts] = await Promise.all([
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

  // Only show merchants that actually have non-payment transactions.
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
    <AppShell>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Merchants</h1>
          <p className="text-sm text-[var(--muted)]">
            Rename, categorize, and group merchants. Changes apply to past and future
            uploads automatically. Select two or more to merge duplicates.
          </p>
        </div>
        <Link
          href="/categories"
          className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
        >
          Categories →
        </Link>
      </div>

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
    </AppShell>
  )
}
