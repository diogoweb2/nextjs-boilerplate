'use client'

import { useState } from 'react'
import {
  buildScenarios,
  headroomToTarget,
  runwayStatus,
  RUNWAY_TARGET as TARGET,
  RUNWAY_WARN as WARN,
  type RunwayInputs,
  type RunwayScenario,
  type RunwayStatus,
} from '@/app/lib/runway'
import type { RunwayPoint } from '@/app/actions/emergency'
import { RunwayHistoryChart } from '@/app/components/charts/RunwayHistoryChart'
import { formatCurrency } from '@/app/lib/format'

const STATUS_VAR: Record<RunwayStatus, string> = {
  green: 'var(--positive)',
  amber: 'var(--warning)',
  red: 'var(--negative)',
}
function statusColor(months: number | null): string {
  return STATUS_VAR[runwayStatus(months)]
}
function monthsLabel(months: number | null): string {
  if (months === null) return '∞'
  return `${months.toFixed(1)} mo`
}

/**
 * Emergency-fund runway widget: how many months the fund covers expenses under
 * three job-loss scenarios, with a 9-month target zone and a toggle to exclude
 * trips (a discretionary cut). Pairs with the 50/30/20 card. See app/lib/runway.ts.
 */
export function RunwayWidget({
  fund,
  committed = 0,
  inputs,
  names,
  history = [],
}: {
  fund: number
  /** Unpaid credit-card balance — already committed, so it reduces available cash. */
  committed?: number
  inputs: RunwayInputs
  names: { self: string; partner: string }
  /** Worst-case runway history points for the trend chart. */
  history?: RunwayPoint[]
}) {
  const [excludeTravel, setExcludeTravel] = useState(false)
  const available = Math.max(0, fund - committed)
  const { burn, scenarios } = buildScenarios(inputs, available, excludeTravel, names)
  const headroom = headroomToTarget(inputs, available, excludeTravel, TARGET, names)

  // Fixed-ish axis so the target marker stays stable; grow if a bar exceeds it.
  // Keep headroom past the 9-month target so its green zone is visible.
  const finite = scenarios.map((s) => s.months).filter((m): m is number => m !== null)
  const axisMax = Math.max(12, Math.ceil(Math.max(0, ...finite)))
  const pct = (m: number) => `${Math.min(100, (m / axisMax) * 100)}%`

  const hasTravel = inputs.travel > 0.005

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-[var(--muted)]">
            Months covered by {formatCurrency(available)} · burn {formatCurrency(burn)}/mo
          </p>
          {committed > 0.005 && (
            <p className="text-[11px] text-[var(--muted)]">
              {formatCurrency(fund)} fund − {formatCurrency(committed)} card balance due
            </p>
          )}
        </div>
        {hasTravel && (
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-[var(--muted)]">
            <input
              type="checkbox"
              checked={excludeTravel}
              onChange={(e) => setExcludeTravel(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            Exclude trips
          </label>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {scenarios.map((s) => (
          <ScenarioBar key={s.key} s={s} axisMax={axisMax} pct={pct} />
        ))}
      </div>

      {/* Headroom: how much you can move out / must add to hit the target, worst case. */}
      <div className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs">
        {headroom.coversBurn ? (
          <span className="text-[var(--positive)]">
            {headroom.worstEarnerName}&apos;s salary alone covers expenses — fund isn&apos;t at risk.
          </span>
        ) : headroom.headroom >= 0 ? (
          <span>
            You can move{' '}
            <span className="font-semibold text-[var(--positive)]">{formatCurrency(headroom.headroom)}</span>{' '}
            elsewhere and still keep {TARGET} months if {headroom.worstEarnerName} lost their job.
          </span>
        ) : (
          <span>
            Add{' '}
            <span className="font-semibold text-[var(--negative)]">{formatCurrency(-headroom.headroom)}</span>{' '}
            to reach {TARGET} months if {headroom.worstEarnerName} lost their job.
          </span>
        )}
      </div>

      {history.length >= 2 && (
        <div className="border-t border-[var(--border)] pt-3">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Runway trend
          </h3>
          <RunwayHistoryChart points={history} />
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-[var(--muted)]">
        Target 9 months (green zone). Monthly burn = recent Needs + Wants
        {excludeTravel ? ' (trips excluded)' : ''}, averaged over {inputs.completeMonths || 1} month
        {inputs.completeMonths === 1 ? '' : 's'}; investing &amp; extra mortgage are assumed paused. Non-salary
        income (family support, benefits) is assumed to continue.
      </p>
    </div>
  )
}

function ScenarioBar({
  s,
  axisMax,
  pct,
}: {
  s: RunwayScenario
  axisMax: number
  pct: (m: number) => string
}) {
  const color = statusColor(s.months)
  const fill = s.months === null ? '100%' : pct(s.months)
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="font-medium">{s.label}</span>
        <span className="tabular-nums font-semibold" style={{ color }}>
          {monthsLabel(s.months)}
        </span>
      </div>
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
        {/* target zone: at/above 9 months */}
        <div
          className="absolute top-0 h-full bg-[color-mix(in_srgb,var(--positive)_20%,transparent)]"
          style={{ left: pct(TARGET), width: `${((axisMax - TARGET) / axisMax) * 100}%` }}
        />
        {/* runway fill */}
        <div className="absolute left-0 top-0 h-full rounded-full" style={{ width: fill, background: color }} />
        {/* warn (6) & target (9) ticks */}
        {[WARN, TARGET].map((m) => (
          <div
            key={m}
            className="absolute top-[-2px] h-[calc(100%+4px)] w-px bg-[var(--foreground)] opacity-40"
            style={{ left: pct(m) }}
          />
        ))}
      </div>
    </div>
  )
}
