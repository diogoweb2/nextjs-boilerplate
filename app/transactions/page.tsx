import { desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { transactions, merchants, categories } from '@/db/schema'
import { AppShell, Card, EmptyHint } from '@/app/components/AppShell'
import { TransactionsTable, type TxnRow } from '@/app/components/TransactionsTable'
import { cardholderName } from '@/app/lib/cardholders'

export const dynamic = 'force-dynamic'

const NO_CAT = { name: 'Uncategorized', color: '#94a3b8' }

export default async function TransactionsPage() {
  const [rows, catRows] = await Promise.all([
    db
      .select({
        id: transactions.id,
        txnDate: transactions.txnDate,
        rawDescription: transactions.rawDescription,
        amount: transactions.amount,
        source: transactions.source,
        cardLast4: transactions.cardLast4,
        isPayment: transactions.isPayment,
        txnCategoryId: transactions.categoryId,
        txnRecurring: transactions.isRecurring,
        txnSpecial: transactions.isSpecial,
        merchantId: merchants.id,
        merchantName: merchants.name,
        merchantCategoryId: merchants.categoryId,
        merchantRecurring: merchants.defaultRecurring,
        merchantSpecial: merchants.defaultSpecial,
      })
      .from(transactions)
      .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
      .orderBy(desc(transactions.txnDate))
      .limit(2000),
    db.select().from(categories).orderBy(categories.name),
  ])

  const catMap = new Map(catRows.map((c) => [c.id, c]))

  const txns: TxnRow[] = rows.map((r) => {
    const effCatId = r.txnCategoryId ?? r.merchantCategoryId ?? null
    const cat = effCatId != null ? catMap.get(effCatId) : undefined
    return {
      id: r.id,
      merchantId: r.merchantId,
      txnDate: r.txnDate,
      merchantName: r.merchantName,
      rawDescription: r.rawDescription,
      amount: Number(r.amount),
      categoryId: effCatId,
      categoryName: cat?.name ?? NO_CAT.name,
      categoryColor: cat?.color ?? NO_CAT.color,
      isRecurring: r.txnRecurring ?? r.merchantRecurring,
      isSpecial: r.txnSpecial ?? r.merchantSpecial,
      isPayment: r.isPayment,
      source: r.source,
      person: cardholderName(r.cardLast4),
    }
  })

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight">Activity</h1>
        <p className="text-sm text-[var(--muted)]">
          Every transaction. Tap a row to override its category or mark it as a
          subscription or special purchase.
        </p>
      </div>

      {txns.length === 0 ? (
        <Card>
          <EmptyHint>No transactions yet. Import a statement from the Overview page.</EmptyHint>
        </Card>
      ) : (
        <TransactionsTable
          transactions={txns}
          categories={catRows.map((c) => ({ id: c.id, name: c.name, color: c.color }))}
        />
      )}
    </AppShell>
  )
}
