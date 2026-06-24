'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card } from '@/app/components/AppShell'
import { StatCard } from '@/app/components/charts/StatCard'
import { LineChart } from '@/app/components/charts/LineChart'
import { formatCurrency, formatCurrencyCompact, formatMonth } from '@/app/lib/format'
import type { BudgetData, PeriodMode } from '@/app/lib/budget'
import { saveGoal, saveSettings, resetGoals } from '@/app/actions/budget'

const SPEND_COLOR = '#ef4444'
const BUDGET_COLOR = '#6366f1'
function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0)
}

export function BudgetPlanner({ data }: { data: BudgetData }) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  // Local, live-editable state (persisted to the server on commit).
  const [targetNet, setTargetNet] = useState(data.targetNet)
  const [goals, setGoals] = useState<Record<number, number>>(() =>
    Object.fromEntries(data.categories.map((c) => [c.categoryId, c.goal]))
  )

  // Re-sync from the server payload when it changes (period toggle / reset /
  // refresh) — React's "adjust state during render" pattern, no effect needed.
  const [prevData, setPrevData] = useState(data)
  if (prevData !== data) {
    setPrevData(data)
    setTargetNet(data.targetNet)
    setGoals(Object.fromEntries(data.categories.map((c) => [c.categoryId, c.goal])))
  }

  const mode = data.periodMode
  const avgOf = (c: BudgetData['categories'][number]) => (mode === 'year' ? c.avgYear : c.avg12)

  // --- Live derived figures (pure arithmetic from local state) ---
  const goalList = data.categories.map((c) => goals[c.categoryId] ?? 0)
  const G = sum(goalList) // sum of all goals
  // F = everything unavoidable this month (fixed cats + projected bills +
  // subscriptions), projected from history — see Settings. Replaces the old
  // "sum of fixed-category goals".
  const F = data.unavoidable.total
  const B = data.income + (data.completedBaseline - targetNet) / data.monthsRemaining
  const X = B - F // ideal discretionary spend this month
  const projectedNet = data.completedBaseline + data.monthsRemaining * (data.income - G)
  const onTrack = projectedNet >= targetNet - 0.5
  const totalActual = sum(data.categories.map((c) => c.currentMonthActual))

  // --- Persistence helpers ---
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
      {/* Headline KPIs (update live with the target & goals) */}
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

      {/* Controls */}
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

      {/* Unavoidable this month (drives X = B − F) */}
      <Card
        title="Unavoidable this month"
        action={
          <Link href="/settings" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
            manage in Settings →
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

      {/* Category goals */}
      <Card title="Category goals" action={<span className="text-xs text-[var(--muted)]">goal vs avg · this month so far</span>}>
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

                {/* progress bar: this month vs goal */}
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


