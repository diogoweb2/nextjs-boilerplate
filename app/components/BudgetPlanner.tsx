'use client'

import { useState, useTransition, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card } from '@/app/components/AppShell'
import { StatCard } from '@/app/components/charts/StatCard'
import { LineChart } from '@/app/components/charts/LineChart'
import { formatCurrency, formatCurrencyCompact, formatMonth } from '@/app/lib/format'
import type { BudgetData, PeriodMode } from '@/app/lib/budget'
import { saveGoal, saveSettings, resetGoals, saveAllGoals, commitMonthlyBudget } from '@/app/actions/budget'

const SPEND_COLOR = '#ef4444'
const BUDGET_COLOR = '#6366f1'
function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0)
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ─── Auto-balance ─────────────────────────────────────────────────────────────

type AutoBalanceResult =
  | { status: 'disabled' }
  | { status: 'impossible'; reason: string }
  | { status: 'feasible'; newGoals: Record<number, number> }

/**
 * Rebalance category goals so every over-budget (red) line turns green, while
 * keeping the sum of goals within the monthly cap B (which is exactly the
 * year-end-net-goal constraint, since projected ≥ target ⟺ ΣG ≤ B).
 *
 * Strategy: red categories can't un-spend, so their goal rises to what's already
 * spent. The extra is funded by trimming the *cushion* (goal − actual) of the
 * flexible green categories, proportionally; fixed categories (Home) are left at
 * their committed goal. If even zero-cushion flexible spending can't fit under B,
 * it's impossible and we say why.
 */
function computeAutoBalance(
  categories: BudgetData['categories'],
  goals: Record<number, number>,
  B: number
): AutoBalanceResult {
  const goalOf = (c: BudgetData['categories'][number]) => goals[c.categoryId] ?? 0
  const isOver = (c: BudgetData['categories'][number]) => c.currentMonthActual > goalOf(c) + 0.5

  const reds = categories.filter(isOver)
  if (reds.length === 0) return { status: 'disabled' }

  const newGoals = { ...goals }
  // Reds: already spent — set the goal to the actual so the line goes green.
  for (const c of reds) newGoals[c.categoryId] = round2(c.currentMonthActual)

  const fixedKept = categories.filter((c) => c.fixed && !isOver(c))
  const flexGreen = categories.filter((c) => !c.fixed && !isOver(c))

  // Committed = fixed goals (untouched) + reds raised to their actual spend.
  const committed = sum(fixedKept.map(goalOf)) + sum(reds.map((c) => newGoals[c.categoryId]))
  const flexActualTotal = sum(flexGreen.map((c) => c.currentMonthActual))

  // Minimum achievable total = commitments + every flexible line at its own
  // actual spend (zero cushion). If that already exceeds B, we can't rebalance.
  const minTotal = committed + flexActualTotal
  if (minTotal > B + 0.5) {
    return {
      status: 'impossible',
      reason: `Even trimming every flexible category to what you've already spent, your commitments come to ${formatCurrency(
        minTotal
      )} — ${formatCurrency(minTotal - B)} over your ${formatCurrency(
        B
      )} monthly cap. To rebalance you'd need to cut spending this month or raise your Year-end net goal.`,
    }
  }

  const flexCurrentTotal = sum(flexGreen.map(goalOf))
  const slackForFlex = B - committed
  if (flexCurrentTotal > slackForFlex) {
    // Shrink each flexible cushion proportionally so the total lands on B,
    // never below that category's own actual spend (so it stays green).
    const cushionNeeded = flexCurrentTotal - flexActualTotal
    const cushionAvailable = Math.max(0, slackForFlex - flexActualTotal)
    const factor = cushionNeeded > 0 ? Math.min(1, cushionAvailable / cushionNeeded) : 0
    for (const c of flexGreen) {
      const cushion = Math.max(0, goalOf(c) - c.currentMonthActual)
      newGoals[c.categoryId] = round2(c.currentMonthActual + cushion * factor)
    }
  }

  return { status: 'feasible', newGoals }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BudgetPlanner({ data, autoPropose = true }: { data: BudgetData; autoPropose?: boolean }) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  const [targetNet, setTargetNet] = useState(data.targetNet)
  const [goals, setGoals] = useState<Record<number, number>>(() =>
    Object.fromEntries(data.categories.map((c) => [c.categoryId, c.goal]))
  )

  // Sync from server on navigation/refresh (adjust-state-during-render pattern).
  const [prevData, setPrevData] = useState(data)
  if (prevData !== data) {
    setPrevData(data)
    setTargetNet(data.targetNet)
    setGoals(Object.fromEntries(data.categories.map((c) => [c.categoryId, c.goal])))
  }

  const mode = data.periodMode
  const avgOf = (c: BudgetData['categories'][number]) => (mode === 'year' ? c.avgYear : c.avg12)

  // Live derived figures (pure arithmetic from local state).
  const goalList = data.categories.map((c) => goals[c.categoryId] ?? 0)
  const G = sum(goalList)
  const F = data.unavoidable.total
  // Recompute B live so it reacts to the targetNet slider.
  const B = data.income + (data.completedBaseline - targetNet) / data.monthsRemaining
  const X = B - F
  const projectedNet = data.completedBaseline + data.monthsRemaining * (data.income - G)
  const onTrack = projectedNet >= targetNet - 0.5
  const totalActual = sum(data.categories.map((c) => c.currentMonthActual))

  // ── Year-end status for live card feedback ──
  const WARNING_THRESHOLD = Math.max(500, Math.abs(targetNet) * 0.1)
  const netStatus: 'good' | 'warning' | 'danger' =
    projectedNet < targetNet ? 'danger' : projectedNet < targetNet + WARNING_THRESHOLD ? 'warning' : 'good'

  const [cardHighlight, setCardHighlight] = useState<'none' | 'warning' | 'danger'>('none')
  const prevStatusRef = useRef(netStatus)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (prevStatusRef.current === netStatus) return
    prevStatusRef.current = netStatus
    if (netStatus !== 'good') {
      setCardHighlight(netStatus)
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = setTimeout(() => setCardHighlight('none'), 1500)
    } else {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      setCardHighlight('none')
    }
  }, [netStatus])

  // ── Auto-balance ──
  const [autoBalanceWarning, setAutoBalanceWarning] = useState<string | null>(null)
  const autoBalResult = computeAutoBalance(data.categories, goals, B)
  const allGreen = autoBalResult.status === 'disabled'
  // Drop a stale "impossible" warning once edits make rebalancing viable again.
  if (autoBalanceWarning && autoBalResult.status !== 'impossible') setAutoBalanceWarning(null)

  const handleAutoBalance = () => {
    const result = computeAutoBalance(data.categories, goals, B)
    if (result.status === 'impossible') {
      setAutoBalanceWarning(result.reason)
      return
    }
    if (result.status === 'feasible') {
      setAutoBalanceWarning(null)
      setGoals(result.newGoals)
      startTransition(async () => {
        await saveAllGoals(result.newGoals)
        router.refresh()
      })
    }
  }

  // ── Seasonal proposal ──
  const [proposalOpen, setProposalOpen] = useState(false)
  const proposal = data.seasonalProposal
  const hasProposal = proposal.lines.length > 0
  const proposedMap = () => Object.fromEntries(proposal.lines.map((l) => [l.categoryId, l.proposed]))

  const applyProposal = () => {
    const newGoals: Record<number, number> = { ...goals, ...proposedMap() }
    setGoals(newGoals)
    setProposalOpen(false)
    startTransition(async () => {
      await saveAllGoals(newGoals)
      router.refresh()
    })
  }

  // ── Auto-adopt the proposal when the month advances ──────────────────────────
  // First-ever run (budgetedMonth null): just record the marker so existing goals
  // are preserved. When the anchor month moves past the marker: adopt the seasonal
  // proposal as the new starting budget (the owner can then adjust). Runs once.
  const [autoProposed, setAutoProposed] = useState(false)
  const didAutoRef = useRef(false)
  useEffect(() => {
    if (!autoPropose || didAutoRef.current) return
    const anchor = data.anchor
    if (!anchor || data.budgetedMonth === anchor) return
    didAutoRef.current = true
    const monthAdvanced = data.budgetedMonth != null && data.budgetedMonth < anchor
    const goalsToApply = monthAdvanced ? proposedMap() : undefined
    if (goalsToApply) setAutoProposed(true)
    startTransition(async () => {
      await commitMonthlyBudget(anchor, goalsToApply)
      router.refresh()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.anchor, data.budgetedMonth, autoPropose])

  // ── Persistence helpers ──
  const persistGoal = (categoryId: number, amount: number) =>
    startTransition(async () => {
      await saveGoal(categoryId, amount)
      router.refresh()
    })
  const persistTarget = (amount: number) =>
    startTransition(async () => {
      await saveSettings({ targetNet: amount })
      router.refresh()
    })
  const persistMode = (m: PeriodMode) =>
    startTransition(async () => {
      await saveSettings({ periodMode: m })
      router.refresh()
    })
  const doReset = () =>
    startTransition(async () => {
      await resetGoals()
      router.refresh()
    })

  return (
    <div className="flex flex-col gap-5">
      {/* Headline KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Spend this month"
          value={formatCurrency(Math.max(0, X))}
          hint="discretionary — excludes fixed bills"
        />
        <StatCard label="Monthly cap (all-in)" value={formatCurrency(B)} hint="fixed + discretionary" />
        <StatCard
          label="Projected year-end net"
          value={formatCurrency(projectedNet)}
          hint={onTrack ? 'on track for your target ✓' : 'behind your target ✗'}
        />
        <StatCard
          label="Year-to-date net"
          value={formatCurrency(data.ytdNet)}
          hint={`Jan–${formatMonth(data.anchor!).split(' ')[0]} ${data.year}`}
        />
      </div>

      {/* On-track banner */}
      <div
        className={`rounded-xl border px-4 py-3 text-sm font-medium ${
          onTrack
            ? 'border-[color-mix(in_srgb,var(--positive)_40%,transparent)] bg-[color-mix(in_srgb,var(--positive)_10%,transparent)] text-[var(--positive)]'
            : 'border-[color-mix(in_srgb,var(--negative)_40%,transparent)] bg-[color-mix(in_srgb,var(--negative)_10%,transparent)] text-[var(--negative)]'
        }`}
      >
        {onTrack
          ? `On track: holding these goals projects ${formatCurrency(projectedNet)} by Dec 31 — at or above your ${formatCurrency(targetNet)} target.`
          : `Behind: these goals project ${formatCurrency(projectedNet)} by Dec 31 — ${formatCurrency(
              targetNet - projectedNet
            )} short of your ${formatCurrency(targetNet)} target. Trim ${formatCurrency(
              (targetNet - projectedNet) / data.monthsRemaining
            )}/mo from your goals.`}
      </div>

      {/* Targets */}
      <Card title="Targets">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Year-end net goal</span>
              <span className="tabular-nums font-semibold">{formatCurrency(targetNet)}</span>
            </div>
            <input
              type="range"
              min={-5000}
              max={10000}
              step={250}
              value={targetNet}
              onChange={(e) => setTargetNet(Number(e.target.value))}
              onPointerUp={() => persistTarget(targetNet)}
              onKeyUp={() => persistTarget(targetNet)}
              className="w-full accent-[var(--accent)]"
            />
            <div className="flex justify-between text-[11px] text-[var(--muted)]">
              <span>-$5,000</span>
              <span>break even</span>
              <span>+$10,000</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-[var(--muted)]">Averages from</span>
              <div className="inline-flex overflow-hidden rounded-lg border border-[var(--border)]">
                {(['year', '12mo'] as PeriodMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => persistMode(m)}
                    className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                      mode === m
                        ? 'bg-[var(--surface-2)] text-[var(--foreground)]'
                        : 'text-[var(--muted)] hover:text-[var(--foreground)]'
                    }`}
                  >
                    {m === 'year' ? `This year (${data.year})` : 'Last 12 months'}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={doReset}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              Reset to suggested
            </button>
          </div>

          <p className="text-xs text-[var(--muted)]">
            Expected income {formatCurrencyCompact(data.income)}/mo · {data.monthsRemaining} months left ·
            sum of goals {formatCurrency(G)} vs cap {formatCurrency(B)}.
          </p>
        </div>
      </Card>

      {/* Auto-proposed banner (shown once when a new month adopts the proposal) */}
      {autoProposed && (
        <div className="flex items-start gap-3 rounded-xl border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-4 py-3 text-sm">
          <span className="mt-0.5 shrink-0">✨</span>
          <p className="flex-1">
            New month: I auto-proposed a budget for{' '}
            <span className="font-semibold">{data.anchor ? formatMonth(data.anchor) : 'this month'}</span> from your
            seasonal patterns, kept within your year-end net goal. Review the reasoning below and adjust any category.
          </p>
          <button onClick={() => setAutoProposed(false)} className="shrink-0 text-[var(--muted)] hover:text-[var(--foreground)]">
            ✕
          </button>
        </div>
      )}

      {/* Seasonal budget proposal — the full proposed plan + reasoning */}
      {hasProposal && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <button
            className="flex w-full items-center justify-between px-4 py-3 text-left"
            onClick={() => setProposalOpen((v) => !v)}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">
                Proposed budget for {proposal.month ? formatMonth(proposal.month) : 'this month'}
              </span>
              {proposal.summaryPoints.length > 0 && (
                <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
                  seasonal
                </span>
              )}
            </div>
            <span className="text-xs text-[var(--muted)]">{proposalOpen ? 'hide ↑' : 'show ↓'}</span>
          </button>

          {proposalOpen && (
            <div className="border-t border-[var(--border)] px-4 pb-4 pt-3">
              {/* Reasoning box */}
              {proposal.summaryPoints.length > 0 ? (
                <>
                  <p className="mb-2 text-xs font-medium text-[var(--foreground)]">
                    Why this month differs from a flat average:
                  </p>
                  <ul className="mb-4 flex flex-col gap-1.5">
                    {proposal.summaryPoints.map((pt) => (
                      <li key={pt} className="flex items-start gap-2 text-xs text-[var(--foreground)]">
                        <span className="mt-0.5 text-[var(--muted)]">·</span>
                        <span>{pt}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="mb-4 text-xs text-[var(--muted)]">
                  No strong seasonal pattern detected for this month — this is your balanced suggestion, fitted to your
                  year-end net goal. Seasonal categories (summer camping, kids&apos; camp, fuel, grocery price trends)
                  adjust automatically once there are ≥2 years of history for the month.
                </p>
              )}

              {/* Full proposed budget — every category, biggest changes first */}
              <div className="mb-4 overflow-hidden rounded-lg border border-[var(--border)]">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]">
                      <th className="px-3 py-2 text-left font-medium text-[var(--muted)]">Category</th>
                      <th className="px-3 py-2 text-right font-medium text-[var(--muted)]">Regular</th>
                      <th className="px-3 py-2 text-right font-medium text-[var(--muted)]">Proposed</th>
                      <th className="px-3 py-2 text-right font-medium text-[var(--muted)]">Δ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {[...proposal.lines]
                      .sort((a, b) => Math.abs(b.proposed - b.regular) - Math.abs(a.proposed - a.regular))
                      .map((l) => {
                        const delta = round2(l.proposed - l.regular)
                        const changed = Math.abs(delta) > 0.5
                        return (
                          <tr key={l.categoryId} className={changed ? '' : 'text-[var(--muted)]'}>
                            <td className="px-3 py-2 font-medium">
                              {l.name}
                              {l.reason && <span className="ml-1 text-[10px] text-[var(--accent)]">●</span>}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-[var(--muted)]">
                              {formatCurrency(l.regular)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums font-medium">
                              {formatCurrency(l.proposed)}
                            </td>
                            <td
                              className={`px-3 py-2 text-right tabular-nums font-medium ${
                                !changed
                                  ? 'text-[var(--muted)]'
                                  : delta > 0
                                    ? 'text-[var(--negative)]'
                                    : 'text-[var(--positive)]'
                              }`}
                            >
                              {changed ? `${delta > 0 ? '+' : ''}${formatCurrency(delta)}` : '—'}
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
              <p className="mb-4 text-[11px] text-[var(--muted)]">
                <span className="text-[var(--accent)]">●</span> = adjusted from a seasonal pattern. Unmarked categories
                use your balanced suggestion. Everything is fitted to keep your year-end net goal.
              </p>

              <button
                onClick={applyProposal}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
              >
                Apply this proposal
              </button>
            </div>
          )}
        </div>
      )}

      {/* Category goals — with live year-end status feedback */}
      <div
        style={{
          borderRadius: '0.75rem',
          transition: 'box-shadow 0.25s',
          boxShadow:
            cardHighlight === 'danger'
              ? '0 0 0 2px var(--negative)'
              : cardHighlight === 'warning'
                ? '0 0 0 2px #ca8a04'
                : 'none',
        }}
      >
        <Card
          title="Category goals"
          action={
            <div className="flex items-center gap-2">
              {/* Live year-end indicator — appears while dragging sliders */}
              {netStatus !== 'good' && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    netStatus === 'danger'
                      ? 'bg-[color-mix(in_srgb,var(--negative)_15%,transparent)] text-[var(--negative)]'
                      : 'bg-[color-mix(in_srgb,#ca8a04_15%,transparent)] text-[#ca8a04]'
                  }`}
                >
                  {netStatus === 'danger' ? 'Year-end ✗' : 'Year-end close'}
                </span>
              )}
              <span className="text-xs text-[var(--muted)]">goal vs avg · this month so far</span>
              <button
                onClick={handleAutoBalance}
                disabled={allGreen}
                title={allGreen ? 'All categories are already on budget' : 'Raise over-budget goals to cover actual spend'}
                className={`rounded-lg border px-2 py-1 text-xs font-medium transition-colors ${
                  allGreen
                    ? 'cursor-not-allowed border-[var(--border)] text-[var(--muted)] opacity-50'
                    : 'border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--surface-2)]'
                }`}
              >
                Auto balance
              </button>
            </div>
          }
        >
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {data.categories.map((c) => {
              const goal = goals[c.categoryId] ?? 0
              const avg = avgOf(c)
              const sliderMax = Math.max(100, Math.ceil((Math.max(avg, goal, c.currentMonthActual) * 2) / 50) * 50)
              const step = sliderMax > 2000 ? 50 : 10
              const pct = goal > 0 ? c.currentMonthActual / goal : c.currentMonthActual > 0 ? 1.5 : 0
              const over = c.currentMonthActual > goal + 0.5
              return (
                <li key={c.categoryId} className="flex flex-col gap-2 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.color }} />
                      <Link
                        href={`/transactions?category=${encodeURIComponent(c.name)}`}
                        className="hover:underline"
                      >
                        {c.name}
                      </Link>
                      {c.fixed && (
                        <span className="rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                          Fixed
                        </span>
                      )}
                    </span>
                    <span
                      className={`tabular-nums text-xs font-semibold ${
                        over ? 'text-[var(--negative)]' : 'text-[var(--positive)]'
                      }`}
                    >
                      {formatCurrency(c.currentMonthActual)} / {formatCurrency(goal)}
                    </span>
                  </div>

                  {/* progress bar */}
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, pct * 100)}%`,
                        background: over ? 'var(--negative)' : 'var(--positive)',
                      }}
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0}
                      max={sliderMax}
                      step={step}
                      value={goal}
                      onChange={(e) => setGoals((g) => ({ ...g, [c.categoryId]: Number(e.target.value) }))}
                      onPointerUp={() => persistGoal(c.categoryId, goal)}
                      onKeyUp={() => persistGoal(c.categoryId, goal)}
                      className="w-full accent-[var(--accent)]"
                    />
                    <input
                      type="number"
                      min={0}
                      value={Math.round(goal)}
                      onChange={(e) => setGoals((g) => ({ ...g, [c.categoryId]: Number(e.target.value) }))}
                      onBlur={() => persistGoal(c.categoryId, goal)}
                      className="w-20 rounded-lg border border-[var(--border)] bg-transparent px-2 py-1 text-right text-sm tabular-nums"
                    />
                  </div>
                  <span className="text-[11px] text-[var(--muted)]">
                    avg {formatCurrency(avg)}/mo ({mode === 'year' ? data.year : 'last 12mo'})
                    {c.suggestedGoal !== goal && <> · suggested {formatCurrency(c.suggestedGoal)}</>}
                  </span>
                </li>
              )
            })}
          </ul>

          {/* Total row */}
          <div className="mt-2 flex items-center justify-between border-t-2 border-[var(--border)] pt-3 text-sm font-bold">
            <span>Total goals</span>
            <span className="tabular-nums">
              {formatCurrency(totalActual)} / {formatCurrency(G)}
            </span>
          </div>
        </Card>
      </div>

      {/* Auto-balance warning */}
      {autoBalanceWarning && (
        <div className="flex items-start gap-3 rounded-xl border border-[color-mix(in_srgb,var(--negative)_40%,transparent)] bg-[color-mix(in_srgb,var(--negative)_8%,transparent)] px-4 py-3 text-sm text-[var(--negative)]">
          <span className="mt-0.5 shrink-0 font-bold">!</span>
          <div className="flex-1">
            <p className="font-medium">Can&apos;t auto-balance</p>
            <p className="mt-0.5 text-xs opacity-80">{autoBalanceWarning}</p>
          </div>
          <button
            onClick={() => setAutoBalanceWarning(null)}
            className="shrink-0 text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            ✕
          </button>
        </div>
      )}

      {/* Unavoidable this month */}
      <Card
        title="Unavoidable this month"
        action={
          <Link href="/budget/bills" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
            manage bills →
          </Link>
        }
      >
        {data.unavoidable.lines.length ? (
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {data.unavoidable.lines.map((l) => (
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
            <li className="flex items-center justify-between gap-3 border-t-2 border-[var(--border)] pt-2 text-sm font-bold">
              <span>Total unavoidable (F)</span>
              <span className="tabular-nums">{formatCurrency(F)}</span>
            </li>
          </ul>
        ) : (
          <p className="text-xs text-[var(--muted)]">
            Nothing projected this month. Add recurring bills on the Settings page.
          </p>
        )}
      </Card>

      {/* Budget vs real spending */}
      <Card title="Spending pace" action={<span className="text-xs text-[var(--muted)]">monthly real spend vs your cap</span>}>
        <Legend items={[{ color: SPEND_COLOR, label: 'Real spend' }, { color: BUDGET_COLOR, label: 'Monthly cap' }]} />
        <LineChart
          labels={data.monthly.labels.slice(0, data.currentMonthIndex + 1)}
          series={[
            { color: SPEND_COLOR, name: 'Real spend', values: data.monthly.realSpend.slice(0, data.currentMonthIndex + 1) },
            {
              color: BUDGET_COLOR,
              name: 'Monthly cap',
              values: data.monthly.realSpend.slice(0, data.currentMonthIndex + 1).map(() => B),
            },
          ]}
          area={false}
        />
        <p className="mt-2 text-xs text-[var(--muted)]">
          Bars above the cap line are months you outspent the budget. Fills in further as you import new statements.
        </p>
      </Card>
    </div>
  )
}

function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="mb-3 flex flex-wrap gap-4 text-xs text-[var(--muted)]">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  )
}
