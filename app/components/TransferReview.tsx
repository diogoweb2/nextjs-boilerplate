'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCurrency, formatLongDate } from '@/app/lib/format'
import { resolveTransferReview, type PendingReview, type ReviewAllocation } from '@/app/actions/goals'

type Treatment = 'expense' | 'neutral' | 'mortgage' | 'dismiss'

const TREATMENTS: { value: Treatment; label: string; hint: string }[] = [
  { value: 'expense', label: 'Count as expense', hint: 'Investment spend (default)' },
  { value: 'neutral', label: "Don't count", hint: 'just a better-interest move' },
  { value: 'mortgage', label: 'Extra mortgage', hint: 'pay down the house' },
  { value: 'dismiss', label: 'Leave as-is', hint: 'decide later' },
]

const SELECT_CLASS =
  'rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]'

/**
 * Big, friendly dashboard prompt for every investment transfer awaiting a
 * decision. Stays at the top of the dashboard until the owner says what each
 * transfer was for (allocate to goals, neutral move, extra mortgage, or skip).
 */
export function TransferReview({ reviews }: { reviews: PendingReview[] }) {
  if (reviews.length === 0) return null
  return (
    <section className="card animate-in border-l-4 border-l-[var(--warning)] p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-lg">💸</span>
        <h2 className="text-sm font-semibold">
          {reviews.length === 1 ? 'A transfer needs a quick decision' : `${reviews.length} transfers need a quick decision`}
        </h2>
      </div>
      <div className="flex flex-col gap-4">
        {reviews.map((r) => (
          <ReviewRow key={r.id} review={r} />
        ))}
      </div>
    </section>
  )
}

function ReviewRow({ review }: { review: PendingReview }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [treatment, setTreatment] = useState<Treatment>('expense')
  const [allocations, setAllocations] = useState<ReviewAllocation[]>(() =>
    review.goals.length
      ? [{ goalId: review.suggestedGoalId ?? review.goals[0].id, amount: review.amount }]
      : [],
  )

  const allocatable = treatment === 'expense' || treatment === 'neutral'
  const allocated = useMemo(() => allocations.reduce((s, a) => s + (a.amount || 0), 0), [allocations])
  const remainder = Math.round((review.amount - allocated) * 100) / 100

  const setAlloc = (i: number, patch: Partial<ReviewAllocation>) =>
    setAllocations((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)))
  const addAlloc = () =>
    setAllocations((prev) => [...prev, { goalId: review.goals[0]?.id ?? 0, amount: Math.max(0, remainder) }])
  const removeAlloc = (i: number) => setAllocations((prev) => prev.filter((_, idx) => idx !== i))

  const confirm = () =>
    startTransition(async () => {
      await resolveTransferReview({
        reviewId: review.id,
        treatment,
        allocations: allocatable ? allocations.filter((a) => a.amount > 0) : [],
      })
      router.refresh()
    })

  return (
    <div className={`rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 ${pending ? 'opacity-60' : ''}`}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{review.merchant}</span>
        <span className="tabular-nums text-lg font-bold">{formatCurrency(review.amount)}</span>
      </div>
      <p className="mb-3 text-xs text-[var(--muted)]">{formatLongDate(review.date)} · what was this for?</p>

      {/* Treatment */}
      <div className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {TREATMENTS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTreatment(t.value)}
            className={`flex flex-col items-start rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
              treatment === t.value
                ? 'border-[var(--accent)] bg-[var(--surface)] text-[var(--foreground)]'
                : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]'
            }`}
          >
            <span className="font-medium">{t.label}</span>
            <span className="text-[10px] opacity-80">{t.hint}</span>
          </button>
        ))}
      </div>

      {/* Goal allocations (split one transfer across goals) */}
      {allocatable &&
        (review.goals.length === 0 ? (
          <p className="mb-3 rounded-lg bg-[var(--surface)] px-2.5 py-2 text-xs text-[var(--muted)]">
            No savings goals yet — create one on the Goals tab to attribute this, or just confirm to record it.
          </p>
        ) : (
          <div className="mb-3 flex flex-col gap-2">
            {allocations.map((a, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  value={a.goalId}
                  onChange={(e) => setAlloc(i, { goalId: Number(e.target.value) })}
                  className={`${SELECT_CLASS} min-w-0 flex-1`}
                >
                  {review.goals.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.emoji} {g.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={a.amount}
                  onChange={(e) => setAlloc(i, { amount: Number(e.target.value) })}
                  className="w-28 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-right text-sm tabular-nums"
                />
                {allocations.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeAlloc(i)}
                    className="px-1 text-[var(--muted)] hover:text-[var(--negative)]"
                    aria-label="Remove allocation"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between text-xs text-[var(--muted)]">
              <button type="button" onClick={addAlloc} className="font-medium text-[var(--accent)]">
                + split across another goal
              </button>
              <span className={remainder < -0.005 ? 'text-[var(--negative)]' : ''}>
                {remainder > 0.005
                  ? `${formatCurrency(remainder)} left unallocated`
                  : remainder < -0.005
                    ? `${formatCurrency(-remainder)} over`
                    : 'fully allocated'}
              </span>
            </div>
          </div>
        ))}

      <div className="flex justify-end">
        <button
          type="button"
          disabled={pending || (allocatable && remainder < -0.005)}
          onClick={confirm}
          className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-sm font-medium text-[var(--accent-fg)] disabled:opacity-40"
        >
          Confirm
        </button>
      </div>
    </div>
  )
}
