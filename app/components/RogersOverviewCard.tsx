import { Card } from '@/app/components/AppShell'
import { formatCurrency } from '@/app/lib/format'
import {
  FX_FEE,
  ROGERS_ANNUAL_CAP,
  ROGERS_DOMESTIC_BASE_RATE,
  ROGERS_DOMESTIC_BONUS_RATE,
  ROGERS_FOREIGN_GROSS_RATE,
  ROGERS_FOREIGN_NET_RATE,
  ROGERS_REDEMPTION_MULTIPLIER,
  type RogersAnalysis,
} from '@/app/lib/amex-cobalt-core'

const pct = (r: number) => `${(r * 100).toFixed(r * 100 % 1 === 0 ? 0 : 1)}%`

/** Dashboard twin of the Cobalt box, for the Rogers Mastercard the household
 *  actually carries: cash back earned vs the card's fee, month by month and
 *  over the last 12 months. The Rogers card has no annual fee, so the net is
 *  the cash back — the fee line stays in so the two boxes read the same way. */
export function RogersOverviewCard({ rogers, annualFee = 0 }: { rogers: RogersAnalysis; annualFee?: number }) {
  const recent = rogers.monthly.slice(-12)
  const feeMonthly = annualFee / 12
  const cashback = recent.reduce((sum, m) => sum + m.cashback, 0)
  const fees = feeMonthly * recent.length
  const net = cashback - fees
  const positive = net >= 0
  const maxAbs = Math.max(1, ...recent.map((m) => Math.abs(m.cashback - feeMonthly)))
  const monthsLabel = recent.length === 1 ? 'last month' : `last ${recent.length} months`

  return (
    <Card
      title="Rogers Mastercard: net value"
      action={<span className="text-xs text-[var(--muted)]">cash back earned − card fee</span>}
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
          {formatCurrency(cashback)} in cash back earned − {formatCurrency(fees)} in fees
        </div>

        {recent.length > 0 && (
          <div className="flex items-end gap-1.5">
            {recent.map((m) => {
              const monthNet = m.cashback - feeMonthly
              const heightPct = Math.max(8, (Math.abs(monthNet) / maxAbs) * 100)
              return (
                <div
                  key={m.ym}
                  className="flex flex-1 flex-col items-center gap-1"
                  title={`${m.ym}: ${monthNet >= 0 ? '+' : ''}${formatCurrency(monthNet)} (${formatCurrency(
                    m.cashback,
                  )} cash back − ${formatCurrency(feeMonthly)} fee)`}
                >
                  {/* Same above/below baseline layout as the Cobalt box. */}
                  <div className="flex h-8 w-full items-end justify-center">
                    {monthNet >= 0 && (
                      <div
                        className="w-full max-w-[18px] rounded-sm bg-[var(--positive)]"
                        style={{ height: `${heightPct}%`, opacity: 0.85 }}
                      />
                    )}
                  </div>
                  <div className="h-px w-full bg-[var(--border)]" />
                  <div className="flex h-8 w-full items-start justify-center">
                    {monthNet < 0 && (
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
          Cash-back rules used
        </summary>
        <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
          <li>
            <span className="font-medium text-[var(--foreground)]">{pct(ROGERS_DOMESTIC_BASE_RATE)}</span> on
            Canadian-dollar purchases (base rate — no qualifying Rogers/Fido/Shaw service assumed; it
            would be {pct(ROGERS_DOMESTIC_BONUS_RATE)} with one)
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">{pct(ROGERS_FOREIGN_NET_RATE)}</span> net on
            foreign-currency purchases ({pct(ROGERS_FOREIGN_GROSS_RATE)} back − {pct(FX_FEE)} FX fee)
          </li>
          <li>
            Elevated rates stop after{' '}
            <span className="font-medium text-[var(--foreground)]">
              ${ROGERS_ANNUAL_CAP.toLocaleString('en-CA')}
            </span>{' '}
            of annual spend, then everything earns {pct(ROGERS_DOMESTIC_BASE_RATE)}
          </li>
          <li>
            Cash back counted at face value — the{' '}
            <span className="font-medium text-[var(--foreground)]">{ROGERS_REDEMPTION_MULTIPLIER}x</span>{' '}
            bonus for redeeming against a Rogers/Fido bill is <em>not</em> applied (you&apos;re on Koodo)
          </li>
          <li>
            No annual fee — counts only purchases posted to this card
          </li>
        </ul>
      </details>
    </Card>
  )
}
