'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setTxnCategory, setTxnFlags } from '@/app/actions/transactions'
import { formatCurrency, formatShortDate } from '@/app/lib/format'
import type { CategoryOption } from '@/app/components/MerchantsManager'

export type TxnRow = {
  id: number
  merchantId: number
  txnDate: string
  merchantName: string
  rawDescription: string
  amount: number
  categoryId: number | null
  categoryName: string
  categoryColor: string
  isRecurring: boolean
  isSpecial: boolean
  isPayment: boolean
  source: 'master' | 'amex' | 'tangerine' | 'scotia'
  person: string
}

export function TransactionsTable({
  transactions,
  categories,
  initialCategoryFilter = '',
}: {
  transactions: TxnRow[]
  categories: CategoryOption[]
  initialCategoryFilter?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>(
    initialCategoryFilter === 'uncategorized' ? '' : initialCategoryFilter
  )
  const [hidePayments, setHidePayments] = useState(true)
  const [hideSpecial, setHideSpecial] = useState(false)
  const [recurringOnly, setRecurringOnly] = useState(false)
  const [uncategorizedOnly, setUncategorizedOnly] = useState(initialCategoryFilter === 'uncategorized')
  const [personFilter, setPersonFilter] = useState<string>('')
  const [sortBy, setSortBy] = useState<'date' | 'amount'>('date')

  const run = (fn: () => Promise<void>) =>
    startTransition(async () => {
      await fn()
      router.refresh()
    })

  const people = useMemo(
    () => [...new Set(transactions.map((t) => t.person))].sort(),
    [transactions]
  )

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return transactions
      .filter((t) => {
        if (hidePayments && t.isPayment) return false
        if (hideSpecial && t.isSpecial) return false
        if (recurringOnly && !t.isRecurring) return false
        if (personFilter && t.person !== personFilter) return false
        if (uncategorizedOnly && t.categoryId !== null) return false
        if (categoryFilter && String(t.categoryId ?? '') !== categoryFilter) return false
        if (q && !t.merchantName.toLowerCase().includes(q) && !t.rawDescription.toLowerCase().includes(q))
          return false
        return true
      })
      .sort((a, b) =>
        sortBy === 'amount'
          ? Math.abs(b.amount) - Math.abs(a.amount)
          : a.txnDate < b.txnDate ? 1 : -1
      )
  }, [transactions, query, categoryFilter, hidePayments, hideSpecial, recurringOnly, uncategorizedOnly, personFilter, sortBy])

  const total = rows.filter((r) => !r.isPayment).reduce((s, r) => s + r.amount, 0)

  return (
    <div className={pending ? 'opacity-70 transition-opacity' : ''}>
      <div className="mb-3 flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transactions…"
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={() => { setUncategorizedOnly((v) => !v); if (!uncategorizedOnly) setSortBy('amount') }}
            className={`shrink-0 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
              uncategorizedOnly
                ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]'
            }`}
          >
            {uncategorizedOnly ? '✓ ' : ''}Uncategorized
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <FilterChip active={hidePayments} onClick={() => setHidePayments((v) => !v)}>
            Hide payments
          </FilterChip>
          <FilterChip active={hideSpecial} onClick={() => setHideSpecial((v) => !v)}>
            Hide special
          </FilterChip>
          <FilterChip active={recurringOnly} onClick={() => setRecurringOnly((v) => !v)}>
            Subscriptions only
          </FilterChip>
          <FilterChip active={sortBy === 'amount'} onClick={() => setSortBy((v) => v === 'amount' ? 'date' : 'amount')}>
            Sort by amount
          </FilterChip>
          {people.length > 1 &&
            people.map((p) => (
              <FilterChip
                key={p}
                active={personFilter === p}
                onClick={() => setPersonFilter((cur) => (cur === p ? '' : p))}
              >
                {p}
              </FilterChip>
            ))}
        </div>
        <p className="text-xs text-[var(--muted)]">
          {rows.length} transactions · {formatCurrency(total)}
        </p>
      </div>

      <div className="card divide-y divide-[var(--border)] overflow-hidden">
        {rows.map((t) => (
          <TxnRowView
            key={t.id}
            t={t}
            categories={categories}
            inlineCategory={uncategorizedOnly}
            onCategory={(cid) => run(() => setTxnCategory(t.id, t.merchantId, cid))}
            onFlags={(flags) => run(() => setTxnFlags(t.id, flags))}
          />
        ))}
        {rows.length === 0 && (
          <p className="p-6 text-center text-sm text-[var(--muted)]">No transactions match.</p>
        )}
      </div>
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)]'
          : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]'
      }`}
    >
      {active ? '✓ ' : ''}
      {children}
    </button>
  )
}

function TxnRowView({
  t,
  categories,
  inlineCategory,
  onCategory,
  onFlags,
}: {
  t: TxnRow
  categories: CategoryOption[]
  inlineCategory: boolean
  onCategory: (categoryId: number | null) => void
  onFlags: (flags: { isRecurring?: boolean | null; isSpecial?: boolean | null }) => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-3">
        <span
          className="h-8 w-1 shrink-0 rounded-full"
          style={{ background: t.categoryColor }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{t.merchantName}</span>
            {t.isRecurring && <span title="Subscription" className="text-xs text-[var(--accent)]">↻</span>}
            {t.isSpecial && <span title="Special" className="text-xs text-amber-500">★</span>}
            {t.isPayment && (
              <span className="rounded bg-[var(--surface-2)] px-1 text-[10px] text-[var(--muted)]">
                payment
              </span>
            )}
          </div>
          <span className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 font-medium text-[var(--foreground)]">
              <span
                className="grid h-3.5 w-3.5 place-items-center rounded-full bg-[var(--accent)] text-[8px] font-bold text-[var(--accent-fg)]"
                aria-hidden
              >
                {t.person.charAt(0).toUpperCase()}
              </span>
              {t.person}
            </span>
            {formatShortDate(t.txnDate)} · {t.source}
          </span>
        </div>
        {inlineCategory && (
          <select
            value={t.categoryId ?? ''}
            onChange={(e) => onCategory(e.target.value ? Number(e.target.value) : null)}
            className="shrink-0 max-w-[140px] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
          >
            <option value="">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
        <span
          className={`shrink-0 text-sm font-semibold tabular-nums ${
            t.amount < 0 ? 'text-[var(--positive)]' : ''
          }`}
        >
          {t.amount < 0 ? '+' : ''}
          {formatCurrency(Math.abs(t.amount))}
        </span>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded-md px-1.5 py-1 text-xs text-[var(--muted)] hover:bg-[var(--surface-2)]"
          aria-label="Edit"
        >
          {expanded ? '▲' : '⋯'}
        </button>
      </div>

      {expanded && (
        <div className="animate-in flex flex-wrap items-center gap-2 pl-4">
          {!inlineCategory && (
            <select
              value={t.categoryId ?? ''}
              onChange={(e) => onCategory(e.target.value ? Number(e.target.value) : null)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
            >
              <option value="">Inherit ({t.categoryName})</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => onFlags({ isRecurring: !t.isRecurring })}
            className={`rounded-md px-2 py-1 text-xs font-medium ${
              t.isRecurring
                ? 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]'
                : 'text-[var(--muted)] hover:bg-[var(--surface-2)]'
            }`}
          >
            ↻ Subscription
          </button>
          <button
            onClick={() => onFlags({ isSpecial: !t.isSpecial })}
            className={`rounded-md px-2 py-1 text-xs font-medium ${
              t.isSpecial ? 'bg-amber-500/15 text-amber-500' : 'text-[var(--muted)] hover:bg-[var(--surface-2)]'
            }`}
          >
            ★ Special
          </button>
          <span className="text-[11px] text-[var(--muted)]" title={t.rawDescription}>
            {t.rawDescription}
          </span>
        </div>
      )}
    </div>
  )
}
