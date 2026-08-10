import { Card } from '@/app/components/AppShell'
import { formatCurrency } from '@/app/lib/format'
import type { CobaltAnalysis, RogersAnalysis, CardShowdown } from '@/app/lib/amex-cobalt-core'

const VERDICT_META = {
  cobalt: { label: 'Keep Cobalt', emoji: '✅', badge: 'text-[var(--positive)] bg-[color-mix(in_srgb,var(--positive)_14%,transparent)]' },
  close: { label: 'Close call', emoji: '🤔', badge: 'text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_16%,transparent)]' },
  rogers: { label: 'Rogers wins', emoji: '⚠️', badge: 'text-[var(--negative)] bg-[color-mix(in_srgb,var(--negative)_12%,transparent)]' },
} as const

/** Compact dashboard widget: Cobalt vs the free Rogers World Elite alternative
 *  + a tiny month-by-month sparkline of who'd have won that month. Full
 *  reasoning lives on the Accounts › Amex Cobalt tab. */
export function CobaltOverviewCard({
  showdown,
}: {
  showdown: CardShowdown & { cobalt: CobaltAnalysis; rogers: RogersAnalysis }
}) {
  const { cobalt, rogers, advantage, verdict } = showdown
  const v = VERDICT_META[verdict]

  const rogersByMonth = new Map(rogers.monthly.map((m) => [m.ym, m.cashback]))
  const recent = cobalt.monthly.slice(-6).map((m) => ({ ym: m.ym, delta: m.net - (rogersByMonth.get(m.ym) ?? 0) }))
  const maxAbs = Math.max(1, ...recent.map((m) => Math.abs(m.delta)))

  return (
    <Card
      title="Amex Cobalt: worth it?"
      action={<span className="text-xs text-[var(--muted)]">vs Rogers World Elite (no fee)</span>}
    >
      <a href="/accounts/cobalt" className="group flex flex-col gap-4 no-underline">
        <div className="flex items-center justify-between gap-3">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${v.badge}`}
          >
            <span aria-hidden="true">{v.emoji}</span>
            {v.label}
          </span>
          <span className="text-xs font-medium text-[var(--accent)] opacity-0 transition-opacity group-hover:opacity-100">
            See full breakdown →
          </span>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className={`font-display text-3xl font-bold tabular-nums tracking-tight ${
              advantage >= 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]'
            }`}
          >
            {advantage >= 0 ? '+' : ''}
            {formatCurrency(advantage)}
          </span>
          <span className="text-xs text-[var(--muted)]">Cobalt advantage per year</span>
        </div>

        <div className="text-xs text-[var(--muted)]">
          Cobalt: {formatCurrency(cobalt.netAnnualValue)} net (points − fee) vs Rogers:{' '}
          {formatCurrency(rogers.annualizedCashback)} flat cash back
        </div>

        {recent.length > 0 && (
          <div className="flex items-end gap-1.5" aria-hidden="true">
            {recent.map((m) => {
              const heightPct = Math.max(8, (Math.abs(m.delta) / maxAbs) * 100)
              return (
                <div key={m.ym} className="flex flex-1 flex-col items-center gap-1">
                  <div className="flex h-10 w-full items-end justify-center">
                    <div
                      className={`w-full max-w-[18px] rounded-sm transition-all ${
                        m.delta >= 0 ? 'bg-[var(--positive)]' : 'bg-[var(--negative)]'
                      }`}
                      style={{ height: `${heightPct}%`, opacity: 0.85 }}
                    />
                  </div>
                  <span className="text-[9px] text-[var(--muted)]">{m.ym.slice(5)}</span>
                </div>
              )
            })}
          </div>
        )}
      </a>
    </Card>
  )
}
