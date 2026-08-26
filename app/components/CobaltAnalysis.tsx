'use client'

import { useMemo, useState } from 'react'
import { Card, EmptyHint } from '@/app/components/AppShell'
import { formatCurrency, formatMonth } from '@/app/lib/format'
import {
  DEFAULT_CENTS_PER_POINT,
  COBALT_FEE_MONTHLY,
  ROGERS_DOMESTIC_BASE_RATE,
  ROGERS_DOMESTIC_BONUS_RATE,
  ROGERS_FOREIGN_NET_RATE,
  ROGERS_ANNUAL_CAP,
  ROGERS_FOREIGN_NET_RATE_POST_CAP,
  valueFromPoints,
  cashbackFromSpend,
  rogersRates,
  compareCards,
  type CobaltPointsData,
  type RogersSpendData,
  type RogersSpendByPerson,
} from '@/app/lib/amex-cobalt-core'
import { FidoSwitchCard } from '@/app/components/FidoSwitchCard'
import type { SpendMatrixView } from '@/app/components/TwoRogersCardsCard'

const VERDICT_META = {
  cobalt: {
    label: 'Keep Cobalt',
    emoji: '✅',
    color: 'var(--positive)',
    bg: 'color-mix(in srgb, var(--positive) 12%, transparent)',
    blurb: 'Cobalt earns meaningfully more than Rogers would on the same spend, even after the fee.',
  },
  close: {
    label: 'Close call',
    emoji: '🤔',
    color: 'var(--warning)',
    bg: 'color-mix(in srgb, var(--warning) 14%, transparent)',
    blurb: 'The two cards land close together — the answer depends on how you value a point.',
  },
  rogers: {
    label: 'Switch to Rogers',
    emoji: '⚠️',
    color: 'var(--negative)',
    bg: 'color-mix(in srgb, var(--negative) 12%, transparent)',
    blurb: 'The free Rogers World Elite would out-earn Cobalt once its $15.99/mo fee is paid.',
  },
} as const

export function CobaltAnalysis({
  points,
  pointsOnCard,
  rogersSpend,
  rogersCardSpend,
  switchBasis,
  twoCards,
}: {
  points: CobaltPointsData
  /** The same buckets, but only for purchases actually on the Amex — the tier
   *  chart reads the real card, while `points` drives the all-card showdown. */
  pointsOnCard: CobaltPointsData
  rogersSpend: RogersSpendData
  /** Spend actually on the Rogers Mastercard — the real-card half of §-tiers. */
  rogersCardSpend: RogersSpendData
  /** Real avg monthly non-phone domestic spend, by card — feeds the Fido calculator. */
  switchBasis: { monthsOfData: number; onRogersCard: number; onAllCards: number }
  /** Per-cardholder spend for the §26 "two Rogers cards" scenario. */
  twoCards: { byPerson: RogersSpendByPerson; matrix: SpendMatrixView; selfName: string; partnerName: string }
}) {
  const [cpp, setCpp] = useState(DEFAULT_CENTS_PER_POINT)
  const [hasQualifyingService, setHasQualifyingService] = useState(false)
  // Owned here, not in FidoSwitchCard, because §25 and its two sibling scenario
  // cards (§26, §27) all price off the same quoted plan.
  const [fidoQuotedPrice, setFidoQuotedPrice] = useState(30)
  const [switchBothLines, setSwitchBothLines] = useState(false)

  const analysis = useMemo(() => valueFromPoints(points, cpp, COBALT_FEE_MONTHLY), [points, cpp])
  const onCard = useMemo(
    () => valueFromPoints(pointsOnCard, cpp, COBALT_FEE_MONTHLY),
    [pointsOnCard, cpp],
  )
  const rogers = useMemo(
    () => cashbackFromSpend(rogersSpend, rogersRates({ qualifying: hasQualifyingService })),
    [rogersSpend, hasQualifyingService],
  )
  const showdown = useMemo(() => compareCards(analysis, rogers), [analysis, rogers])
  // Rogers priced at the *base* (no-qualifying-service) rate. The Fido card
  // computes the qualifying-rate lift itself from its own spend input, so the
  // "cancel Cobalt" delta it receives must exclude that lift — otherwise the
  // same 0.5pp would be counted on both sides of its combined total.
  const rogersAtBaseRate = useMemo(
    () => cashbackFromSpend(rogersSpend, rogersRates({ qualifying: false })),
    [rogersSpend],
  )

  // The Mastercard as it is actually used, priced at the same rates as the
  // comparison below so the toggles there move both consistently.
  const rogersCard = useMemo(
    () => cashbackFromSpend(rogersCardSpend, rogersRates({ qualifying: hasQualifyingService })),
    [rogersCardSpend, hasQualifyingService],
  )

  if (points.monthsOfData === 0) {
    return (
      <Card title="Amex Cobalt: worth it?">
        <EmptyHint>Import some statements first — this needs real spend to size up the card.</EmptyHint>
      </Card>
    )
  }

  const v = VERDICT_META[showdown.verdict]
  const rogersMonths = Math.max(1, rogersCardSpend.monthsOfData)
  const annualize = (v: number) => (v / rogersMonths) * 12
  const rogersDomesticRate = hasQualifyingService ? ROGERS_DOMESTIC_BONUS_RATE : ROGERS_DOMESTIC_BASE_RATE
  // Bands are shown at the headline rates; the cap is a whole-card effect, so it
  // lives in the totals rather than in a band.
  const rogersCardBands = [
    {
      label: `Canadian purchases (${(rogersDomesticRate * 100).toFixed(1)}%)`,
      color: '#3b82f6',
      annualSpend: annualize(rogersCardSpend.domesticSpend),
      annualValue: annualize(rogersCardSpend.domesticSpend * rogersDomesticRate),
    },
    {
      label: `Foreign purchases (${(ROGERS_FOREIGN_NET_RATE * 100).toFixed(1)}% after FX fee)`,
      color: '#f59e0b',
      annualSpend: annualize(rogersCardSpend.foreignSpend),
      annualValue: annualize(rogersCardSpend.foreignSpend * ROGERS_FOREIGN_NET_RATE),
    },
  ]
  const rogersCardAnnualSpend = annualize(rogersCardSpend.domesticSpend + rogersCardSpend.foreignSpend)
  // One scale across both panels, so the bars compare card to card.
  const maxRewardValue = Math.max(
    1,
    ...onCard.tiers.map((t) => (t.valueDollars / Math.max(1, pointsOnCard.monthsOfData)) * 12),
    ...rogersCardBands.map((b) => b.annualValue),
  )
  const rogersByMonth = new Map(rogers.monthly.map((m) => [m.ym, m]))
  const monthlyDelta = analysis.monthly.map((m) => ({
    ym: m.ym,
    cobaltNet: m.net,
    rogersCashback: rogersByMonth.get(m.ym)?.cashback ?? 0,
    delta: m.net - (rogersByMonth.get(m.ym)?.cashback ?? 0),
  }))
  const maxDeltaAbs = Math.max(1, ...monthlyDelta.map((m) => Math.abs(m.delta)))

  return (
    <div className="flex flex-col gap-5">
      {/* Verdict */}
      <Card title="Verdict">
        <div
          key={showdown.verdict}
          className="animate-pop flex flex-col gap-3 rounded-xl p-4 sm:flex-row sm:items-center sm:justify-between"
          style={{ background: v.bg }}
        >
          <div className="flex items-center gap-3">
            <span className="text-3xl" aria-hidden="true">{v.emoji}</span>
            <div>
              <div className="text-lg font-bold tracking-tight" style={{ color: v.color }}>
                {v.label}
              </div>
              <div className="text-sm text-[var(--muted)]">{v.blurb}</div>
            </div>
          </div>
          <div className="text-right">
            <div
              className="font-display text-2xl font-bold tabular-nums tracking-tight"
              style={{ color: v.color }}
            >
              {showdown.advantage >= 0 ? '+' : ''}
              {formatCurrency(showdown.advantage)}
            </div>
            <div className="text-xs text-[var(--muted)]">Cobalt advantage / year</div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Cobalt net / yr" value={formatCurrency(analysis.netAnnualValue)} />
          <Stat label="Rogers cash back / yr" value={formatCurrency(rogers.annualizedCashback)} />
          <Stat
            label="Break-even spend"
            value={
              Number.isFinite(analysis.breakEvenMonthlySpend)
                ? `${formatCurrency(analysis.breakEvenMonthlySpend)}/mo`
                : '—'
            }
          />
          <Stat label="Based on" value={`${analysis.monthsOfData} mo of data`} />
        </div>
      </Card>

      {/* Point value assumption */}
      <Card
        title="How much is a point worth?"
        action={<span className="text-xs text-[var(--muted)]">drag to see the verdict change</span>}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[var(--muted)]">Membership Rewards point value</span>
            <span className="font-semibold tabular-nums">{cpp.toFixed(2)}¢ / point</span>
          </div>
          <input
            type="range"
            min={0.5}
            max={1.5}
            step={0.05}
            value={cpp}
            onChange={(e) => setCpp(Number(e.target.value))}
            className="w-full accent-[var(--accent)]"
            aria-label="Membership Rewards point value in cents"
          />
          <div className="flex justify-between text-[10px] text-[var(--muted)]">
            <span>0.5¢ (statement credit)</span>
            <span>1.0¢ (typical travel redemption)</span>
            <span>1.5¢ (best-case transfer)</span>
          </div>
        </div>
      </Card>

      {/* Rogers cash-back assumptions */}
      <Card
        title="Rogers cash-back assumptions"
        action={<span className="text-xs text-[var(--muted)]">per the card&apos;s real terms, not a merchant bonus</span>}
      >
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={hasQualifyingService}
              onChange={(e) => setHasQualifyingService(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
            />
            <span>
              Have ≥1 qualifying Rogers/Fido/Shaw/Comwave service —{' '}
              <strong>{(ROGERS_DOMESTIC_BONUS_RATE * 100).toFixed(1)}%</strong> cash back on{' '}
              <em>everything</em> instead of {(ROGERS_DOMESTIC_BASE_RATE * 100).toFixed(1)}%. This is a
              whole-card rate upgrade, not a bonus limited to the qualifying bill itself.
            </span>
          </label>
          <div className="rounded-lg bg-[var(--surface-2)] p-3 text-xs text-[var(--muted)]">
            <strong className="text-[var(--foreground)]">No redemption bonus.</strong> Rogers used to
            pay 1.5x when cash back was applied to a Rogers/Fido/Shaw/Comwave bill. That is gone —
            cash back is now worth face value however you redeem it, so the qualifying-service rate
            lift above is the only thing being a Rogers customer buys you.
          </div>

          <div className="rounded-lg bg-[var(--surface-2)] p-3 text-xs text-[var(--muted)]">
            <strong className="text-[var(--foreground)]">Annual cap:</strong> the elevated rates only
            run on the first {formatCurrency(ROGERS_ANNUAL_CAP)} of account spend per year; past that
            everything drops to {(ROGERS_DOMESTIC_BASE_RATE * 100).toFixed(1)}% until the reset date.
            Foreign spend past the cap goes <strong>net negative</strong> (
            {(ROGERS_FOREIGN_NET_RATE_POST_CAP * 100).toFixed(1)}%) — the 2.5% FX fee outlives the 3%
            offer. Modelled month by month in calendar order, so the month that crosses the line is
            split pro rata.
            <div className="mt-2">
              You&apos;re tracking{' '}
              <strong className="text-[var(--foreground)]">
                {formatCurrency(rogers.annualizedSpend)}/yr
              </strong>{' '}
              on the card —{' '}
              {rogers.hitsAnnualCap ? (
                <span className="text-[var(--warning)]">
                  over the cap, costing {formatCurrency(rogers.capCostAnnual)}/yr in lost cash back ⚠
                </span>
              ) : (
                <span className="text-[var(--positive)]">
                  {formatCurrency(ROGERS_ANNUAL_CAP - rogers.annualizedSpend)} of headroom left ✓
                </span>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Tier breakdown, one panel per real card */}
      <Card
        title="Where the rewards come from"
        action={<span className="text-xs text-[var(--muted)]">what each card actually earns today</span>}
      >
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Amex — tiered, so it gets the multiplier bars */}
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold">Amex Cobalt</h3>
              <span className="text-xs tabular-nums text-[var(--muted)]">
                {formatCurrency(onCard.annualizedSpend)}/yr spend
              </span>
            </div>
            <ul className="flex flex-col gap-3">
              {onCard.tiers.map((t) => {
                const annualSpend = (t.spend / Math.max(1, pointsOnCard.monthsOfData)) * 12
                const annualValue = (t.valueDollars / Math.max(1, pointsOnCard.monthsOfData)) * 12
                return (
                  <li key={t.tier} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="flex items-center gap-2 font-medium">
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: t.color }}
                        />
                        {t.label}
                      </span>
                      <span className="shrink-0 tabular-nums text-[var(--muted)]">
                        {formatCurrency(annualSpend)}/yr
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${(annualValue / maxRewardValue) * 100}%`, background: t.color }}
                        />
                      </div>
                      <span className="w-24 shrink-0 text-right text-xs font-semibold tabular-nums">
                        {formatCurrency(annualValue)}/yr
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
            <div className="flex items-baseline justify-between border-t border-[var(--border)] pt-2 text-sm">
              <span className="font-medium">Points earned</span>
              <span className="font-semibold tabular-nums">
                {formatCurrency(onCard.annualizedPointsValue)}/yr
              </span>
            </div>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-[var(--muted)]">Less membership fee</span>
              <span className="tabular-nums text-[var(--negative)]">
                −{formatCurrency(onCard.annualFee)}/yr
              </span>
            </div>
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium">Net</span>
              <span
                className="font-semibold tabular-nums"
                style={{ color: onCard.netAnnualValue >= 0 ? 'var(--positive)' : 'var(--negative)' }}
              >
                {onCard.netAnnualValue >= 0 ? '+' : ''}
                {formatCurrency(onCard.netAnnualValue)}/yr
              </span>
            </div>
          </div>

          {/* Rogers — one flat rate, so the only split that means anything is
              domestic vs foreign (the FX fee eats most of the foreign rate). */}
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold">Rogers Mastercard</h3>
              <span className="text-xs tabular-nums text-[var(--muted)]">
                {formatCurrency(rogersCardAnnualSpend)}/yr spend
              </span>
            </div>
            <ul className="flex flex-col gap-3">
              {rogersCardBands.map((b) => (
                <li key={b.label} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2 font-medium">
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: b.color }}
                      />
                      {b.label}
                    </span>
                    <span className="shrink-0 tabular-nums text-[var(--muted)]">
                      {formatCurrency(b.annualSpend)}/yr
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${(Math.max(0, b.annualValue) / maxRewardValue) * 100}%`,
                          background: b.color,
                        }}
                      />
                    </div>
                    <span className="w-24 shrink-0 text-right text-xs font-semibold tabular-nums">
                      {formatCurrency(b.annualValue)}/yr
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex items-baseline justify-between border-t border-[var(--border)] pt-2 text-sm">
              <span className="font-medium">Cash back earned</span>
              <span className="font-semibold tabular-nums">
                {formatCurrency(rogersCard.annualizedCashback)}/yr
              </span>
            </div>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-[var(--muted)]">Less annual fee</span>
              <span className="tabular-nums text-[var(--muted)]">−{formatCurrency(0)}/yr</span>
            </div>
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium">Net</span>
              <span className="font-semibold tabular-nums text-[var(--positive)]">
                +{formatCurrency(rogersCard.annualizedCashback)}/yr
              </span>
            </div>
          </div>
        </div>

        <p className="mt-4 text-xs text-[var(--muted)]">
          Both panels are the cards as they are used today, over the last{' '}
          {pointsOnCard.monthsOfData} months — not the &ldquo;what if it all moved&rdquo; scenario
          the comparison below runs. Rogers is priced at the same rates as that comparison, so the
          toggles under it move these numbers too.
        </p>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Groceries matches Metro, Freshco and Food Basics, plus any charge relabelled
          &ldquo;gift card&rdquo; — on this ledger those are always bought at the supermarket
          register. A plain amazon.ca order earns 1x. Streaming only counts recognized streaming
          services inside the Subscriptions category (phone/internet bills don&apos;t get the
          multiplier). Gas/transit/rideshare matches known gas stations, Presto/transit and
          Uber/Lyft.
        </p>
      </Card>

      {/* Rogers comparison */}
      <Card
        title="Cobalt vs Rogers World Elite"
        action={<span className="text-xs text-[var(--muted)]">Rogers has no annual fee</span>}
      >
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-[var(--surface-2)] p-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Rogers Mastercard World Elite
            </div>
            <div className="text-sm text-[var(--foreground)]">
              {((hasQualifyingService ? ROGERS_DOMESTIC_BONUS_RATE : ROGERS_DOMESTIC_BASE_RATE) * 100).toFixed(1)}%
              back on {formatCurrency(rogers.domesticSpend)}/yr domestic spend
              {hasQualifyingService ? ' (qualifying-service rate)' : ''}, {(ROGERS_FOREIGN_NET_RATE * 100).toFixed(1)}%
              net on {formatCurrency(rogers.foreignSpend)}/yr foreign-currency spend (3% back minus Canada&apos;s
              2.5% FX fee). No monthly fee.
            </div>
          </div>
          <div className="rounded-lg bg-[var(--surface-2)] p-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Amex Cobalt
            </div>
            <div className="text-sm text-[var(--foreground)]">
              {formatCurrency(analysis.annualizedPointsValue)}/yr in points at {cpp.toFixed(2)}¢/point, minus{' '}
              {formatCurrency(analysis.annualFee)}/yr membership fee.
            </div>
          </div>
        </div>

        <div className="flex items-end gap-2 overflow-x-auto pb-1">
          {monthlyDelta.map((m) => {
            const heightPct = Math.max(4, (Math.abs(m.delta) / maxDeltaAbs) * 100)
            return (
              <div key={m.ym} className="flex min-w-[36px] flex-1 flex-col items-center gap-1">
                <span className="text-[10px] tabular-nums text-[var(--muted)]">
                  {m.delta >= 0 ? '+' : ''}
                  {formatCurrency(m.delta)}
                </span>
                <div className="flex h-28 w-full items-end justify-center">
                  <div
                    className={`w-full max-w-[22px] rounded-t-sm transition-all ${
                      m.delta >= 0 ? 'bg-[var(--positive)]' : 'bg-[var(--negative)]'
                    }`}
                    style={{ height: `${heightPct}%`, opacity: 0.85 }}
                    title={`${formatMonth(m.ym)}: Cobalt ${formatCurrency(m.cobaltNet)} vs Rogers ${formatCurrency(m.rogersCashback)}`}
                  />
                </div>
                <span className="text-[9px] text-[var(--muted)]">{m.ym.slice(5)}</span>
              </div>
            )
          })}
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">
          Positive bars = Cobalt would&apos;ve out-earned Rogers that month (after its fee); negative
          bars = Rogers&apos; free flat-rate cash back would&apos;ve won. Foreign-currency detection only
          works for card exports that include a merchant country code (Master-format cards); Amex and
          bank rows are assumed domestic.
        </p>
      </Card>

      {/* Switch a Koodo line to Fido? — a Fido line IS the qualifying service,
          so that card always prices the post-switch side at the 2% rate,
          independent of the "today's state" checkbox above. */}
      <FidoSwitchCard
        spendOnRogersCard={switchBasis.onRogersCard}
        spendOnAllCards={switchBasis.onAllCards}
        monthsOfData={switchBasis.monthsOfData}
        cobaltCancelAnnualDelta={rogersAtBaseRate.annualizedCashback - analysis.netAnnualValue}
        twoCards={twoCards}
        fidoQuotedPrice={fidoQuotedPrice}
        setFidoQuotedPrice={setFidoQuotedPrice}
        switchBothLines={switchBothLines}
        setSwitchBothLines={setSwitchBothLines}
      />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-[var(--surface-2)] p-2.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">{label}</span>
      <span className="text-sm font-bold tabular-nums">{value}</span>
    </div>
  )
}
