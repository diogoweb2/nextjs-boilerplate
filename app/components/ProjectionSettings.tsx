'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card, EmptyHint } from '@/app/components/AppShell'
import { formatCurrency } from '@/app/lib/format'
import type { Cadence, AmountMode, ProjectionRule, SuggestedRule, Unavoidable } from '@/app/lib/projection'
import {
  addProjectionRule,
  updateProjectionRule,
  removeProjectionRule,
  dismissSuggestion,
} from '@/app/actions/projection'

type ActiveRule = ProjectionRule & { currentAmount: number; actual: boolean }

const CADENCES: Cadence[] = ['monthly', 'quarterly', 'annual', 'periodic']
const AMOUNT_MODES: { value: AmountMode; label: string }[] = [
  { value: 'average', label: 'Average of recent' },
  { value: 'seasonal', label: 'Seasonal (by month)' },
  { value: 'last', label: 'Last amount' },
  { value: 'fixed', label: 'Fixed amount' },
]

const SELECT_CLASS =
  'rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]'

export function ProjectionSettings({
  active,
  suggestions,
  unavoidable,
  addableMerchants,
  onMutated,
}: {
  active: ActiveRule[]
  suggestions: SuggestedRule[]
  unavoidable: Unavoidable
  addableMerchants: { id: number; name: string }[]
  /** Called after each edit (in addition to refreshing the page) so an embedding
   *  modal can re-fetch its own copy of the panel. */
  onMutated?: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [pick, setPick] = useState('')

  const run = (fn: () => Promise<void>) =>
    startTransition(async () => {
      await fn()
      router.refresh()
      onMutated?.()
    })

  return (
    <div className={`flex flex-col gap-5 ${pending ? 'opacity-70' : ''}`}>
      {/* This month's unavoidable total (what the budget subtracts) */}
      <Card
        title="Unavoidable this month"
        action={<span className="text-sm font-bold tabular-nums">{formatCurrency(unavoidable.total)}</span>}
      >
        {unavoidable.lines.length ? (
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {unavoidable.lines.map((l) => (
              <li key={`${l.kind}-${l.label}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <span className="font-medium">{l.label}</span>
                  <span className="rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                    {l.kind}
                  </span>
                  {l.actual && <span className="text-[10px] text-[var(--positive)]">actual</span>}
                </span>
                <span className="tabular-nums font-medium">{formatCurrency(l.amount)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyHint>Nothing projected for this month.</EmptyHint>
        )}
      </Card>

      {/* Active projected bills */}
      <Card title="Projected bills" action={<span className="text-xs text-[var(--muted)]">recurring costs you don&apos;t control</span>}>
        {active.length ? (
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {active.map((r) => (
              <li key={r.merchantId} className="flex flex-col gap-2 py-3">
                <div className="flex items-center justify-between gap-3">
                  <input
                    defaultValue={r.label}
                    onBlur={(e) =>
                      e.target.value !== r.label &&
                      run(() => updateProjectionRule({ merchantId: r.merchantId, label: e.target.value }))
                    }
                    className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium hover:border-[var(--border)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  <span className="shrink-0 tabular-nums text-sm font-semibold">
                    {formatCurrency(r.currentAmount)}
                    {r.actual && <span className="ml-1 text-[10px] font-normal text-[var(--positive)]">actual</span>}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={r.cadence}
                    onChange={(e) => run(() => updateProjectionRule({ merchantId: r.merchantId, cadence: e.target.value as Cadence }))}
                    className={SELECT_CLASS}
                  >
                    {CADENCES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <select
                    value={r.amountMode}
                    onChange={(e) => run(() => updateProjectionRule({ merchantId: r.merchantId, amountMode: e.target.value as AmountMode }))}
                    className={SELECT_CLASS}
                  >
                    {AMOUNT_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  {r.amountMode === 'fixed' && (
                    <input
                      type="number"
                      min={0}
                      defaultValue={r.fixedAmount ?? 0}
                      onBlur={(e) =>
                        run(() => updateProjectionRule({ merchantId: r.merchantId, fixedAmount: Number(e.target.value) }))
                      }
                      className="w-24 rounded-lg border border-[var(--border)] bg-transparent px-2 py-1 text-right text-xs tabular-nums"
                    />
                  )}
                  <button
                    onClick={() => run(() => removeProjectionRule(r.merchantId))}
                    className="ml-auto rounded-lg border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--negative)]"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyHint>No projected bills yet. Add one from the suggestions below.</EmptyHint>
        )}

        {/* Manual add — for annual/rare bills the auto-detector can't infer (Belair). */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
          <span className="text-xs text-[var(--muted)]">Add manually:</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)} className={`${SELECT_CLASS} max-w-[16rem]`}>
            <option value="">Choose a merchant…</option>
            {addableMerchants.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <button
            disabled={!pick}
            onClick={() => {
              const id = Number(pick)
              setPick('')
              run(() => addProjectionRule({ merchantId: id }))
            }}
            className="rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-fg)] disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </Card>

      {/* Auto-detected suggestions */}
      <Card title="Suggested" action={<span className="text-xs text-[var(--muted)]">auto-detected recurring bills</span>}>
        {suggestions.length ? (
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {suggestions.map((s) => (
              <li key={s.merchantId} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <span className="block truncate text-sm font-medium">{s.label}</span>
                  <span className="text-xs text-[var(--muted)]">
                    {s.category} · {s.cadence} · {s.occurrences}× · ~{formatCurrency(s.estimatedAmount)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() =>
                      run(() =>
                        addProjectionRule({
                          merchantId: s.merchantId,
                          label: s.label,
                          cadence: s.cadence,
                          amountMode: s.amountMode,
                        })
                      )
                    }
                    className="rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-fg)]"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => run(() => dismissSuggestion(s.merchantId))}
                    className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyHint>No new suggestions — everything recurring is already tracked or dismissed.</EmptyHint>
        )}
      </Card>
    </div>
  )
}
