'use client'

import { useMemo } from 'react'
import { Card } from '@/app/components/AppShell'
import { formatCurrency } from '@/app/lib/format'
import {
  ROGERS_ANNUAL_CAP,
  ROGERS_DOMESTIC_BONUS_RATE,
  ROGERS_DOMESTIC_BASE_RATE,
  CARD_SOURCE_LABEL,
  rogersRates,
  compareOneVsTwoCards,
  type RogersSpendByPerson,
  type CardSource,
  type PersonKey,
} from '@/app/lib/amex-cobalt-core'

const VERDICT_META = {
  worth: {
    label: 'Worth the second card',
    emoji: '✅',
    color: 'var(--positive)',
    bg: 'color-mix(in srgb, var(--positive) 12%, transparent)',
  },
  close: {
    label: 'Not worth the admin',
    emoji: '🤔',
    color: 'var(--warning)',
    bg: 'color-mix(in srgb, var(--warning) 14%, transparent)',
  },
  not: {
    label: 'Stick to one card',
    emoji: '⚠️',
    color: 'var(--negative)',
    bg: 'color-mix(in srgb, var(--negative) 12%, transparent)',
  },
} as const

export type SpendMatrixView = {
  monthsOfData: number
  sources: CardSource[]
  rows: { person: PersonKey; bySource: Record<string, number>; total: number }[]
  totalsBySource: Record<string, number>
  grandTotal: number
}

/**
 * "Two Rogers cards, one each?" (§26).
 *
 * The $61,000 cap is per **Account**, so two primary cardholders means two caps
 * — but that is the *only* thing a second card buys. The rate is whole-card and
 * identical on both accounts, so below one cap the two scenarios earn exactly
 * the same amount. Both sides are priced with Amex already cancelled, since the
 * scenario only makes sense once all household spend is landing on Rogers.
 */
export function TwoRogersCardsCard({
  byPerson,
  matrix,
  selfName,
  partnerName,
  redeemTowardBill,
  fidoPricePerLine,
  remainingKoodoLinePrice,
}: {
  byPerson: RogersSpendByPerson
  matrix: SpendMatrixView
  selfName: string
  partnerName: string
  redeemTowardBill: boolean
  /** From the §25 calculator — the second account needs its own Fido line. */
  fidoPricePerLine: number
  /** What the one-card scenario keeps paying Koodo for the second line. */
  remainingKoodoLinePrice: number
}) {
  // One card → 1 Fido + 1 Koodo. Two cards → 2 Fido (each Account needs its own
  // qualifying service). The marginal cost is the difference on that one line.
  const extraPlanCostMonthly = fidoPricePerLine - remainingKoodoLinePrice

  const cmp = useMemo(
    () =>
      compareOneVsTwoCards(
        byPerson,
        rogersRates({ qualifying: true, redeemTowardBill }),
        extraPlanCostMonthly,
      ),
    [byPerson, redeemTowardBill, extraPlanCostMonthly],
  )

  const v = VERDICT_META[cmp.verdict]
  const nameOf = (p: PersonKey) => (p === 'self' ? selfName : partnerName)
  const householdSpend = cmp.oneCard.annualizedSpend
  const reachesOneCap = householdSpend > ROGERS_ANNUAL_CAP

  return (
    <Card
      title="Two Rogers cards, one each?"
      action={<span className="text-xs text-[var(--muted)]">the $61k cap is per account, not per household</span>}
    >
      <p className="mb-4 text-sm text-[var(--muted)]">
        Two primary cardholders means two accounts, two caps, and up to{' '}
        {formatCurrency(ROGERS_ANNUAL_CAP * 2)}/yr at{' '}
        {(ROGERS_DOMESTIC_BONUS_RATE * 100).toFixed(1)}% instead of{' '}
        {formatCurrency(ROGERS_ANNUAL_CAP)}. Both accounts need their own qualifying service, so this
        assumes <strong>both</strong> Koodo lines move to Fido — and Amex is cancelled either way, since
        the scenario only exists once everything lands on Rogers.
      </p>

      <div
        key={cmp.verdict}
        className="animate-pop flex flex-col gap-3 rounded-xl p-4 sm:flex-row sm:items-center sm:justify-between"
        style={{ background: v.bg }}
      >
        <div className="flex items-center gap-3">
          <span className="text-3xl" aria-hidden="true">{v.emoji}</span>
          <div>
            <div className="text-lg font-bold tracking-tight" style={{ color: v.color }}>
              {v.label}
            </div>
            <div className="text-sm text-[var(--muted)]">
              {reachesOneCap ? (
                <>
                  A second cap keeps{' '}
                  <strong>{formatCurrency(cmp.spendRescuedFromCap)}/yr</strong> of spend at the elevated
                  rate that one card would drop to {(ROGERS_DOMESTIC_BASE_RATE * 100).toFixed(1)}%.
                </>
              ) : (
                <>
                  You spend {formatCurrency(householdSpend)}/yr — you never reach even{' '}
                  <strong>one</strong> {formatCurrency(ROGERS_ANNUAL_CAP)} cap, so a second one earns
                  nothing at all.
                </>
              )}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-display text-2xl font-bold tabular-nums tracking-tight" style={{ color: v.color }}>
            {cmp.netGainAnnual >= 0 ? '+' : ''}
            {formatCurrency(cmp.netGainAnnual)}/yr
          </div>
          <div className="text-xs text-[var(--muted)]">net, after the extra line</div>
        </div>
      </div>

      {/* Where the number comes from */}
      <div className="mt-3 grid grid-cols-1 gap-2 rounded-lg bg-[var(--surface-2)] p-3 text-sm sm:grid-cols-3">
        <Line label="One card" value={`${formatCurrency(cmp.oneCard.annualizedCashback)}/yr`} />
        <Line label="Two cards" value={`${formatCurrency(cmp.twoCardCashback)}/yr`} />
        <Line
          label="Extra cash back"
          value={`+${formatCurrency(cmp.cashbackGain)}/yr`}
          tone={cmp.cashbackGain > 0 ? 'positive' : undefined}
        />
        <Line
          label={`${nameOf('self')} alone`}
          value={`${formatCurrency(cmp.self.annualizedSpend)}/yr spend`}
        />
        <Line
          label={`${nameOf('partner')} alone`}
          value={`${formatCurrency(cmp.partner.annualizedSpend)}/yr spend`}
        />
        <Line
          label="Extra line cost"
          value={`${cmp.extraPlanCostAnnual >= 0 ? '−' : '+'}${formatCurrency(
            Math.abs(cmp.extraPlanCostAnnual),
          )}/yr`}
          tone={cmp.extraPlanCostAnnual > 0 ? 'negative' : 'positive'}
        />
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Extra line cost = a second Fido line at {formatCurrency(fidoPricePerLine)} replacing the{' '}
        {formatCurrency(remainingKoodoLinePrice)} Koodo line the one-card plan keeps. Both prices come
        from the calculator above. Rates are identical on both accounts, so below one cap the two
        scenarios earn <em>exactly</em> the same — every dollar of gain here is cap headroom, nothing
        else.
      </p>

      {/* Cap usage, per account */}
      <div className="mt-4 flex flex-col gap-2">
        <CapBar label={`${nameOf('self')}'s card`} spend={cmp.self.annualizedSpend} />
        <CapBar label={`${nameOf('partner')}'s card`} spend={cmp.partner.annualizedSpend} />
        <CapBar label="One shared card" spend={householdSpend} />
      </div>

      {/* Plain spend table — the "just for info" ask */}
      <div className="mt-5">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          Annualized spend by card ({matrix.monthsOfData} mo of data)
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[380px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--muted)]">
                <th className="py-1.5 text-left font-medium">Card</th>
                {matrix.rows.map((r) => (
                  <th key={r.person} className="py-1.5 text-right font-medium">
                    {nameOf(r.person)}
                  </th>
                ))}
                <th className="py-1.5 text-right font-medium">Both</th>
              </tr>
            </thead>
            <tbody>
              {matrix.sources.map((s) => (
                <tr key={s} className="border-b border-[var(--border)]">
                  <td className="py-1.5">{CARD_SOURCE_LABEL[s]}</td>
                  {matrix.rows.map((r) => (
                    <td key={r.person} className="py-1.5 text-right tabular-nums">
                      {formatCurrency(r.bySource[s] ?? 0)}
                    </td>
                  ))}
                  <td className="py-1.5 text-right font-medium tabular-nums">
                    {formatCurrency(matrix.totalsBySource[s] ?? 0)}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-1.5">Total</td>
                {matrix.rows.map((r) => (
                  <td key={r.person} className="py-1.5 text-right tabular-nums">
                    {formatCurrency(r.total)}
                  </td>
                ))}
                <td className="py-1.5 text-right tabular-nums">{formatCurrency(matrix.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Purchases only — card payments and transfers are excluded, gift-card loads included (§10c).
          Attribution is by card last-4; <strong>bank debit rows carry no last-4, so they count as{' '}
          {selfName}</strong>, which can skew the split. Phone bills are held at today&apos;s amounts:
          both scenarios have a Fido line, so the redemption bonus affects the two totals equally and
          cancels out of the difference.
        </p>
      </div>
    </Card>
  )
}

function Line({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'positive' | 'negative'
}) {
  const color =
    tone === 'positive' ? 'text-[var(--positive)]' : tone === 'negative' ? 'text-[var(--negative)]' : ''
  return (
    <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-start sm:gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${color}`}>{value}</span>
    </div>
  )
}

/** How much of one $61k cap this account actually uses. */
function CapBar({ label, spend }: { label: string; spend: number }) {
  const pct = Math.min(100, (spend / ROGERS_ANNUAL_CAP) * 100)
  const over = spend > ROGERS_ANNUAL_CAP
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-[var(--muted)]">
          {formatCurrency(spend)} / {formatCurrency(ROGERS_ANNUAL_CAP)}
          {over && <span className="text-[var(--warning)]"> — over cap ⚠</span>}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pct}%`,
            background: over ? 'var(--warning)' : 'var(--positive)',
          }}
        />
      </div>
    </div>
  )
}
