'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  setTxnCategory,
  setTxnFlags,
  setTxnFlow,
  setTxnNote,
  upsertAmountRule,
  deleteAmountRule,
  splitTransaction,
  unsplitTransaction,
  type SplitPart,
} from '@/app/actions/transactions'
import { setMerchantFlags } from '@/app/actions/merchants'
import {
  addTransactionsToProject,
  createProject,
  type ProjectPickerItem,
} from '@/app/actions/projects'
import { formatCurrency, formatLongDate } from '@/app/lib/format'
import type { CategoryOption } from '@/app/components/MerchantsManager'

export type TxnRow = {
  id: number
  merchantId: number
  txnDate: string
  merchantName: string
  rawDescription: string
  note: string | null
  amount: number
  categoryId: number | null
  categoryName: string
  categoryColor: string
  isRecurring: boolean
  // Merchant-level "bills once a year" declaration (merchants.recurringAnnual).
  recurringAnnual: boolean
  isSpecial: boolean
  isPayment: boolean
  source: 'master' | 'amex' | 'tangerine' | 'scotia' | 'manual'
  flow: 'expense' | 'income' | 'transfer'
  person: string
  // A peeled-off part of another transaction.
  isSplitPart: boolean
  // Has had parts peeled off it (so it can be unsplit).
  isSplitParent: boolean
  // A merchant+amount rule exists — future imports of this amount will auto-fill.
  hasAmountRule: boolean
}

export function TransactionsTable({
  transactions,
  categories,
  initialCategoryFilter = '',
  initialQuery = '',
  projects = [],
  membershipsByTxn = {},
}: {
  transactions: TxnRow[]
  categories: CategoryOption[]
  initialCategoryFilter?: string
  initialQuery?: string
  projects?: ProjectPickerItem[]
  membershipsByTxn?: Record<number, ProjectPickerItem[]>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [query, setQuery] = useState(initialQuery)
  const [categoryFilter, setCategoryFilter] = useState<string>(initialCategoryFilter)
  const [hidePayments, setHidePayments] = useState(true)
  const [hideSpecial, setHideSpecial] = useState(false)
  const [recurringOnly, setRecurringOnly] = useState(false)
  const [personFilter, setPersonFilter] = useState<string>('')
  const [sourceFilter, setSourceFilter] = useState<string>('')
  const [sortBy, setSortBy] = useState<'date' | 'amount'>(
    initialCategoryFilter === 'uncategorized' ? 'amount' : 'date'
  )

  // "Uncategorized" is a synthetic dropdown option (value 'uncategorized') rather
  // than a real category row; selecting it filters to txns with no category and
  // shows the inline category picker for quick triage.
  const uncategorizedOnly = categoryFilter === 'uncategorized'

  const run = (fn: () => Promise<void>) =>
    startTransition(async () => {
      await fn()
      router.refresh()
    })

  const toggleSelect = (id: number) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const exitSelect = () => {
    setSelectMode(false)
    setSelected(new Set())
  }

  const people = useMemo(
    () => [...new Set(transactions.map((t) => t.person))].sort(),
    [transactions]
  )

  const sources = useMemo(
    () => [...new Set(transactions.map((t) => t.source))].sort(),
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
        if (sourceFilter && t.source !== sourceFilter) return false
        if (categoryFilter === 'uncategorized') {
          if (t.categoryId !== null) return false
        } else if (categoryFilter && String(t.categoryId ?? '') !== categoryFilter) {
          return false
        }
        if (q && !t.merchantName.toLowerCase().includes(q) && !t.rawDescription.toLowerCase().includes(q) && !(t.note ?? '').toLowerCase().includes(q))
          return false
        return true
      })
      .sort((a, b) =>
        sortBy === 'amount'
          ? Math.abs(b.amount) - Math.abs(a.amount)
          : a.txnDate < b.txnDate ? 1 : -1
      )
  }, [transactions, query, categoryFilter, hidePayments, hideSpecial, recurringOnly, personFilter, sourceFilter, sortBy])

  const total = rows.filter((r) => !r.isPayment).reduce((s, r) => s + r.amount, 0)

  return (
    <div className={pending ? 'opacity-70 transition-opacity' : ''}>
      <div className="mb-3 flex flex-col gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search transactions…"
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={categoryFilter}
            onChange={(e) => {
              const v = e.target.value
              setCategoryFilter(v)
              // Sorting uncategorized txns by amount surfaces the ones worth triaging first.
              if (v === 'uncategorized') setSortBy('amount')
            }}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
          >
            <option value="">All categories</option>
            <option value="uncategorized">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {sources.length > 1 && (
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm capitalize"
            >
              <option value="">All banks/cards</option>
              {sources.map((s) => (
                <option key={s} value={s} className="capitalize">
                  {s}
                </option>
              ))}
            </select>
          )}
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
          <FilterChip
            active={selectMode}
            onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
          >
            Select
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

      <div className={`card divide-y divide-[var(--border)] overflow-hidden ${selectMode && selected.size > 0 ? 'mb-20' : ''}`}>
        {rows.map((t) => (
          <TxnRowView
            key={t.id}
            t={t}
            categories={categories}
            inlineCategory={uncategorizedOnly}
            selectMode={selectMode}
            selected={selected.has(t.id)}
            onToggleSelect={() => toggleSelect(t.id)}
            memberships={membershipsByTxn[t.id] ?? []}
            onCategory={(cid) => run(() => setTxnCategory(t.id, t.merchantId, cid))}
            onFlags={(flags) => run(() => setTxnFlags(t.id, t.merchantId, flags))}
            onAnnual={(annual) => run(() => setMerchantFlags(t.merchantId, { recurringAnnual: annual }))}
            onFlow={(flow) => run(() => setTxnFlow(t.id, flow))}
            onNote={(note) => run(() => setTxnNote(t.id, note))}
            onAmountRule={(enable, note) =>
              run(() => enable ? upsertAmountRule(t.id, note) : deleteAmountRule(t.id))
            }
            onSplit={(parts) => run(() => splitTransaction(t.id, parts))}
            onUnsplit={() => run(() => unsplitTransaction(t.id))}
          />
        ))}
        {rows.length === 0 && (
          <p className="p-6 text-center text-sm text-[var(--muted)]">No transactions match.</p>
        )}
      </div>

      {selectMode && selected.size > 0 && (
        <AddToProjectBar
          count={selected.size}
          projects={projects}
          onAdd={async (projectId) => {
            await addTransactionsToProject(projectId, [...selected])
            exitSelect()
            router.refresh()
          }}
          onCreateAndAdd={async (name) => {
            const id = await createProject({ name })
            await addTransactionsToProject(id, [...selected])
            exitSelect()
            router.refresh()
          }}
          onClear={exitSelect}
        />
      )}
    </div>
  )
}

/**
 * Sticky bar shown while rows are selected on the Activity page: pick an existing
 * project (or type a new name) and add the selected transactions to it. Projects
 * are a pure overlay — this never recategorizes or alters the transactions.
 */
function AddToProjectBar({
  count,
  projects,
  onAdd,
  onCreateAndAdd,
  onClear,
}: {
  count: number
  projects: ProjectPickerItem[]
  onAdd: (projectId: number) => Promise<void>
  onCreateAndAdd: (name: string) => Promise<void>
  onClear: () => void
}) {
  const [pending, startTransition] = useTransition()
  const [value, setValue] = useState('')
  const [newName, setNewName] = useState('')

  const go = () => {
    if (value === '__new__') {
      if (!newName.trim()) return
      startTransition(() => onCreateAndAdd(newName.trim()))
    } else if (value) {
      startTransition(() => onAdd(Number(value)))
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-16 z-40 px-4 sm:bottom-4">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-lg">
        <span className="text-sm font-medium">{count} selected</span>
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
        >
          <option value="">Add to project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.emoji} {p.name}
            </option>
          ))}
          <option value="__new__">+ New project…</option>
        </select>
        {value === '__new__' && (
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New project name"
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
          />
        )}
        <button
          disabled={pending || !value || (value === '__new__' && !newName.trim())}
          onClick={go}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-fg)] disabled:opacity-40"
        >
          Add
        </button>
        <button
          onClick={onClear}
          className="ml-auto rounded-lg px-2 py-1.5 text-sm font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          Clear
        </button>
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

/**
 * Stable per-person avatar color. Names live only in env (public repo), so we
 * hash the name into a small palette instead of hardcoding name->color.
 */
const PERSON_COLORS = ['#f59e0b', '#38bdf8', '#22c55e', '#f43f5e', '#a855f7']
function personColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 33 + name.charCodeAt(i)) >>> 0
  return PERSON_COLORS[h % PERSON_COLORS.length]
}

function TxnRowView({
  t,
  categories,
  inlineCategory,
  selectMode,
  selected,
  onToggleSelect,
  memberships,
  onCategory,
  onFlags,
  onAnnual,
  onFlow,
  onNote,
  onAmountRule,
  onSplit,
  onUnsplit,
}: {
  t: TxnRow
  categories: CategoryOption[]
  inlineCategory: boolean
  selectMode: boolean
  selected: boolean
  onToggleSelect: () => void
  memberships: ProjectPickerItem[]
  onCategory: (categoryId: number | null) => void
  onFlags: (flags: { isRecurring?: boolean | null; isSpecial?: boolean | null }) => void
  /** Toggle the merchant's yearly-billing declaration (applies to all its txns). */
  onAnnual: (annual: boolean) => void
  onFlow: (flow: TxnRow['flow']) => void
  onNote: (note: string | null) => void
  onAmountRule: (enable: boolean, note: string | null) => void
  onSplit: (parts: SplitPart[]) => void
  onUnsplit: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [splitting, setSplitting] = useState(false)
  const [noteValue, setNoteValue] = useState(t.note ?? '')

  return (
    <div className={`flex flex-col gap-2 p-3 ${selected ? 'bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]' : ''}`}>
      <div className="flex items-center gap-3">
        {selectMode && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            className="h-4 w-4 shrink-0 accent-[var(--accent)]"
            aria-label="Select transaction"
          />
        )}
        <span
          className="h-8 w-1 shrink-0 rounded-full"
          style={{ background: t.categoryColor }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{t.merchantName}</span>
            {t.note && (
              <span className="truncate text-sm text-[var(--muted)]">({t.note})</span>
            )}
            {t.isSplitPart && (
              <span
                title="Split off from another transaction"
                className="rounded bg-[var(--surface-2)] px-1 text-[10px] text-[var(--muted)]"
              >
                ⑂ split
              </span>
            )}
            {t.isSplitParent && (
              <span
                title="This transaction has parts split off"
                className="rounded bg-[var(--surface-2)] px-1 text-[10px] text-[var(--muted)]"
              >
                ⑂ split origin
              </span>
            )}
            {t.isRecurring && (
              <span
                title={t.recurringAnnual ? 'Subscription — bills once a year' : 'Subscription'}
                className="text-xs text-[var(--accent)]"
              >
                ↻{t.recurringAnnual && <span className="ml-0.5 align-middle rounded bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] px-1 text-[9px] font-semibold">1y</span>}
              </span>
            )}
            {t.isSpecial && <span title="Special" className="text-xs text-amber-500">★</span>}
            {t.isPayment && (
              <span className="rounded bg-[var(--surface-2)] px-1 text-[10px] text-[var(--muted)]">
                payment
              </span>
            )}
            {memberships.map((m) => (
              <span
                key={m.id}
                title={`In project: ${m.name}`}
                className="rounded bg-[var(--surface-2)] px-1 text-[10px] text-[var(--muted)]"
              >
                {m.emoji} {m.name}
              </span>
            ))}
          </div>
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--muted)]">
            <span
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium text-[var(--foreground)]"
              style={{ background: `color-mix(in srgb, ${t.categoryColor} 18%, transparent)` }}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: t.categoryColor }}
                aria-hidden
              />
              {t.categoryName || 'Uncategorized'}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 font-medium text-[var(--foreground)]">
              <span
                className="grid h-3.5 w-3.5 place-items-center rounded-full text-[8px] font-bold text-black"
                style={{ background: personColor(t.person) }}
                aria-hidden
              >
                {t.person.charAt(0).toUpperCase()}
              </span>
              {t.person}
            </span>
            {formatLongDate(t.txnDate)} · {t.source}
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
          <label
            className="flex items-center gap-1 text-xs text-[var(--muted)]"
            title="Fix the money-flow — e.g. mark an internal transfer between your own accounts so it drops out of spend, income, runway and safe-to-move (the Emergency Fund still moves)."
          >
            Flow
            <select
              value={t.flow}
              onChange={(e) => onFlow(e.target.value as TxnRow['flow'])}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
            >
              <option value="expense">Expense</option>
              <option value="income">Income</option>
              <option value="transfer">Transfer (internal)</option>
            </select>
          </label>
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
          {t.isRecurring && (
            <button
              onClick={() => onAnnual(!t.recurringAnnual)}
              title={t.recurringAnnual
                ? 'Marked as a yearly bill — click if it actually bills more often'
                : 'Bills once a year? Mark it so a quiet year doesn\'t look like a cancelled subscription'}
              className={`rounded-md px-2 py-1 text-xs font-medium ${
                t.recurringAnnual
                  ? 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]'
                  : 'text-[var(--muted)] hover:bg-[var(--surface-2)]'
              }`}
            >
              1y yearly
            </button>
          )}
          <button
            onClick={() => onFlags({ isSpecial: !t.isSpecial })}
            className={`rounded-md px-2 py-1 text-xs font-medium ${
              t.isSpecial ? 'bg-amber-500/15 text-amber-500' : 'text-[var(--muted)] hover:bg-[var(--surface-2)]'
            }`}
          >
            ★ Special
          </button>
          <button
            onClick={() => onAmountRule(!t.hasAmountRule, noteValue || null)}
            title={t.hasAmountRule
              ? `Remove rule — future ${formatCurrency(Math.abs(t.amount))} imports from this merchant will no longer be auto-filled`
              : `Remember — future ${formatCurrency(Math.abs(t.amount))} imports from this merchant will auto-get this category and note`}
            className={`rounded-md px-2 py-1 text-xs font-medium ${
              t.hasAmountRule
                ? 'bg-emerald-500/15 text-emerald-500'
                : 'text-[var(--muted)] hover:bg-[var(--surface-2)]'
            }`}
          >
            {t.hasAmountRule ? '✓ ' : ''}Remember {formatCurrency(Math.abs(t.amount))}
          </button>
          {!t.isSplitPart && !t.isPayment && (
            <button
              onClick={() => setSplitting((v) => !v)}
              className={`rounded-md px-2 py-1 text-xs font-medium ${
                splitting
                  ? 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]'
                  : 'text-[var(--muted)] hover:bg-[var(--surface-2)]'
              }`}
            >
              ⑂ Split
            </button>
          )}
          {t.isSplitParent && (
            <button
              onClick={onUnsplit}
              className="rounded-md px-2 py-1 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface-2)]"
            >
              ↩ Unsplit
            </button>
          )}
          <input
            value={noteValue}
            onChange={(e) => setNoteValue(e.target.value)}
            onBlur={() => onNote(noteValue || null)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
            placeholder="Add a note…"
            className="min-w-[180px] flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs placeholder:text-[var(--muted)]"
          />
          <span className="text-[11px] text-[var(--muted)]" title={t.rawDescription}>
            {t.rawDescription}
          </span>
        </div>
      )}

      {expanded && splitting && (
        <SplitForm
          t={t}
          categories={categories}
          onCancel={() => setSplitting(false)}
          onSubmit={(parts) => {
            setSplitting(false)
            onSplit(parts)
          }}
        />
      )}
    </div>
  )
}

/**
 * Peel one or more parts off a transaction. The remainder stays on the original
 * row; each part gets its own amount, category, and merchant label (defaulting
 * to the same merchant). The remainder is shown live and must stay positive.
 */
function SplitForm({
  t,
  categories,
  onCancel,
  onSubmit,
}: {
  t: TxnRow
  categories: CategoryOption[]
  onCancel: () => void
  onSubmit: (parts: SplitPart[]) => void
}) {
  const total = Math.abs(t.amount)
  const [parts, setParts] = useState<
    { amount: string; categoryId: string; label: string }[]
  >([{ amount: '', categoryId: '', label: t.merchantName }])

  const update = (i: number, patch: Partial<(typeof parts)[number]>) =>
    setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  const peeledOff = parts.reduce((s, p) => s + (Number(p.amount) || 0), 0)
  const remainder = total - peeledOff
  const valid =
    parts.every((p) => Number(p.amount) > 0 && p.label.trim()) &&
    remainder > 0.0049

  return (
    <div className="animate-in mt-1 flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <p className="text-[11px] text-[var(--muted)]">
        Split {formatCurrency(total)} — the rest stays on {t.merchantName}.
      </p>
      {parts.map((p, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={p.amount}
            onChange={(e) => update(i, { amount: e.target.value })}
            placeholder="0.00"
            className="w-24 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs tabular-nums"
          />
          <input
            value={p.label}
            onChange={(e) => update(i, { label: e.target.value })}
            placeholder="Merchant label"
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
          />
          <select
            value={p.categoryId}
            onChange={(e) => update(i, { categoryId: e.target.value })}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
          >
            <option value="">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {parts.length > 1 && (
            <button
              onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}
              className="rounded-md px-1.5 py-1 text-xs text-[var(--muted)] hover:bg-[var(--surface)]"
              aria-label="Remove part"
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          onClick={() =>
            setParts((ps) => [...ps, { amount: '', categoryId: '', label: t.merchantName }])
          }
          className="rounded-md px-2 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--surface)]"
        >
          + Add part
        </button>
        <span
          className={`text-[11px] tabular-nums ${
            remainder > 0.0049 ? 'text-[var(--muted)]' : 'text-red-500'
          }`}
        >
          Remainder on {t.merchantName}: {formatCurrency(remainder)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          disabled={!valid}
          onClick={() =>
            onSubmit(
              parts.map((p) => ({
                amount: Number(p.amount),
                categoryId: p.categoryId ? Number(p.categoryId) : null,
                label: p.label.trim(),
              }))
            )
          }
          className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-[var(--accent-fg)] disabled:opacity-40"
        >
          Save split
        </button>
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-1 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface)]"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
