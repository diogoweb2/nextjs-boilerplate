'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/app/components/AppShell'
import { StatCard } from '@/app/components/charts/StatCard'
import { LineChart } from '@/app/components/charts/LineChart'
import { formatCurrency, formatCurrencyCompact, formatMonth } from '@/app/lib/format'
import type { BudgetData, PeriodMode } from '@/app/lib/budget'
import { saveGoal, saveSettings, resetGoals } from '@/app/actions/budget'

const SPEND_COLOR = '#ef4444'
const BUDGET_COLOR = '#6366f1'
const ACTUAL_COLOR = '#0ea5e9'

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
  const F = sum(data.categories.filter((c) => c.fixed).map((c) => goals[c.categoryId] ?? 0))
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
                    {c.name}
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

      {/* Net trajectory toward the target */}
      <Card title="Net trajectory" action={<span className="text-xs text-[var(--muted)]">cumulative net → Dec 31 target</span>}>
        <NetTrajectory
          labels={data.monthly.labels}
          cumulativeNet={data.monthly.cumulativeNet}
          currentIndex={data.currentMonthIndex}
          completedBaseline={data.completedBaseline}
          targetNet={targetNet}
          monthsRemaining={data.monthsRemaining}
          onTrack={onTrack}
        />
        <Legend
          items={[
            { color: ACTUAL_COLOR, label: 'Actual cumulative net' },
            { color: onTrack ? 'var(--positive)' : 'var(--negative)', label: 'Required path to target' },
          ]}
        />
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

/**
 * Small SVG that handles negative cumulative net: plots actual net through the
 * current month and the straight "required path" from the last completed month's
 * baseline up to the target by December, with a zero reference line.
 */
function NetTrajectory({
  labels,
  cumulativeNet,
  currentIndex,
  completedBaseline,
  targetNet,
  monthsRemaining,
  onTrack,
}: {
  labels: string[]
  cumulativeNet: (number | null)[]
  currentIndex: number
  completedBaseline: number
  targetNet: number
  monthsRemaining: number
  onTrack: boolean
}) {
  const width = 640
  const height = 200
  const padX = 40
  const padTop = 16
  const padBottom = 28
  const n = labels.length
  const innerW = width - padX * 2
  const innerH = height - padTop - padBottom
  const lastCompleted = currentIndex - 1 // index of the last fully-complete month

  // Required path: baseline at lastCompleted → target at Dec (index 11).
  const slope = monthsRemaining > 0 ? (targetNet - completedBaseline) / monthsRemaining : 0
  const guide: { i: number; v: number }[] = []
  for (let i = Math.max(0, lastCompleted); i <= n - 1; i++) {
    guide.push({ i, v: completedBaseline + (i - lastCompleted) * slope })
  }

  const actual = cumulativeNet
    .map((v, i) => (v === null ? null : { i, v }))
    .filter((p): p is { i: number; v: number } => p !== null)

  const allV = [...actual.map((p) => p.v), ...guide.map((p) => p.v), 0]
  const min = Math.min(...allV)
  const max = Math.max(...allV)
  const span = max - min || 1
  const x = (i: number) => padX + (i / (n - 1)) * innerW
  const y = (v: number) => padTop + innerH - ((v - min) / span) * innerH

  const guideColor = onTrack ? 'var(--positive)' : 'var(--negative)'
  const toPts = (ps: { i: number; v: number }[]) => ps.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
      {/* zero line */}
      <line x1={padX} x2={width - padX} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeWidth={1} />
      <text x={4} y={y(0) + 3} style={{ fontSize: 9 }} className="fill-[var(--muted)]">
        $0
      </text>
      {/* target marker */}
      <line
        x1={padX}
        x2={width - padX}
        y1={y(targetNet)}
        y2={y(targetNet)}
        stroke={guideColor}
        strokeWidth={1}
        strokeDasharray="2 3"
        opacity={0.5}
      />

      {/* required path */}
      <polyline
        points={toPts(guide)}
        fill="none"
        stroke={guideColor}
        strokeWidth={2}
        strokeDasharray="5 4"
        strokeLinejoin="round"
      />
      {/* actual */}
      <polyline points={toPts(actual)} fill="none" stroke={ACTUAL_COLOR} strokeWidth={2.5} strokeLinejoin="round" />
      {actual.map((p) => (
        <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={2.8} fill={ACTUAL_COLOR}>
          <title>{`${formatMonth(labels[p.i])}: ${formatCurrencyCompact(p.v)}`}</title>
        </circle>
      ))}

      {labels.map((lab, i) => (
        <text key={lab} x={x(i)} y={height - 8} textAnchor="middle" style={{ fontSize: 9 }} className="fill-[var(--muted)]">
          {formatMonth(lab).replace(' 20', " '")}
        </text>
      ))}
    </svg>
  )
}
