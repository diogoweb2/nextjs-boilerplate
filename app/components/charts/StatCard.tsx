import { formatPercentDelta, formatCurrency } from '@/app/lib/format'

/** Headline KPI tile with optional period-over-period delta badge. */
export function StatCard({
  label,
  value,
  current,
  previous,
  invertColors = false,
  hint,
  href,
  accent,
  budget,
}: {
  label: string
  value: string
  current?: number
  previous?: number
  /** When true, "up" is bad (red) — used for spending. */
  invertColors?: boolean
  hint?: string
  /** When set, the whole tile becomes a link. */
  href?: string
  /** Optional accent color (a small dot next to the label). */
  accent?: string
  /**
   * Spending budget for the displayed period. When > 0 (and `current` is set) a
   * progress bar + "Budget" usage label render at the bottom of the tile.
   */
  budget?: number
}) {
  const delta =
    current !== undefined && previous !== undefined
      ? formatPercentDelta(current, previous)
      : null

  let badgeClass = 'text-[var(--muted)] bg-[var(--surface-2)]'
  if (delta && delta.direction !== 'flat') {
    const isBad = invertColors ? delta.direction === 'up' : delta.direction === 'down'
    badgeClass = isBad
      ? 'text-[var(--negative)] bg-[color-mix(in_srgb,var(--negative)_12%,transparent)]'
      : 'text-[var(--positive)] bg-[color-mix(in_srgb,var(--positive)_14%,transparent)]'
  }

  // Budget progress: green under 85%, amber up to 100%, red over budget.
  const showBudget = budget !== undefined && budget > 0 && current !== undefined
  const ratio = showBudget ? current / budget : 0
  const barColor = ratio >= 1 ? 'var(--negative)' : ratio >= 0.85 ? 'var(--warning)' : 'var(--positive)'

  const inner = (
    <>
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
        {accent && (
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: accent }}
          />
        )}
        {label}
      </span>
      <div className="flex items-end justify-between gap-2">
        <span className="text-2xl font-bold tabular-nums tracking-tight">{value}</span>
        {delta && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badgeClass}`}>
            {delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : ''} {delta.text}
          </span>
        )}
      </div>
      {delta && (
        <span className="text-[10px] text-[var(--muted)]">
          vs previous period – {formatCurrency(previous!)}
        </span>
      )}
      {hint && <span className="text-xs text-[var(--muted)]">{hint}</span>}
      {showBudget && (
        <div className="mt-2 flex flex-col gap-1">
          <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
            <span>Budget</span>
            <span className="tabular-nums" style={{ color: barColor }}>
              {Math.round(ratio * 100)}% of {formatCurrency(budget)}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${Math.min(100, ratio * 100)}%`, backgroundColor: barColor }}
            />
          </div>
        </div>
      )}
    </>
  )

  if (href) {
    return (
      <a
        href={href}
        className="card flex flex-col gap-1 p-4 transition-colors hover:border-[var(--accent)]"
      >
        {inner}
      </a>
    )
  }

  return <div className="card flex flex-col gap-1 p-4">{inner}</div>
}
