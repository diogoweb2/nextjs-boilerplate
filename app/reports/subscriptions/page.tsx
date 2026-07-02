import { Card, EmptyHint } from '@/app/components/AppShell'
import { StatCard } from '@/app/components/charts/StatCard'
import { LineChart } from '@/app/components/charts/LineChart'
import { BarList } from '@/app/components/charts/BarList'
import { PriceSparkline } from '@/app/components/charts/PriceSparkline'
import { loadAllFlows } from '@/app/lib/analytics'
import { buildSubscriptionWatch, type SubscriptionRow } from '@/app/lib/subscription-watch'
import { loadAlertDismissals } from '@/app/actions/subscriptions'
import {
  DismissAlertButton,
  UndismissAlertButton,
} from '@/app/components/SubscriptionAlertControls'
import { formatCurrency, formatMonth } from '@/app/lib/format'

export const dynamic = 'force-dynamic'

function txnHref(name: string) {
  return `/transactions?period=all&q=${encodeURIComponent(name)}`
}

const CADENCE_LABEL: Record<SubscriptionRow['cadence'], string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Yearly',
  periodic: 'Periodic',
}

function StatusBadge({ row }: { row: SubscriptionRow }) {
  if (!row.active) {
    return (
      <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-semibold text-[var(--muted)]">
        Not seen since {formatMonth(row.lastSeen)}
      </span>
    )
  }
  if (row.alert) {
    const up = row.alert.delta > 0
    return (
      <span
        className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
        style={{
          color: up ? 'var(--negative)' : 'var(--positive)',
          background: `color-mix(in srgb, ${up ? 'var(--negative)' : 'var(--positive)'} 12%, transparent)`,
        }}
      >
        {up ? '↑ Price increase' : '↓ Price drop'}
      </span>
    )
  }
  if (row.variable) {
    return (
      <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-semibold text-[var(--muted)]">
        Variable price
      </span>
    )
  }
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{
        color: 'var(--positive)',
        background: 'color-mix(in srgb, var(--positive) 12%, transparent)',
      }}
    >
      Stable
    </span>
  )
}

export default async function ReportsSubscriptionsPage() {
  const all = await loadAllFlows()
  const dismissals = await loadAlertDismissals()
  const watch = buildSubscriptionWatch(all, dismissals)
  const dismissed = watch.rows.filter((r) => r.dismissedAlert)

  if (!watch.hasData) {
    return (
      <Card>
        <EmptyHint>
          No subscriptions yet — mark recurring merchants on the Merchants page and they&apos;ll
          show up here.
        </EmptyHint>
      </Card>
    )
  }

  const active = watch.rows.filter((r) => r.active)
  const inactive = watch.rows.filter((r) => !r.active)
  const annualCount = active.filter((r) => r.cadence === 'annual').length

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Monthly load"
          value={formatCurrency(watch.monthlyLoad)}
          hint="Active subscriptions, annual bills spread per month"
        />
        <StatCard label="Per year" value={formatCurrency(watch.annualLoad)} hint="If nothing changes" />
        <StatCard
          label="Active"
          value={String(watch.activeCount)}
          hint={`${annualCount} yearly · ${watch.inactiveCount} not seen lately`}
        />
        <StatCard
          label="Price changes"
          value={String(watch.changes12mo)}
          hint="Last 12 months"
        />
      </div>

      {watch.alerts.length > 0 && (
        <Card title="⚠ Price changes to review">
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {watch.alerts.map((a) => {
              const up = a.delta > 0
              return (
                <li key={a.merchantId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                  <div className="flex flex-col">
                    <a href={txnHref(a.name)} className="text-sm font-semibold hover:underline">
                      {a.name}
                    </a>
                    <span className="text-xs text-[var(--muted)]">
                      {CADENCE_LABEL[a.cadence]} · changed {formatMonth(a.sinceYm)} after a stable{' '}
                      {formatCurrency(a.previous)}
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-sm tabular-nums">
                      {formatCurrency(a.previous)} →{' '}
                      <span
                        className="font-bold"
                        style={{ color: up ? 'var(--negative)' : 'var(--positive)' }}
                      >
                        {formatCurrency(a.current)}
                      </span>{' '}
                      <span className="text-xs text-[var(--muted)]">
                        ({a.pctDelta > 0 ? '+' : ''}
                        {a.pctDelta}%)
                      </span>
                    </span>
                    <span
                      className="text-xs font-semibold tabular-nums"
                      style={{ color: up ? 'var(--negative)' : 'var(--positive)' }}
                    >
                      {up ? '+' : '−'}
                      {formatCurrency(Math.abs(a.annualizedDelta))}/yr
                    </span>
                    <DismissAlertButton
                      merchantId={a.merchantId}
                      sinceYm={a.sinceYm}
                      amount={a.current}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        </Card>
      )}

      {dismissed.length > 0 && (
        <Card className="py-0">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-4 sm:py-5">
              <h2 className="text-sm font-semibold text-[var(--foreground)]">
                Ignored price changes{' '}
                <span className="font-normal text-[var(--muted)]">({dismissed.length})</span>
              </h2>
              <span className="text-xs text-[var(--muted)] transition-transform group-open:rotate-180">
                ▾
              </span>
            </summary>
            <ul className="flex flex-col divide-y divide-[var(--border)] pb-4 sm:pb-5">
            {dismissed.map((r) => {
              const a = r.dismissedAlert!
              return (
                <li
                  key={r.merchantId}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0"
                >
                  <div className="flex flex-col">
                    <a href={txnHref(a.name)} className="text-sm font-medium hover:underline">
                      {a.name}
                    </a>
                    <span className="text-xs text-[var(--muted)]">
                      {CADENCE_LABEL[a.cadence]} · {formatCurrency(a.previous)} →{' '}
                      {formatCurrency(a.current)} in {formatMonth(a.sinceYm)} — marked not a real
                      increase
                    </span>
                  </div>
                  <UndismissAlertButton merchantId={r.merchantId} />
                </li>
              )
            })}
            </ul>
          </details>
        </Card>
      )}

      <Card title="Subscription spend by month">
        <LineChart
          labels={watch.monthlyTotals.map((p) => p.ym)}
          series={[{ color: 'var(--accent)', values: watch.monthlyTotals.map((p) => p.amount) }]}
          height={180}
        />
        <p className="mt-2 text-xs text-[var(--muted)]">
          Actual charges from recurring merchants. Spikes are usually a yearly bill landing.
        </p>
      </Card>

      <Card title="Where the money goes (per year)">
        <BarList
          items={active.slice(0, 10).map((r) => ({
            label: r.name,
            amount: r.annualCost,
            sublabel: CADENCE_LABEL[r.cadence],
            color: r.color,
            href: txnHref(r.name),
          }))}
        />
      </Card>

      <Card title={`All subscriptions (${watch.rows.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
                <th className="py-2 pr-3">Subscription</th>
                <th className="py-2 pr-3">Billing</th>
                <th className="py-2 pr-3 text-right">Price</th>
                <th className="py-2 pr-3">History</th>
                <th className="py-2 pr-3 text-right">Per month</th>
                <th className="py-2 pr-3 text-right">Per year</th>
                <th className="py-2 pr-3">Last charged</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {[...active, ...inactive].map((r) => (
                <tr key={r.merchantId} className={r.active ? '' : 'opacity-55'}>
                  <td className="py-2 pr-3">
                    <a
                      href={txnHref(r.name)}
                      className="flex items-center gap-2 font-medium hover:underline"
                    >
                      <span
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: r.color }}
                        title={r.category}
                      />
                      {r.name}
                    </a>
                  </td>
                  <td className="py-2 pr-3 text-xs text-[var(--muted)]">{CADENCE_LABEL[r.cadence]}</td>
                  <td className="py-2 pr-3 text-right tabular-nums font-semibold">
                    {formatCurrency(r.current)}
                    {r.alert && (
                      <div className="text-[10px] font-normal text-[var(--muted)]">
                        was {formatCurrency(r.alert.previous)}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <PriceSparkline
                      history={r.history.slice(-12)}
                      color={
                        r.alert
                          ? r.alert.delta > 0
                            ? 'var(--negative)'
                            : 'var(--positive)'
                          : 'var(--accent)'
                      }
                    />
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatCurrency(r.monthlyEquivalent)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatCurrency(r.annualCost)}</td>
                  <td className="py-2 pr-3 text-xs text-[var(--muted)]">{formatMonth(r.lastSeen)}</td>
                  <td className="py-2">
                    <StatusBadge row={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">
          A price-change warning fires only after the price held steady (3 charges in a row, or the
          previous year for yearly bills) and then changed — variable-priced subscriptions never
          warn. Mark or unmark merchants as recurring on the Merchants page.
        </p>
      </Card>
    </div>
  )
}
