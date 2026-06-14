'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  renameMerchant,
  setMerchantCategory,
  setMerchantFlags,
  mergeMerchants,
} from '@/app/actions/merchants'
import { formatCurrency } from '@/app/lib/format'

export type MerchantRow = {
  id: number
  name: string
  categoryId: number | null
  defaultRecurring: boolean
  defaultSpecial: boolean
  total: number
  count: number
}
export type CategoryOption = { id: number; name: string; color: string }

export function MerchantsManager({
  merchants,
  categories,
}: {
  merchants: MerchantRow[]
  categories: CategoryOption[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [winner, setWinner] = useState<number | null>(null)

  const run = (fn: () => Promise<void>) =>
    startTransition(async () => {
      await fn()
      router.refresh()
    })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return merchants
      .filter((m) => !q || m.name.toLowerCase().includes(q))
      .sort((a, b) => b.total - a.total)
  }, [merchants, query])

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      // Default the merge winner to the highest-spend selected merchant.
      const ids = [...next]
      if (ids.length && (winner === null || !next.has(winner))) {
        const top = merchants
          .filter((m) => next.has(m.id))
          .sort((a, b) => b.total - a.total)[0]
        setWinner(top?.id ?? null)
      }
      if (ids.length === 0) setWinner(null)
      return next
    })
  }

  const doMerge = () => {
    if (winner === null || selected.size < 2) return
    const losers = [...selected].filter((id) => id !== winner)
    run(async () => {
      await mergeMerchants(winner, losers)
      setSelected(new Set())
      setWinner(null)
    })
  }

  return (
    <div className={pending ? 'opacity-70 transition-opacity' : ''}>
      <div className="mb-3 flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search merchants…"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
      </div>

      {/* Merge action bar */}
      {selected.size >= 2 && (
        <div className="card animate-in mb-3 flex flex-col gap-2 border-[var(--accent)] p-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm font-medium">
            Merge {selected.size} merchants into:
          </span>
          <div className="flex items-center gap-2">
            <select
              value={winner ?? ''}
              onChange={(e) => setWinner(Number(e.target.value))}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
            >
              {[...selected].map((id) => {
                const m = merchants.find((x) => x.id === id)
                return (
                  <option key={id} value={id}>
                    {m?.name}
                  </option>
                )
              })}
            </select>
            <button
              onClick={doMerge}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[var(--accent-fg)]"
            >
              Merge
            </button>
            <button
              onClick={() => {
                setSelected(new Set())
                setWinner(null)
              }}
              className="rounded-lg px-2 py-1.5 text-sm text-[var(--muted)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="card divide-y divide-[var(--border)] overflow-hidden">
        {filtered.map((m) => (
          <MerchantRowView
            key={m.id}
            m={m}
            categories={categories}
            selected={selected.has(m.id)}
            onToggleSelect={() => toggleSelect(m.id)}
            onRename={(name) => run(() => renameMerchant(m.id, name))}
            onCategory={(cid) => run(() => setMerchantCategory(m.id, cid))}
            onFlags={(flags) => run(() => setMerchantFlags(m.id, flags))}
          />
        ))}
        {filtered.length === 0 && (
          <p className="p-6 text-center text-sm text-[var(--muted)]">No merchants found.</p>
        )}
      </div>
    </div>
  )
}

function MerchantRowView({
  m,
  categories,
  selected,
  onToggleSelect,
  onRename,
  onCategory,
  onFlags,
}: {
  m: MerchantRow
  categories: CategoryOption[]
  selected: boolean
  onToggleSelect: () => void
  onRename: (name: string) => void
  onCategory: (categoryId: number | null) => void
  onFlags: (flags: { defaultRecurring?: boolean; defaultSpecial?: boolean }) => void
}) {
  const [name, setName] = useState(m.name)

  return (
    <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
      <div className="flex flex-1 items-center gap-2.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="h-4 w-4 shrink-0 accent-[var(--accent)]"
          title="Select for merge"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== m.name && onRename(name)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-sm font-medium outline-none hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)]"
        />
      </div>

      <div className="flex items-center justify-between gap-2 sm:justify-end">
        <span className="hidden w-24 text-right text-xs tabular-nums text-[var(--muted)] sm:inline">
          {m.count} txn
        </span>
        <span className="w-24 text-right text-sm font-semibold tabular-nums">
          {formatCurrency(m.total)}
        </span>

        <select
          value={m.categoryId ?? ''}
          onChange={(e) => onCategory(e.target.value ? Number(e.target.value) : null)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
        >
          <option value="">Uncategorized</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <button
          onClick={() => onFlags({ defaultRecurring: !m.defaultRecurring })}
          title="Recurring subscription"
          className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
            m.defaultRecurring
              ? 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]'
              : 'text-[var(--muted)] hover:bg-[var(--surface-2)]'
          }`}
        >
          ↻ Sub
        </button>
        <button
          onClick={() => onFlags({ defaultSpecial: !m.defaultSpecial })}
          title="Special / reimbursable — excluded from charts when filtered"
          className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
            m.defaultSpecial
              ? 'bg-amber-500/15 text-amber-500'
              : 'text-[var(--muted)] hover:bg-[var(--surface-2)]'
          }`}
        >
          ★ Special
        </button>
      </div>
    </div>
  )
}
