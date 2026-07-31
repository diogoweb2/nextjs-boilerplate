'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCurrency, formatMonth } from '@/app/lib/format'
import { confirmAllocation, dismissAllocation, type SurplusPrompt } from '@/app/actions/surplus'

const EPS = 0.01

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Dashboard "give every dollar a job" prompt. After a month closes net-positive,
 * the owner splits that surplus across savings goals in DOLLARS; Net-Zero is the
 * implicit remainder (whatever's left keeps reducing the year's deficit). Goals
 * with an auto-contribute rule pre-fill their fixed amount (in priority order).
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
  // Work in DOLLARS; the preselect arrives as percents of the month's net.
  const [amounts, setAmounts] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    for (const g of prompt.goals) {
      const pct = prompt.preselect[String(g.id)] ?? 0
      init[String(g.id)] = round2((prompt.net * pct) / 100)
    }
    return init
  })

  const total = useMemo(
    () => round2(Object.values(amounts).reduce((s, a) => s + (a > 0 ? a : 0), 0)),
    [amounts],
  )
  const remainder = round2(prompt.net - total)

  const setAmt = (goalId: number, raw: number) => {
    const others = total - (amounts[String(goalId)] ?? 0)
    const max = Math.max(0, round2(prompt.net - others)) // respect the surplus ceiling
    const safe = Number.isFinite(raw) ? round2(raw) : 0
    const v = Math.min(max, Math.max(0, safe))
    setAmounts((prev) => ({ ...prev, [String(goalId)]: v }))
  }

  // With Net-Zero the remainder is a valid bucket; without it every dollar must
  // get a job (Σ must reach the full surplus).
  const canConfirm = prompt.hasNetZero ? true : Math.abs(remainder) < EPS

  const confirm = () =>
    startTransition(async () => {
      // Convert dollars → fractional percents of net (round-trips to exact dollars).
      const percents: Record<string, number> = {}
      for (const [id, amt] of Object.entries(amounts)) {
        if (amt > 0 && prompt.net > 0) percents[id] = (amt / prompt.net) * 100
      }
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
        Split last month&apos;s surplus across your goals (in dollars). This preselects next month too.
      </p>

      <DecisionStrip prompt={prompt} allocated={total} remainder={remainder} />

      <div className="flex flex-col gap-2.5">
        {prompt.goals.map((g) => {
          const amt = amounts[String(g.id)] ?? 0
          const auto = g.autoContribute ?? 0
          // Partial fund: the rule wanted more than the surplus could cover.
          const partial = auto > 0 && amt < auto - EPS
          return (
            <div
              key={g.id}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3"
            >
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">
                  <span className="mr-1.5">{g.emoji}</span>
                  {g.name}
                  {auto > 0 && (
                    <span
                      className="ml-2 rounded-full bg-[var(--accent)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]"
                      title="Auto-contribute rule"
                    >
                      ⭐ Auto {formatCurrency(auto)}/mo
                    </span>
                  )}
                </span>
                <span className="tabular-nums text-sm text-[var(--muted)]">{formatCurrency(amt)}</span>
              </div>
              <GoalProgress saved={g.saved} target={g.target} adding={amt} />
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, Math.round(prompt.net))}
                  step={1}
                  value={amt}
                  onChange={(e) => setAmt(g.id, Number(e.target.value))}
                  className="min-w-0 flex-1 accent-[var(--accent)]"
                  aria-label={`${g.name} amount`}
                />
                <div className="flex items-center gap-1">
                  <span className="text-sm text-[var(--muted)]">$</span>
                  <input
                    type="number"
                    min={0}
                    max={prompt.net}
                    step={1}
                    value={amt}
                    onChange={(e) => setAmt(g.id, Number(e.target.value))}
                    className="w-20 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-right text-sm tabular-nums text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    aria-label={`${g.name} amount input`}
                  />
                </div>
              </div>
              {partial && (
                <p className="mt-1 text-[11px] text-[var(--warning)]">
                  Surplus only covers {formatCurrency(amt)} of the {formatCurrency(auto)} auto rule.
                </p>
              )}
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
              <span className="tabular-nums text-sm font-bold">{formatCurrency(Math.max(0, remainder))}</span>
            </div>
            {prompt.minNetZero !== null && prompt.minNetZero > 0 && (
              <div className="mt-1.5 flex items-center justify-between text-[11px]">
                <span className="text-[var(--muted)]">
                  Dec 31 path: {formatCurrency(prompt.minNetZero)}/mo
                </span>
                {remainder >= prompt.minNetZero - EPS ? (
                  <span className="text-[var(--positive)]">on track ✓</span>
                ) : (
                  <span className="text-[var(--warning)]">
                    {formatCurrency(Math.ceil(prompt.minNetZero - remainder))} below target
                  </span>
                )}
              </div>
            )}
          </div>
        ) : (
          <p
            className={`px-1 text-xs ${Math.abs(remainder) < EPS ? 'text-[var(--muted)]' : 'text-[var(--warning)]'}`}
          >
            {Math.abs(remainder) < EPS
              ? 'Every dollar has a job ✓'
              : `Unassigned: ${formatCurrency(remainder)} — assign it all to continue.`}
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

/**
 * The numbers needed to decide *how much* to move, above the sliders that decide
 * *where*. Four facts, live as the sliders change:
 *
 *  - **Surplus** — the month's net, the ceiling on what can be allocated.
 *  - **On 2 paycheques** — the same month minus the extra cheque, i.e. what a
 *    normal month nets. A 3-cheque month's surplus is the buffer for the lean
 *    months around it, not repeatable capacity (§10b). Hidden in normal months.
 *  - **Keep for Net-Zero** — the required-path slice, matching the remainder
 *    row's "Dec 31 path" figure.
 *  - **Free to move** — surplus − that minimum: the honest budget for goals.
 *    Turns amber once the sliders eat into the Net-Zero minimum.
 */
function DecisionStrip({
  prompt,
  allocated,
  remainder,
}: {
  prompt: SurplusPrompt
  allocated: number
  remainder: number
}) {
  const min = prompt.minNetZero ?? 0
  const freeToMove = round2(Math.max(0, prompt.net - min))
  const overspending = min > 0 && remainder < min - EPS

  return (
    <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 sm:grid-cols-4">
      <Fact label="Surplus" value={formatCurrency(prompt.net)} />
      {prompt.typicalNet !== null && (
        <Fact
          label="On 2 paycheques"
          value={formatCurrency(prompt.typicalNet)}
          hint={`3-cheque month · extra ${formatCurrency(prompt.extraCheque)}`}
        />
      )}
      {min > 0 && <Fact label="Keep for Net-Zero" value={formatCurrency(min)} hint="stays on the Dec 31 path" />}
      <Fact
        label="Free to move"
        value={formatCurrency(freeToMove)}
        tone={overspending ? 'var(--warning)' : 'var(--positive)'}
        hint={
          overspending
            ? `${formatCurrency(round2(allocated - freeToMove))} over`
            : `${formatCurrency(round2(Math.max(0, freeToMove - allocated)))} left`
        }
      />
    </div>
  )
}

function Fact({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="text-base font-bold tabular-nums" style={{ color: tone ?? 'var(--foreground)' }}>
        {value}
      </div>
      {hint && <div className="truncate text-[10px] text-[var(--muted)]">{hint}</div>}
    </div>
  )
}

/**
 * What this slice does to the goal: current balance, the target, and where the
 * allocation lands it. Without this the sliders are abstract — you're choosing
 * between names, not between "nearly there" and "barely started".
 */
function GoalProgress({ saved, target, adding }: { saved: number; target: number | null; adding: number }) {
  if (target === null || target <= 0) {
    return (
      <div className="mb-1.5 text-[11px] text-[var(--muted)]">
        {formatCurrency(saved)} saved
        {adding > 0 && <span className="text-[var(--positive)]"> → {formatCurrency(saved + adding)}</span>}
      </div>
    )
  }
  const pct = Math.min(100, (saved / target) * 100)
  const after = Math.min(100, ((saved + adding) / target) * 100)
  const done = saved + adding >= target - EPS
  return (
    <div className="mb-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-[var(--muted)]">
        <span>
          {formatCurrency(saved)} of {formatCurrency(target)}
          {adding > 0 && (
            <span className="text-[var(--positive)]"> → {formatCurrency(saved + adding)}</span>
          )}
        </span>
        <span className="tabular-nums">
          {done ? 'complete ✓' : `${Math.round(after)}%`}
        </span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--border)]">
        {/* current balance, then the slice this allocation would add */}
        <div className="flex h-full">
          <div style={{ width: `${pct}%`, background: 'var(--muted)' }} />
          <div style={{ width: `${Math.max(0, after - pct)}%`, background: 'var(--positive)' }} />
        </div>
      </div>
    </div>
  )
}
