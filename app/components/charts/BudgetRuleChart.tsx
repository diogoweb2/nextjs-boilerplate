import { Donut } from '@/app/components/charts/Donut'
import { formatCurrency } from '@/app/lib/format'
import type { BudgetRuleData } from '@/app/lib/fifty-thirty-twenty'

/**
 * The 50/30/20 rule card body: a donut of the actual Needs/Wants/Savings split
 * plus one comparison row per bucket showing actual share of income vs the target
 * and the signed difference. See app/lib/fifty-thirty-twenty.ts.
 */
export function BudgetRuleChart({ data }: { data: BudgetRuleData }) {
  const spend = data.needs + data.wants + data.savings
  const pctText = (f: number) => `${Math.round(f * 100)}%`

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <p className="text-sm text-[var(--muted)]">
          Income this period:{' '}
          <span className="font-semibold text-[var(--foreground)]">{formatCurrency(data.income)}</span>
        </p>
        {data.income <= 0 && (
          <p className="text-xs text-[var(--muted)]">No income in this period — percentages need income.</p>
        )}
      </div>

      <Donut
        total={spend}
        segments={data.buckets.map((b) => ({
          name: b.label,
          color: b.color,
          amount: b.amount,
          pct: spend > 0 ? b.amount / spend : 0,
        }))}
      />

      <div className="flex flex-col gap-3">
        {data.buckets.map((b) => {
          // For Needs/Wants, over target is "bad"; for Savings, under is "bad".
          const over = b.diffPct > 0
          const good = b.key === 'savings' ? !over : over === false
          const onTarget = Math.abs(b.diffPct) < 0.01
          const tone = onTarget
            ? 'text-[var(--muted)]'
            : good
              ? 'text-[var(--positive)]'
              : 'text-[var(--negative)]'
          const pts = Math.round(b.diffPct * 100)
          const diffLabel = onTarget
            ? 'on target'
            : `${pts > 0 ? '+' : ''}${pts} pts · ${b.diffAmount > 0 ? '+' : '−'}${formatCurrency(Math.abs(b.diffAmount))}`
          const actualWidth = Math.min(100, Math.max(0, b.actualPct * 100))
          return (
            <div key={b.key}>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: b.color }} />
                  {b.label}
                  <span className="text-[var(--muted)]">{formatCurrency(b.amount)}</span>
                </span>
                <span className={`tabular-nums ${tone}`}>
                  {pctText(b.actualPct)} <span className="text-[var(--muted)]">/ {pctText(b.targetPct)}</span> ·{' '}
                  {diffLabel}
                </span>
              </div>
              {/* Track with the actual fill and a target marker. */}
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
                <div
                  className="absolute left-0 top-0 h-full rounded-full"
                  style={{ width: `${actualWidth}%`, background: b.color }}
                />
                <div
                  className="absolute top-[-2px] h-[calc(100%+4px)] w-0.5 bg-[var(--foreground)]"
                  style={{ left: `${Math.min(100, b.targetPct * 100)}%` }}
                  title={`Target ${pctText(b.targetPct)}`}
                />
              </div>
            </div>
          )
        })}
      </div>

      {data.dental && data.dental.coverage !== null && !data.dental.ok && (
        <p className="rounded-lg bg-[color-mix(in_srgb,var(--negative)_10%,transparent)] px-3 py-2 text-xs text-[var(--negative)]">
          Dental insurance covered only {pctText(data.dental.coverage)} of {formatCurrency(data.dental.expense)} in
          dental costs this period (target ≥ 80%). {formatCurrency(data.dental.reimbursed)} reimbursed.
        </p>
      )}
    </div>
  )
}
