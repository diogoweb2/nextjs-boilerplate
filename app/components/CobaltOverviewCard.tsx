import { Card } from '@/app/components/AppShell'
import { formatCurrency } from '@/app/lib/format'
import { COBALT_FEE_MONTHLY, TIER_META, type CobaltAnalysis } from '@/app/lib/amex-cobalt-core'

/** Compact dashboard widget: is the Cobalt paying for itself? Points earned
 *  minus the membership fee, month by month and over the last 12 months.
 *  The Rogers comparison and full reasoning live on Accounts › Amex Cobalt. */
export function CobaltOverviewCard({ cobalt }: { cobalt: CobaltAnalysis }) {
  const recent = cobalt.monthly.slice(-12)
  const points = recent.reduce((sum, m) => sum + m.valueDollars, 0)
  const fees = recent.reduce((sum, m) => sum + m.fee, 0)
  const net = points - fees
  const positive = net >= 0
  const maxAbs = Math.max(1, ...recent.map((m) => Math.abs(m.net)))
  const monthsLabel = recent.length === 1 ? 'last month' : `last ${recent.length} months`
  // Recovered from the priced result rather than re-imported, so the rules list
  // always shows the ¢/point this box actually used.
  const totalPoints = recent.reduce((sum, m) => sum + m.points, 0)
  const centsPerPoint = totalPoints > 0 ? (points / totalPoints) * 100 : 0
  const feeMonthly = recent.length > 0 ? recent[recent.length - 1].fee : COBALT_FEE_MONTHLY

  return (
    <Card
      title="Amex Cobalt: net value"
      action={<span className="text-xs text-[var(--muted)]">points earned − membership fee</span>}
    >
      <a href="/accounts/cobalt" className="group flex flex-col gap-4 no-underline">
        <div className="flex items-center justify-between gap-3">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${
              positive
                ? 'text-[var(--positive)] bg-[color-mix(in_srgb,var(--positive)_14%,transparent)]'
                : 'text-[var(--negative)] bg-[color-mix(in_srgb,var(--negative)_12%,transparent)]'
            }`}
          >
            <span aria-hidden="true">{positive ? '✅' : '⚠️'}</span>
            {positive ? 'Paying for itself' : 'Costing you money'}
          </span>
          <span className="text-xs font-medium text-[var(--accent)] opacity-0 transition-opacity group-hover:opacity-100">
            See full breakdown →
          </span>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className={`font-display text-3xl font-bold tabular-nums tracking-tight ${
              positive ? 'text-[var(--positive)]' : 'text-[var(--negative)]'
            }`}
          >
            {positive ? '+' : ''}
            {formatCurrency(net)}
          </span>
          <span className="text-xs text-[var(--muted)]">net over the {monthsLabel}</span>
        </div>

        <div className="text-xs text-[var(--muted)]">
          {formatCurrency(points)} in points earned − {formatCurrency(fees)} in fees
        </div>

        {recent.length > 0 && (
          <div className="flex items-end gap-1.5">
            {recent.map((m) => {
              const heightPct = Math.max(8, (Math.abs(m.net) / maxAbs) * 100)
              return (
                <div
                  key={m.ym}
                  className="flex flex-1 flex-col items-center gap-1"
                  title={`${m.ym}: ${m.net >= 0 ? '+' : ''}${formatCurrency(m.net)} (${formatCurrency(
                    m.valueDollars,
                  )} points − ${formatCurrency(m.fee)} fee)`}
                >
                  {/* Bars hang above/below a shared baseline so a losing month
                      reads as losing at a glance, not just as a red bar. */}
                  <div className="flex h-8 w-full items-end justify-center">
                    {m.net >= 0 && (
                      <div
                        className="w-full max-w-[18px] rounded-sm bg-[var(--positive)]"
                        style={{ height: `${heightPct}%`, opacity: 0.85 }}
                      />
                    )}
                  </div>
                  <div className="h-px w-full bg-[var(--border)]" />
                  <div className="flex h-8 w-full items-start justify-center">
                    {m.net < 0 && (
                      <div
                        className="w-full max-w-[18px] rounded-sm bg-[var(--negative)]"
                        style={{ height: `${heightPct}%`, opacity: 0.85 }}
                      />
                    )}
                  </div>
                  <span className="text-[9px] text-[var(--muted)]">{m.ym.slice(5)}</span>
                </div>
              )
            })}
          </div>
        )}
      </a>

      {/* Spelled out so the owner can check the model against the real card. */}
      <details className="mt-4 border-t border-[var(--border)] pt-3">
        <summary className="cursor-pointer text-xs font-medium text-[var(--muted)]">
          Earn rules used
        </summary>
        <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
          {Object.values(TIER_META).map((t) => (
            <li key={t.label}>
              <span className="font-medium text-[var(--foreground)]">{t.multiplier}x</span> points — {t.label.replace(/\s*\(\d+x\)$/, '')}
            </li>
          ))}
          <li>
            Gift cards bought at a supermarket till (including ones split off a grocery bill) count as{' '}
            <span className="font-medium text-[var(--foreground)]">5x</span>; a plain amazon.ca order is 1x
          </li>
          <li>
            Points valued at{' '}
            <span className="font-medium text-[var(--foreground)]">{centsPerPoint.toFixed(2)}¢</span> each
          </li>
          <li>
            Fee <span className="font-medium text-[var(--foreground)]">{formatCurrency(feeMonthly)}/month</span> (
            {formatCurrency(feeMonthly * 12)}/year)
          </li>
          <li>
            Counts only purchases <span className="font-medium text-[var(--foreground)]">actually on the Amex</span> —
            the Cobalt vs Rogers page instead prices <em>all</em> card spend as if it ran through this card
          </li>
        </ul>
      </details>
    </Card>
  )
}
