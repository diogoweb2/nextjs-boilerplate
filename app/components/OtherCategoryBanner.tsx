'use client'

import { useState, useTransition } from 'react'
import { formatCurrency } from '@/app/lib/format'
import { dismissCategorizePrompts } from '@/app/actions/transactions'

export type OtherTxn = {
  id: number
  merchantName: string
  amount: number
  txnDate: string
  category: string
}

export function OtherCategoryBanner({
  transactions,
  month,
}: {
  transactions: OtherTxn[]
  month: string | null
}) {
  // Optimistically hidden ids for this session; the server persists the dismissal
  // (so it syncs across devices) and revalidation drops them from `transactions`.
  const [dismissed, setDismissed] = useState<Set<number>>(new Set())
  const [, startTransition] = useTransition()

  const visible = transactions.filter((t) => !dismissed.has(t.id))
  if (visible.length === 0) return null

  const persist = (ids: number[]) => {
    setDismissed((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
    startTransition(() => {
      dismissCategorizePrompts(ids)
    })
  }

  const dismiss = (id: number) => persist([id])
  const dismissAll = () => persist(visible.map((t) => t.id))

  const monthParam = month ? `&month=${month}` : ''
  const hasOther = visible.some((t) => t.category === 'Other')
  const hasUncategorized = visible.some((t) => t.category === 'Uncategorized')

  return (
    <section className="card animate-in border-l-4 border-l-[var(--warning)] p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-base">⚠️</span>
          <h2 className="text-sm font-semibold">
            {visible.length === 1
              ? '1 transaction needs categorizing'
              : `${visible.length} transactions need categorizing`}
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {hasOther && (
            <a
              href={`/transactions?category=Other${monthParam}`}
              className="text-xs text-[var(--accent)] hover:underline"
            >
              Other →
            </a>
          )}
          {hasUncategorized && (
            <a
              href={`/transactions?category=Uncategorized${monthParam}`}
              className="text-xs text-[var(--accent)] hover:underline"
            >
              Uncategorized →
            </a>
          )}
          <button
            type="button"
            onClick={dismissAll}
            className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            Dismiss all
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {visible.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between gap-3 rounded-lg bg-[var(--surface-2)] px-3 py-2"
          >
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-sm font-medium">{t.merchantName}</span>
              <span className="shrink-0 text-xs text-[var(--muted)]">{t.txnDate}</span>
              <span className="shrink-0 text-xs text-[var(--muted)] opacity-60">{t.category}</span>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="tabular-nums text-sm font-semibold">{formatCurrency(t.amount)}</span>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                aria-label={`Dismiss ${t.merchantName}`}
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
