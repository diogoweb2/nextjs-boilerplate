'use client'

import { Card } from '@/app/components/AppShell'
import { formatCurrency } from '@/app/lib/format'
import {
  ROGERS_ANNUAL_CAP,
  ROGERS_DOMESTIC_BONUS_RATE,
  ROGERS_DOMESTIC_BASE_RATE,
  CARD_SOURCE_LABEL,
  type TwoCardComparison,
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
 *
 * The comparison itself is computed by `FidoSwitchCard` and passed in, because
 * the same figure feeds its "Combined annual impact" line when the owner ticks
 * "add a second primary card" — one calculation, two places showing it.
 */
export function TwoRogersCardsCard({
  cmp,
  matrix,
  selfName,
  partnerName,
  fidoPricePerLine,
  remainingKoodoLinePrice,
  bothLinesAlreadyOnFido,
}: {
  cmp: TwoCardComparison
  matrix: SpendMatrixView
  selfName: string
  partnerName: string
  /** From the §25 calculator — the second account needs its own Fido line. */
  fidoPricePerLine: number
  /** What the one-card scenario keeps paying Koodo for the second line. */
  remainingKoodoLinePrice: number
  /** True when §25 is already moving both lines — the second account then needs
   *  no extra line, so this scenario costs nothing to run. */
  bothLinesAlreadyOnFido: boolean
}) {
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

      {bothLinesAlreadyOnFido && (
        <p className="mb-3 rounded-lg bg-[var(--surface-2)] p-2.5 text-xs text-[var(--muted)]">
          ✓ You already have <strong>both</strong> lines on Fido above, so a second account needs no
          extra line — it just splits the two bills you already pay. Nothing left to cost, which is
          why the only thing left is the cap.
        </p>
      )}

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
              )}{' '}
              Worth <strong>+{formatCurrency(cmp.cashbackGain)}/yr</strong> in cash back, against{' '}
              {formatCurrency(cmp.netExtraPlanCostAnnual)}/yr for the extra Fido line the second
              account needs to stay qualifying.
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

      {/* Where the number comes from. Split into the two things a second
          account actually earns, then the one thing it costs. */}
      <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-[var(--surface-2)] p-3 text-sm sm:grid-cols-4">
        <Line label="One card" value={`${formatCurrency(cmp.oneCard.annualizedCashback)}/yr`} />
        <Line label="Two cards" value={`${formatCurrency(cmp.twoCardCashback)}/yr`} />
        <Line
          label="From the 2nd cap"
          value={`+${formatCurrency(cmp.capGainAnnual)}/yr`}
          tone={cmp.capGainAnnual > 0 ? 'positive' : undefined}
        />
        <Line label="Second card's fee" value="$0.00/yr" tone="positive" />
        <Line
          label={`${nameOf('self')} alone`}
          value={`${formatCurrency(cmp.self.annualizedSpend)}/yr spend`}
        />
        <Line
          label={`${nameOf('partner')} alone`}
          value={`${formatCurrency(cmp.partner.annualizedSpend)}/yr spend`}
        />
        <Line
          label="Extra Fido line"
          value={`${cmp.netExtraPlanCostAnnual >= 0 ? '−' : '+'}${formatCurrency(
            Math.abs(cmp.netExtraPlanCostAnnual),
          )}/yr`}
          tone={cmp.netExtraPlanCostAnnual > 0 ? 'negative' : 'positive'}
        />
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">
        <strong className="text-[var(--foreground)]">
          The second card is free — Rogers World Elite has no annual fee.
        </strong>{' '}
        {bothLinesAlreadyOnFido ? (
          <>
            And with both lines already on Fido there is no extra line to buy either, so this
            scenario is pure upside — every dollar of it cap headroom.
          </>
        ) : (
          <>
            {cmp.netGainAnnual < 0
              ? 'The negative is entirely the phone line'
              : 'The only cost here is the phone line'}
            : a second Fido line at {formatCurrency(fidoPricePerLine)} replacing the{' '}
            {formatCurrency(remainingKoodoLinePrice)} Koodo line the one-card plan keeps, i.e.{' '}
            {formatCurrency(cmp.extraPlanCostAnnual)}/yr sticker,{' '}
            {formatCurrency(cmp.netExtraPlanCostAnnual)}/yr after the cash back that spend itself
            earns. Both prices come from the calculator above — tick &ldquo;move both lines&rdquo;
            there, or drop the Fido quote to {formatCurrency(remainingKoodoLinePrice)}, and this cost
            disappears.
          </>
        )}
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
          Credit-card purchases only — Tangerine and Scotia debit activity is out of scope for this
          whole page, along with card payments and transfers; gift-card loads are included (§10c).
          Attribution is by the card last-4 on each statement row, which both importers carry; any row
          that somehow lacks one falls to {selfName}. Phone bills are held at today&apos;s amounts:
          both scenarios have a Fido line, so the 2% rate applies on both sides and cancels out of
          the difference.
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
