'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card, EmptyHint } from '@/app/components/AppShell'
import { formatCurrency } from '@/app/lib/format'
import {
  createPlannedSplit,
  updatePlannedSplit,
  deletePlannedSplit,
  type PlannedSplitRow,
  type PlannedSplitOptions,
  type PlannedSplitInput,
} from '@/app/actions/planned-splits'

const INPUT_CLASS =
  'w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]'

const LABEL_CLASS = 'mb-1 block text-xs font-medium text-[var(--muted)]'

type Draft = {
  merchantLabel: string
  minAmount: string
  splitAmount: string
  label: string
  categoryId: string
  goalId: string
}

const EMPTY: Draft = {
  merchantLabel: '',
  minAmount: '',
  splitAmount: '',
  label: '',
  categoryId: '',
  goalId: '',
}

function draftFrom(row: PlannedSplitRow): Draft {
  return {
    merchantLabel: row.merchantLabel,
    minAmount: row.minAmount != null ? String(row.minAmount) : '',
    splitAmount: String(row.splitAmount),
    label: row.label,
    categoryId: row.categoryId != null ? String(row.categoryId) : '',
    goalId: row.goalId != null ? String(row.goalId) : '',
  }
}

function toInput(d: Draft, options: PlannedSplitOptions): PlannedSplitInput | null {
  const merchantLabel = d.merchantLabel.trim()
  const label = d.label.trim()
  const splitAmount = Number(d.splitAmount)
  if (!merchantLabel || !label || !Number.isFinite(splitAmount) || splitAmount <= 0) return null
  const min = Number(d.minAmount)
  return {
    merchantLabel,
    merchantId:
      options.merchants.find((m) => m.name.toLowerCase() === merchantLabel.toLowerCase())?.id ?? null,
    minAmount: d.minAmount.trim() && Number.isFinite(min) && min > 0 ? min : null,
    splitAmount,
    label,
    categoryId: d.categoryId ? Number(d.categoryId) : null,
    goalId: d.goalId ? Number(d.goalId) : null,
  }
}

function Form({
  draft,
  setDraft,
  options,
  submitLabel,
  onSubmit,
  onCancel,
  pending,
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  options: PlannedSplitOptions
  submitLabel: string
  onSubmit: () => void
  onCancel?: () => void
  pending: boolean
}) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })
  const valid = toInput(draft, options) !== null

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL_CLASS} htmlFor="ps-place">
            Place
          </label>
          <input
            id="ps-place"
            list="ps-merchants"
            className={INPUT_CLASS}
            placeholder="Metro"
            value={draft.merchantLabel}
            onChange={(e) => set({ merchantLabel: e.target.value })}
          />
          <datalist id="ps-merchants">
            {options.merchants.map((m) => (
              <option key={m.id} value={m.name} />
            ))}
          </datalist>
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="ps-min">
            Only if the charge is more than (optional)
          </label>
          <input
            id="ps-min"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            className={INPUT_CLASS}
            placeholder="500"
            value={draft.minAmount}
            onChange={(e) => set({ minAmount: e.target.value })}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="ps-split">
            Split off this amount
          </label>
          <input
            id="ps-split"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            className={INPUT_CLASS}
            placeholder="500"
            value={draft.splitAmount}
            onChange={(e) => set({ splitAmount: e.target.value })}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="ps-label">
            Call it
          </label>
          <input
            id="ps-label"
            className={INPUT_CLASS}
            placeholder="Amazon gift card"
            value={draft.label}
            onChange={(e) => set({ label: e.target.value })}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="ps-cat">
            Category
          </label>
          <select
            id="ps-cat"
            className={INPUT_CLASS}
            value={draft.categoryId}
            onChange={(e) => set({ categoryId: e.target.value })}
          >
            <option value="">Keep the merchant&apos;s category</option>
            {options.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="ps-goal">
            Take the money from (optional)
          </label>
          <select
            id="ps-goal"
            className={INPUT_CLASS}
            value={draft.goalId}
            onChange={(e) => set({ goalId: e.target.value })}
          >
            <option value="">No goal — normal spending</option>
            {options.goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.emoji} {g.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onSubmit}
          disabled={!valid || pending}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)]"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}

function describe(row: PlannedSplitRow): string {
  const min = row.minAmount != null ? ` over ${formatCurrency(row.minAmount)}` : ''
  const cat = row.categoryName ? ` → ${row.categoryName}` : ''
  const goal = row.goalName ? `, paid from ${row.goalEmoji ?? ''} ${row.goalName}`.trimEnd() : ''
  return `Next ${row.merchantLabel} charge${min}: split off ${formatCurrency(row.splitAmount)} as “${row.label}”${cat}${goal}.`
}

/**
 * The "future custom import" rules (BUSINESS_RULES.md §22): tell the importer
 * ahead of time that the next charge at a place hides a separate purchase, so
 * the daily sync carves it out on arrival instead of leaving it miscategorized
 * for days. Rules can be edited or deleted; an applied one stays here (and on
 * the dashboard) as the confirmation that it worked.
 */
export function PlannedSplitsManager({
  rows,
  options,
}: {
  rows: PlannedSplitRow[]
  options: PlannedSplitOptions
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY)

  const run = (fn: () => Promise<void>, after?: () => void) =>
    startTransition(async () => {
      await fn()
      after?.()
      router.refresh()
    })

  return (
    <div className="flex flex-col gap-4">
      <Card title="Plan a split">
        <p className="mb-4 text-sm text-[var(--muted)]">
          Bought something that will post under the wrong name — a gift card at the supermarket,
          a friend&apos;s share on your card? Write it down here <em>before</em> the charge shows
          up and the next import will split it for you. Add one rule per thing — several rules
          can come out of the same bill, each with its own category and goal.
        </p>
        <Form
          draft={draft}
          setDraft={setDraft}
          options={options}
          submitLabel="Add rule"
          pending={pending}
          onSubmit={() => {
            const input = toInput(draft, options)
            if (input) run(() => createPlannedSplit(input), () => setDraft(EMPTY))
          }}
        />
      </Card>

      <Card title="Planned splits">
        {rows.length === 0 ? (
          <EmptyHint>No planned splits waiting.</EmptyHint>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2"
              >
                {editingId === row.id ? (
                  <Form
                    draft={editDraft}
                    setDraft={setEditDraft}
                    options={options}
                    submitLabel="Save"
                    pending={pending}
                    onCancel={() => setEditingId(null)}
                    onSubmit={() => {
                      const input = toInput(editDraft, options)
                      if (input)
                        run(() => updatePlannedSplit(row.id, input), () => setEditingId(null))
                    }}
                  />
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            row.status === 'applied'
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                              : 'bg-[var(--surface)] text-[var(--muted)]'
                          }`}
                        >
                          {row.status === 'applied' ? 'Done' : 'Waiting'}
                        </span>
                        <span className="truncate">{row.label}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-[var(--muted)]">
                        {describe(row)}{' '}
                        {row.status === 'applied' ? (
                          <>
                            Applied {row.appliedAt}
                            {row.appliedTransactionId && (
                              <>
                                {' — '}
                                <a href="/transactions" className="underline">
                                  see it on Activity
                                </a>
                              </>
                            )}
                            .
                          </>
                        ) : (
                          `Waiting ${row.waitingDays} day${row.waitingDays === 1 ? '' : 's'}.`
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {row.status === 'pending' && (
                        <button
                          onClick={() => {
                            // Same place + same floor = the same bill, so the two
                            // rules split one purchase between them.
                            setDraft({
                              ...EMPTY,
                              merchantLabel: row.merchantLabel,
                              minAmount: row.minAmount != null ? String(row.minAmount) : '',
                            })
                            document
                              .getElementById('ps-place')
                              ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                          }}
                          className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)] hover:bg-[var(--surface)]"
                          title="Add another split to this same purchase"
                        >
                          + Same bill
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setEditingId(row.id)
                          setEditDraft(draftFrom(row))
                        }}
                        className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)] hover:bg-[var(--surface)]"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => run(() => deletePlannedSplit(row.id))}
                        disabled={pending}
                        className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)] hover:bg-[var(--surface)] disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
