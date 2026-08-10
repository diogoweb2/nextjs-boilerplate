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
  ROGERS_REDEMPTION_BONUS,
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
  rogersSpend,
  switchBasis,
  twoCards,
}: {
  points: CobaltPointsData
  rogersSpend: RogersSpendData
  /** Real avg monthly non-phone domestic spend, by card — feeds the Fido calculator. */
  switchBasis: { monthsOfData: number; onRogersCard: number; onAllCards: number }
  /** Per-cardholder spend for the §26 "two Rogers cards" scenario. */
  twoCards: { byPerson: RogersSpendByPerson; matrix: SpendMatrixView; selfName: string; partnerName: string }
}) {
  const [cpp, setCpp] = useState(DEFAULT_CENTS_PER_POINT)
  const [hasQualifyingService, setHasQualifyingService] = useState(false)
  const [redeemTowardBill, setRedeemTowardBill] = useState(false)
  const analysis = useMemo(() => valueFromPoints(points, cpp, COBALT_FEE_MONTHLY), [points, cpp])
  const rogers = useMemo(
    () => cashbackFromSpend(rogersSpend, rogersRates({ qualifying: hasQualifyingService, redeemTowardBill })),
    [rogersSpend, hasQualifyingService, redeemTowardBill],
  )
  const showdown = useMemo(() => compareCards(analysis, rogers), [analysis, rogers])
  // Rogers priced at the *base* (no-qualifying-service) rate. The Fido card
  // computes the qualifying-rate lift itself from its own spend input, so the
  // "cancel Cobalt" delta it receives must exclude that lift — otherwise the
  // same 0.5pp would be counted on both sides of its combined total.
  const rogersAtBaseRate = useMemo(
    () => cashbackFromSpend(rogersSpend, rogersRates({ qualifying: false, redeemTowardBill })),
    [rogersSpend, redeemTowardBill],
  )

  if (points.monthsOfData === 0) {
    return (
      <Card title="Amex Cobalt: worth it?">
        <EmptyHint>Import some statements first — this needs real spend to size up the card.</EmptyHint>
      </Card>
    )
  }

  const v = VERDICT_META[showdown.verdict]
  const maxTierValue = Math.max(1, ...analysis.tiers.map((t) => t.valueDollars))
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
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={redeemTowardBill}
              onChange={(e) => setRedeemTowardBill(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
            />
            <span>
              Redeem cash back toward the Rogers/Fido bill — a{' '}
              <strong>+{(ROGERS_REDEMPTION_BONUS * 100).toFixed(0)}%</strong> redemption bonus (vs. a plain
              statement credit), capped at what you actually owe on those bills.
            </span>
          </label>

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

      {/* Tier breakdown */}
      <Card
        title="Where the points come from"
        action={<span className="text-xs text-[var(--muted)]">annualized spend × multiplier</span>}
      >
        <ul className="flex flex-col gap-3">
          {analysis.tiers.map((t) => {
            const annualSpend = (t.spend / Math.max(1, points.monthsOfData)) * 12
            const annualValue = (t.valueDollars / Math.max(1, points.monthsOfData)) * 12
            return (
              <li key={t.tier} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.color }} />
                    {t.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-[var(--muted)]">
                    {formatCurrency(annualSpend)}/yr spend
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${(t.valueDollars / maxTierValue) * 100}%`, background: t.color }}
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
        <p className="mt-4 text-xs text-[var(--muted)]">
          Groceries assumes Metro, Freshco and Food Basics — plus every &ldquo;Amazon&rdquo; charge,
          since on this ledger that&apos;s always a gift card bought at the supermarket register, not
          an amazon.com order. Streaming only counts recognized streaming services inside the
          Subscriptions category (phone/internet bills don&apos;t get the multiplier). Gas/transit/
          rideshare matches known gas stations, Presto/transit and Uber/Lyft.
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
              2.5% FX fee)
              {redeemTowardBill
                ? `, plus a ${(ROGERS_REDEMPTION_BONUS * 100).toFixed(0)}% redemption bonus on the ${formatCurrency(rogers.familySpend)}/yr redeemed toward Rogers/Fido bills`
                : ''}
              . No monthly fee.
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
        redeemTowardBill={redeemTowardBill}
        spendOnRogersCard={switchBasis.onRogersCard}
        spendOnAllCards={switchBasis.onAllCards}
        monthsOfData={switchBasis.monthsOfData}
        cobaltCancelAnnualDelta={rogersAtBaseRate.annualizedCashback - analysis.netAnnualValue}
        twoCards={twoCards}
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
