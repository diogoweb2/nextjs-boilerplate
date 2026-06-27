'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCurrency, formatMonth } from '@/app/lib/format'
import { confirmAllocation, dismissAllocation, type SurplusPrompt } from '@/app/actions/surplus'

const EPS = 0.01

/**
 * Dashboard "give every dollar a job" prompt. After a month closes net-positive,
 * the owner splits that surplus across savings goals by percentage; Net-Zero is
 * the implicit remainder (whatever's left keeps reducing the year's deficit).
 * Stays at the top of the dashboard until each completed month is actioned.
 */
export function SurplusAllocation({ prompts }: { prompts: SurplusPrompt[] }) {
  if (prompts.length === 0) return null
  return (
    <div className="flex flex-col gap-4">
      {prompts.map((p) => (
        <PromptCard key={p.month} prompt={p} />
      ))}
    </div>
  )
}

function PromptCard({ prompt }: { prompt: SurplusPrompt }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [percents, setPercents] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    for (const g of prompt.goals) init[String(g.id)] = prompt.preselect[String(g.id)] ?? 0
    return init
  })

  const total = useMemo(
    () => Object.values(percents).reduce((s, p) => s + (p > 0 ? p : 0), 0),
    [percents],
  )
  const remainder = Math.round((100 - total) * 100) / 100

  const setPct = (goalId: number, raw: number) => {
    const others = total - (percents[String(goalId)] ?? 0)
    const max = Math.max(0, 100 - others) // respect the 100% ceiling
    const safe = Number.isFinite(raw) ? Math.round(raw) : 0
    const v = Math.min(max, Math.max(0, safe))
    setPercents((prev) => ({ ...prev, [String(goalId)]: v }))
  }

  // With Net-Zero the remainder is a valid bucket; without it every dollar must
  // get a job (Σ must reach 100).
  const canConfirm = prompt.hasNetZero ? true : Math.abs(remainder) < EPS
  const dollars = (pct: number) => formatCurrency(Math.round((prompt.net * pct) / 100 * 100) / 100)

  const confirm = () =>
    startTransition(async () => {
      await confirmAllocation({ month: prompt.month, percents })
      router.refresh()
    })
  const dismiss = () =>
    startTransition(async () => {
      await dismissAllocation({ month: prompt.month })
      router.refresh()
    })

  return (
    <section
      className={`card animate-in border-l-4 border-l-[var(--warning)] p-4 sm:p-5 ${pending ? 'opacity-60' : ''}`}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-lg">🪙</span>
        <h2 className="text-sm font-semibold">
          {formatMonth(prompt.month)} finished {formatCurrency(prompt.net)} ahead — give it a job
        </h2>
      </div>
      <p className="mb-3 text-xs text-[var(--muted)]">
        Split last month&apos;s surplus across your goals. This preselects next month too.
      </p>

      <div className="flex flex-col gap-2.5">
        {prompt.goals.map((g) => {
          const pct = percents[String(g.id)] ?? 0
          return (
            <div
              key={g.id}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3"
            >
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">
                  <span className="mr-1.5">{g.emoji}</span>
                  {g.name}
                </span>
                <span className="tabular-nums text-sm text-[var(--muted)]">{dollars(pct)}</span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={pct}
                  onChange={(e) => setPct(g.id, Number(e.target.value))}
                  className="min-w-0 flex-1 accent-[var(--accent)]"
                  aria-label={`${g.name} percent`}
                />
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={pct}
                    onChange={(e) => setPct(g.id, Number(e.target.value))}
                    className="w-16 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-right text-sm tabular-nums text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    aria-label={`${g.name} percent input`}
                  />
                  <span className="text-sm text-[var(--muted)]">%</span>
                </div>
              </div>
            </div>
          )
        })}

        {/* Net-Zero remainder bucket (or the unassigned warning when none). */}
        {prompt.hasNetZero ? (
          <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">
                <span className="mr-1.5">⚖️</span>
                {prompt.netZeroLabel ?? 'Net-Zero'}
                <span className="ml-1.5 text-xs text-[var(--muted)]">(whatever&apos;s left)</span>
              </span>
              <span className="tabular-nums text-sm">
                <span className="font-bold">{Math.max(0, remainder)}%</span>
                <span className="ml-2 text-[var(--muted)]">{dollars(Math.max(0, remainder))}</span>
              </span>
            </div>
          </div>
        ) : (
          <p
            className={`px-1 text-xs ${Math.abs(remainder) < EPS ? 'text-[var(--muted)]' : 'text-[var(--warning)]'}`}
          >
            {Math.abs(remainder) < EPS
              ? 'Every dollar has a job ✓'
              : `Unassigned: ${remainder}% (${dollars(remainder)}) — assign it all to continue.`}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={confirm}
          disabled={pending || !canConfirm}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={dismiss}
          disabled={pending}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
        >
          {prompt.hasNetZero ? 'Send it all to Net-Zero' : 'Use last month’s split'}
        </button>
      </div>
    </section>
  )
}
