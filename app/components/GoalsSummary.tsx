import { Card } from '@/app/components/AppShell'
import { formatCurrency } from '@/app/lib/format'
import type { GoalView } from '@/app/actions/goals'

/**
 * Read-only mini view of the Goals page (`/accounts`) for the Overview dashboard.
 * Shows active goals at a glance — value + progress — and links to the full,
 * editable version. No mutations here; it mirrors what GoalsManager renders.
 */
export function GoalsSummary({ goals }: { goals: GoalView[] }) {
  const active = goals.filter((g) => !g.archived)
  if (active.length === 0) return null

  return (
    <Card
      title="Goals 🎯"
      action={
        <a href="/accounts" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
          View all →
        </a>
      }
    >
      <ul className="flex flex-col divide-y divide-[var(--border)]">
        {active.map((g) => (
          <GoalRow key={g.id} goal={g} />
        ))}
      </ul>
    </Card>
  )
}

function GoalRow({ goal }: { goal: GoalView }) {
  const isMortgage = goal.kind === 'mortgage'
  const isNetZero = goal.kind === 'netzero'
  const pct = goal.progressPct

  // Right-hand status: a progress % for savings, an on-track badge otherwise.
  let status: React.ReactNode = null
  if (isMortgage && goal.mortgage) {
    status = <Badge ok={goal.mortgage.onTrack}>{goal.mortgage.onTrack ? 'On track' : 'Behind'}</Badge>
  } else if (isNetZero && goal.netZero) {
    const met = goal.netZero.value >= -0.005
    status = <Badge ok={met}>{met ? 'Net zero ✓' : 'In the red'}</Badge>
  } else if (pct !== null) {
    status = <span className="text-xs font-medium tabular-nums text-[var(--muted)]">{Math.round(pct)}%</span>
  }

  const value = isNetZero && goal.netZero && goal.netZero.value >= -0.005 ? 0 : goal.value

  // For a savings goal with a target date: what to put in THIS month to stay on
  // schedule — the full monthly need (remaining ÷ months left).
  //
  // This deliberately does NOT subtract `currentPace`. That pace is computed from
  // past contributions, which are themselves surplus allocations — the same money
  // this line is asking you to allocate. Netting them counted it twice and
  // understated the ask (Insurance: $469 shown vs $700 actually needed, a ~$2,000
  // shortfall by the target date). The Goals page shows need and pace as two
  // separate stats, which is the honest way to compare them.
  const pace = goal.targetPace
  const needed = !isMortgage && !isNetZero && pace && pace.monthsLeft > 0 ? round2(pace.neededPerMonth) : 0

  return (
    <li className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-base"
        style={{ background: `${goal.color}22` }}
      >
        {goal.emoji}
      </span>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{goal.name}</span>
        {!isMortgage && !isNetZero && goal.targetAmount && pct !== null ? (
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: goal.color }} />
          </div>
        ) : (
          <p className="mt-0.5 truncate text-xs text-[var(--muted)]">{goal.milestone}</p>
        )}
        {needed > 0 && pace && (
          <p className="mt-1 truncate text-xs font-medium text-[var(--accent)]">
            {formatCurrency(needed)}/mo for {pace.monthsLeft} {pace.monthsLeft === 1 ? 'month' : 'months'} to hit
            target
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-right">
        <span className="text-sm font-semibold tabular-nums">{formatCurrency(value)}</span>
        {status}
      </div>
    </li>
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
        ok ? 'bg-[var(--positive)]/15 text-[var(--positive)]' : 'bg-[var(--negative)]/15 text-[var(--negative)]'
      }`}
    >
      {children}
    </span>
  )
}
