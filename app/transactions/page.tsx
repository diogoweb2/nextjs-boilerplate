import { desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { transactions, merchants, categories, merchantAmountRules } from '@/db/schema'
import { AppShell, Card, EmptyHint } from '@/app/components/AppShell'
import { TransactionsTable, type TxnRow } from '@/app/components/TransactionsTable'
import { PeriodSelector } from '@/app/components/PeriodSelector'
import { cardholderName } from '@/app/lib/cardholders'
import { parsePeriodParams } from '@/app/lib/params'
import { addMonths } from '@/app/lib/analytics'
import { isDemoSession } from '@/app/lib/demo'
import { loadProjectsForPicker, loadProjectMemberships } from '@/app/actions/projects'

export const dynamic = 'force-dynamic'

const NO_CAT = { name: 'Uncategorized', color: '#94a3b8' }

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const { category } = parsePeriodParams(sp)
  const rawMonth = Array.isArray(sp.month) ? sp.month[0] : sp.month
  const rawPeriod = Array.isArray(sp.period) ? sp.period[0] : sp.period
  const rawMonths = Number(Array.isArray(sp.months) ? sp.months[0] : sp.months)
  const monthsWindow = [1, 2, 3, 6, 12].includes(rawMonths) ? rawMonths : null

  const [rows, catRows, monthRows] = (await isDemoSession())
    ? await (async () => {
        const d = await import('@/app/lib/demo-data')
        return [d.demoActivityRows(), d.demoCategoryRows(), d.demoMonthRows()] as const
      })()
    : await Promise.all([
        db
          .select({
            id: transactions.id,
            txnDate: transactions.txnDate,
            rawDescription: transactions.rawDescription,
            note: transactions.note,
            amount: transactions.amount,
            source: transactions.source,
            flow: transactions.flow,
            cardLast4: transactions.cardLast4,
            isPayment: transactions.isPayment,
            txnCategoryId: transactions.categoryId,
            txnRecurring: transactions.isRecurring,
            txnSpecial: transactions.isSpecial,
            splitParentId: transactions.splitParentId,
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
        db.select({ txnDate: transactions.txnDate }).from(transactions),
      ])

  const [projectItems, memberships, amountRuleRows] = await Promise.all([
    loadProjectsForPicker(),
    loadProjectMemberships(),
    (await isDemoSession()) ? [] : db.select({ merchantId: merchantAmountRules.merchantId, amount: merchantAmountRules.amount }).from(merchantAmountRules),
  ])
  const amountRuleSet = new Set(amountRuleRows.map((r) => `${r.merchantId}:${r.amount}`))

  const catMap = new Map(catRows.map((c) => [c.id, c]))

  // Rows that have had parts peeled off them, so the UI can offer "Unsplit".
  const splitParentIds = new Set(
    rows.map((r) => r.splitParentId).filter((id): id is number => id != null)
  )

  const allTxns: TxnRow[] = rows.map((r) => {
    const effCatId = r.txnCategoryId ?? r.merchantCategoryId ?? null
    const cat = effCatId != null ? catMap.get(effCatId) : undefined
    return {
      id: r.id,
      merchantId: r.merchantId,
      txnDate: r.txnDate,
      merchantName: r.merchantName,
      rawDescription: r.rawDescription,
      note: r.note ?? null,
      amount: Number(r.amount),
      categoryId: effCatId,
      categoryName: cat?.name ?? NO_CAT.name,
      categoryColor: cat?.color ?? NO_CAT.color,
      isRecurring: r.txnRecurring ?? r.merchantRecurring,
      isSpecial: r.txnSpecial ?? r.merchantSpecial,
      isPayment: r.isPayment,
      source: r.source,
      flow: r.flow,
      person: cardholderName(r.cardLast4),
      isSplitPart: r.splitParentId != null,
      isSplitParent: splitParentIds.has(r.id),
      hasAmountRule: amountRuleSet.has(`${r.merchantId}:${Number(r.amount).toFixed(2)}`),
    }
  })

  const months_available = Array.from(new Set(monthRows.map((r) => r.txnDate.slice(0, 7)))).sort().reverse()
  const anchor = months_available[0] ?? null

  // Period filter precedence: explicit "all months" → everything; an exact month
  // → that month; YTD (?period=year) → Jan of the anchor year through the anchor;
  // a window (2M/3M/6M/12M) → that many months ending at the anchor;
  // nothing chosen → the current (latest) month by default.
  let txns: TxnRow[]
  if (rawMonth === 'all' || rawPeriod === 'all' || !anchor) {
    txns = allTxns
  } else if (rawMonth && /^\d{4}-\d{2}$/.test(rawMonth)) {
    txns = allTxns.filter((t) => t.txnDate.slice(0, 7) === rawMonth)
  } else if (rawPeriod === 'year') {
    const start = `${anchor.slice(0, 4)}-01`
    txns = allTxns.filter((t) => {
      const ym = t.txnDate.slice(0, 7)
      return ym >= start && ym <= anchor
    })
  } else if (monthsWindow) {
    const start = addMonths(anchor, -(monthsWindow - 1))
    txns = allTxns.filter((t) => {
      const ym = t.txnDate.slice(0, 7)
      return ym >= start && ym <= anchor
    })
  } else {
    txns = allTxns.filter((t) => t.txnDate.slice(0, 7) === anchor)
  }

  return (
    <AppShell>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Activity</h1>
          <p className="text-sm text-[var(--muted)]">
            Every transaction. Tap a row to override its category or mark it as a
            subscription or special purchase.
          </p>
        </div>
        <PeriodSelector
          showSpecialToggle={false}
          currentMonthDefault
          availableMonths={months_available}
          leadingExtraOptions={[{ label: 'YTD', period: 'year' }]}
          extraOptions={[{ label: 'ALL', period: 'all' }]}
        />
      </div>

      {txns.length === 0 ? (
        <Card>
          <EmptyHint>
            {allTxns.length === 0
              ? 'No transactions yet. Import a statement from the Overview page.'
              : 'No transactions for this period.'}
          </EmptyHint>
        </Card>
      ) : (
        <TransactionsTable
          transactions={txns}
          categories={catRows.map((c) => ({ id: c.id, name: c.name, color: c.color }))}
          projects={projectItems}
          membershipsByTxn={memberships}
          initialCategoryFilter={
            category
              ? category === NO_CAT.name || category === 'uncategorized'
                ? 'uncategorized'
                : (catRows.find((c) => c.id === Number(category) || c.name === category)?.id?.toString() ?? '')
              : ''
          }
        />
      )}
    </AppShell>
  )
}
