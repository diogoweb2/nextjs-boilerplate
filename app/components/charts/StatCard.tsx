import { formatPercentDelta, formatCurrency } from '@/app/lib/format'
import { LogoMark } from '@/app/components/Logo'

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
  reportHref,
  hero = false,
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
  /**
   * When set, shows a small bar-chart icon in the label row linking to a history
   * report. Uses a full-coverage invisible link for `href` so the two anchors
   * never nest (valid HTML, no event handlers needed).
   */
  reportHref?: string
  /** Vault-green headline tile with the winged-bill watermark. */
  hero?: boolean
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

  // Hero tile: the headline number, set into the vault with the brand mark
  // ghosted in the corner. Deltas re-tint for the dark green background.
  if (hero) {
    const isBad = delta && delta.direction !== 'flat' && (invertColors ? delta.direction === 'up' : delta.direction === 'down')
    const heroBadge =
      delta && delta.direction !== 'flat'
        ? isBad
          ? 'bg-[rgba(255,120,130,0.18)] text-[#ffb3bb]'
          : 'bg-[rgba(120,255,180,0.16)] text-[#8df0b8]'
        : 'bg-[rgba(255,255,255,0.1)] text-[#9ed8b5]'
    return (
      <div className="hero-stat col-span-2 flex flex-col gap-1.5 p-5">
        <LogoMark className="hero-watermark" />
        <span className="hero-muted text-xs font-medium uppercase tracking-widest">{label}</span>
        <span className="font-display text-4xl font-bold tabular-nums tracking-tight leading-none">
          {value}
        </span>
        <div className="flex items-center gap-2">
          {delta && (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${heroBadge}`}>
              {delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : ''}
              {delta.text}
            </span>
          )}
          {delta && (
            <span className="hero-muted text-[11px]">
              vs previous period – {formatCurrency(previous!)}
            </span>
          )}
        </div>
        {hint && <span className="hero-muted relative z-10 text-xs">{hint}</span>}
      </div>
    )
  }

  // Budget progress: green under 85%, amber up to 100%, red over budget.
  const showBudget = budget !== undefined && budget > 0 && current !== undefined
  const ratio = showBudget ? current / budget : 0
  const barColor = ratio >= 1 ? 'var(--negative)' : ratio >= 0.85 ? 'var(--warning)' : 'var(--positive)'

  const chartIcon = (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor" aria-hidden="true">
      <rect x="1" y="8" width="3" height="4" rx="0.5" />
      <rect x="5" y="5" width="3" height="7" rx="0.5" />
      <rect x="9" y="2" width="3" height="10" rx="0.5" />
    </svg>
  )

  // When reportHref is set: outer is a <div> so we can place two independent
  // <a> tags — a full-coverage invisible one for the tile action and a visible
  // icon link for the report — without ever nesting anchors.
  if (reportHref) {
    return (
      <div className="card flex flex-col gap-1 p-4 relative transition-colors hover:border-[var(--accent)]">
        {/* Full-coverage link: makes the whole card clickable for `href` */}
        {href && (
          <a
            href={href}
            className="absolute inset-0 z-0 rounded-[inherit]"
            aria-label={`${label} transactions`}
          />
        )}
        {/* Label row — sits above the full-coverage link */}
        <span className="relative z-10 flex items-center justify-between gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
          <span className="flex items-center gap-1.5 pointer-events-none">
            {accent && (
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: accent }}
              />
            )}
            {label}
          </span>
          <a
            href={reportHref}
            title={`${label} history`}
            className="rounded p-0.5 hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]"
          >
            {chartIcon}
          </a>
        </span>
        {/* Rest of content — pointer-events-none so clicks pass through to the full-coverage link */}
        <div className="relative z-10 flex flex-col gap-1 pointer-events-none">
          <span className="font-display text-2xl font-bold tabular-nums tracking-tight leading-none">{value}</span>
          {delta && (
            <span className={`self-start rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${badgeClass}`}>
              {delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : ''}{delta.text}
            </span>
          )}
          {delta && (
            <span className="text-[10px] text-[var(--muted)]">
              vs previous period – {formatCurrency(previous!)}
            </span>
          )}
          {hint && <span className="text-xs text-[var(--muted)]">{hint}</span>}
          {showBudget && (
            <div className="mt-2 flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
                  Budget
                </span>
                <span className="text-[10px] font-semibold tabular-nums" style={{ color: barColor }}>
                  {Math.round(ratio * 100)}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
                <div
                  className={`h-full rounded-full transition-all ${ratio >= 0.85 ? 'bar-sheen' : ''}`}
                  style={{ width: `${Math.min(100, ratio * 100)}%`, backgroundColor: barColor }}
                />
              </div>
              <div className="flex items-baseline justify-between text-[10px] tabular-nums text-[var(--muted)]">
                <span>of {formatCurrency(budget)}</span>
                {ratio < 1 ? (
                  <span style={{ color: barColor }}>{formatCurrency(budget - current!)} left</span>
                ) : (
                  <span style={{ color: barColor }}>{formatCurrency(current! - budget)} over 💀</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

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
      <span className="font-display text-2xl font-bold tabular-nums tracking-tight leading-none">{value}</span>
      {delta && (
        <span className={`self-start rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${badgeClass}`}>
          {delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : ''}{delta.text}
        </span>
      )}
      {delta && (
        <span className="text-[10px] text-[var(--muted)]">
          vs previous period – {formatCurrency(previous!)}
        </span>
      )}
      {hint && <span className="text-xs text-[var(--muted)]">{hint}</span>}
      {showBudget && (
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
              Budget
            </span>
            <span className="text-[10px] font-semibold tabular-nums" style={{ color: barColor }}>
              {Math.round(ratio * 100)}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
            <div
              className={`h-full rounded-full transition-all ${ratio >= 0.85 ? 'bar-sheen' : ''}`}
              style={{ width: `${Math.min(100, ratio * 100)}%`, backgroundColor: barColor }}
            />
          </div>
          <div className="flex items-baseline justify-between text-[10px] tabular-nums text-[var(--muted)]">
            <span>of {formatCurrency(budget)}</span>
            {ratio < 1 ? (
              <span style={{ color: barColor }}>{formatCurrency(budget - current!)} left</span>
            ) : (
              <span style={{ color: barColor }}>{formatCurrency(current! - budget)} over 💀</span>
            )}
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
