import { formatPercentDelta } from '@/app/lib/format'

/** Headline KPI tile with optional period-over-period delta badge. */
export function StatCard({
  label,
  value,
  current,
  previous,
  invertColors = false,
  hint,
}: {
  label: string
  value: string
  current?: number
  previous?: number
  /** When true, "up" is bad (red) — used for spending. */
  invertColors?: boolean
  hint?: string
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

  return (
    <div className="card flex flex-col gap-1 p-4">
      <span className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
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
      {hint && <span className="text-xs text-[var(--muted)]">{hint}</span>}
    </div>
  )
}
