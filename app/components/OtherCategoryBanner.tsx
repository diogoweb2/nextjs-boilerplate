'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCurrency } from '@/app/lib/format'
import { dismissCategorizePrompts, setTxnCategory } from '@/app/actions/transactions'
import { suggestCategories, type CategorySuggestion } from '@/app/actions/categorize-ai'
import type { CategoryOption } from '@/app/components/MerchantsManager'

export type OtherTxn = {
  id: number
  merchantId: number
  merchantName: string
  amount: number
  txnDate: string
  category: string
  categoryId: number | null
}

export function OtherCategoryBanner({
  transactions,
  month,
  categories,
  aiAvailable,
}: {
  transactions: OtherTxn[]
  month: string | null
  categories: CategoryOption[]
  /** OPENROUTER_API_KEY is set server-side, so the suggest button is worth showing. */
  aiAvailable: boolean
}) {
  const router = useRouter()
  // Optimistically hidden ids for this session; the server persists the dismissal
  // (so it syncs across devices) and revalidation drops them from `transactions`.
  const [dismissed, setDismissed] = useState<Set<number>>(new Set())
  // Rows already saved this session — hidden immediately, gone after revalidation.
  const [done, setDone] = useState<Set<number>>(new Set())
  // Pending per-row choice: an AI suggestion or a manual change, not yet saved.
  const [picked, setPicked] = useState<Record<number, number>>({})
  const [reasons, setReasons] = useState<Record<number, string>>({})
  const [suggesting, setSuggesting] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const visible = transactions.filter((t) => !dismissed.has(t.id) && !done.has(t.id))
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

  // Saving teaches the merchant (same rule as the Transactions page), so the row
  // leaves the list on revalidation — hide it immediately meanwhile.
  const save = (t: OtherTxn, categoryId: number) => {
    setDone((prev) => new Set(prev).add(t.id))
    startTransition(async () => {
      await setTxnCategory(t.id, t.merchantId, categoryId)
      router.refresh()
    })
  }

  const saveAll = () => {
    const ready = visible.filter((t) => picked[t.id])
    if (ready.length === 0) return
    setDone((prev) => {
      const next = new Set(prev)
      for (const t of ready) next.add(t.id)
      return next
    })
    startTransition(async () => {
      for (const t of ready) await setTxnCategory(t.id, t.merchantId, picked[t.id])
      router.refresh()
    })
  }

  // Suggestions never write anything: they only pre-select the dropdowns, so every
  // row still needs an explicit Save (or Save all) from the owner.
  const suggest = async () => {
    setSuggesting(true)
    setAiError(null)
    try {
      const res = await suggestCategories(
        visible.map((t) => ({
          id: t.id,
          merchantName: t.merchantName,
          amount: t.amount,
          txnDate: t.txnDate,
        }))
      )
      if (!res.ok) {
        setAiError(res.error)
        return
      }
      setPicked((prev) => applySuggestions(prev, res.suggestions))
      setReasons((prev) => {
        const next = { ...prev }
        for (const s of res.suggestions) next[s.txnId] = s.reason
        return next
      })
    } catch (e) {
      setAiError(e instanceof Error ? e.message : 'Suggestion failed.')
    } finally {
      setSuggesting(false)
    }
  }

  const dismiss = (id: number) => persist([id])
  const dismissAll = () => persist(visible.map((t) => t.id))

  const monthParam = month ? `&month=${month}` : ''
  const hasOther = visible.some((t) => t.category === 'Other')
  const hasUncategorized = visible.some((t) => t.category === 'Uncategorized')
  const pendingCount = visible.filter((t) => picked[t.id]).length

  return (
    <section className="card animate-in border-l-4 border-l-[var(--warning)] p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-base">⚠️</span>
          <h2 className="text-sm font-semibold">
            {visible.length === 1
              ? '1 transaction needs categorizing'
              : `${visible.length} transactions need categorizing`}
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {aiAvailable && (
            <button
              type="button"
              onClick={suggest}
              disabled={suggesting}
              className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--surface-2)] disabled:opacity-60"
            >
              {suggesting && <Spinner />}
              {suggesting ? 'Suggesting…' : 'Suggest categories'}
            </button>
          )}
          {pendingCount > 0 && (
            <button
              type="button"
              onClick={saveAll}
              className="rounded-lg bg-[var(--accent)] px-2 py-1 text-xs font-medium text-black"
            >
              Save {pendingCount}
            </button>
          )}
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
      {aiError && (
        <p className="mb-2 text-xs text-[var(--negative)]">Suggestions failed: {aiError}</p>
      )}
      <div className="flex flex-col gap-1.5">
        {visible.map((t) => {
          const value = picked[t.id] ?? t.categoryId
          const suggested = picked[t.id] !== undefined
          return (
            <div
              key={t.id}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--surface-2)] px-3 py-2 ${
                suggesting ? 'animate-pulse' : ''
              }`}
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-sm font-medium">{t.merchantName}</span>
                <span className="shrink-0 text-xs text-[var(--muted)]">{t.txnDate}</span>
                {suggested && reasons[t.id] && (
                  <span className="shrink-0 text-xs text-[var(--muted)] opacity-70">
                    ✨ {reasons[t.id]}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="tabular-nums text-sm font-semibold">{formatCurrency(t.amount)}</span>
                <select
                  value={value ?? ''}
                  onChange={(e) => {
                    const cid = e.target.value ? Number(e.target.value) : null
                    setPicked((prev) => {
                      const next = { ...prev }
                      if (cid === null) delete next[t.id]
                      else next[t.id] = cid
                      return next
                    })
                    setReasons((prev) => {
                      const next = { ...prev }
                      delete next[t.id]
                      return next
                    })
                  }}
                  className={`max-w-[150px] rounded-lg border bg-[var(--surface)] px-2 py-1 text-xs ${
                    suggested ? 'border-[var(--accent)]' : 'border-[var(--border)]'
                  }`}
                  aria-label={`Category for ${t.merchantName}`}
                >
                  <option value="">Uncategorized</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {value ? (
                  <button
                    type="button"
                    onClick={() => save(t, value)}
                    className="text-xs font-medium text-[var(--accent)] hover:underline"
                  >
                    Save
                  </button>
                ) : null}
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
          )
        })}
      </div>
    </section>
  )
}

function applySuggestions(
  prev: Record<number, number>,
  suggestions: CategorySuggestion[]
): Record<number, number> {
  const next = { ...prev }
  for (const s of suggestions) next[s.txnId] = s.categoryId
  return next
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent"
    />
  )
}
