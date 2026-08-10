'use client'

import { useMemo, useState } from 'react'
import { Card } from '@/app/components/AppShell'
import { formatCurrency } from '@/app/lib/format'
import { computeFidoSwitch, DEFAULT_KOODO_TWO_LINE_TOTAL } from '@/app/lib/fido-switch'
import {
  ROGERS_DOMESTIC_BONUS_RATE,
  ROGERS_DOMESTIC_BASE_RATE,
  ROGERS_ANNUAL_CAP,
  rogersRates,
  compareOneVsTwoCards,
  type RogersSpendByPerson,
} from '@/app/lib/amex-cobalt-core'
import { TwoRogersCardsCard, type SpendMatrixView } from '@/app/components/TwoRogersCardsCard'

const INPUT_CLASS =
  'w-28 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-right text-sm tabular-nums text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]'

const VERDICT_META = {
  switch: { label: 'Switch the line', emoji: '✅', color: 'var(--positive)', bg: 'color-mix(in srgb, var(--positive) 12%, transparent)' },
  close: { label: 'Toss-up', emoji: '🤔', color: 'var(--warning)', bg: 'color-mix(in srgb, var(--warning) 14%, transparent)' },
  stay: { label: 'Stay on Koodo', emoji: '⚠️', color: 'var(--negative)', bg: 'color-mix(in srgb, var(--negative) 12%, transparent)' },
} as const

/**
 * "Switch 1 line to Fido?" — the plan price is hypothetical, but everything
 * else comes from real spend. A Fido line makes the household a qualifying
 * Rogers customer, lifting the card's rate on EVERYTHING (1.5% → 2%), so the
 * "other Rogers spend" base — derived from actual transactions, never typed —
 * is where nearly all the value is; cash back on a ~$25 phone bill is rounding
 * error next to 0.5pp of a real month's spending.
 */
export function FidoSwitchCard({
  redeemTowardBill,
  spendOnRogersCard,
  spendOnAllCards,
  monthsOfData,
  cobaltCancelAnnualDelta,
  twoCards,
  fidoQuotedPrice,
  setFidoQuotedPrice,
}: {
  redeemTowardBill: boolean
  /** Real avg monthly non-phone domestic spend already on the Rogers card. */
  spendOnRogersCard: number
  /** Same, across all cards — what would reach Rogers if Cobalt were cancelled. */
  spendOnAllCards: number
  /** Months of real data the two averages above are drawn from. */
  monthsOfData: number
  /** Annual delta from moving Cobalt's spend to Rogers at the BASE rate. The
   *  qualifying-rate slice is already inside the scenario's own numbers, so
   *  using the bonus-rate delta here would double-count it. */
  cobaltCancelAnnualDelta: number
  /** §26 data. Rendered as a sibling card from here rather than from the parent
   *  so the Fido/Koodo line prices stay in one place — §26's "extra line cost"
   *  is literally the difference between the two prices typed in below. */
  twoCards: { byPerson: RogersSpendByPerson; matrix: SpendMatrixView; selfName: string; partnerName: string }
  /** Owned by the parent: the §24 redemption bonus is capped by this same
   *  hypothetical bill, so it can't live in this component's local state. */
  fidoQuotedPrice: number
  setFidoQuotedPrice: (n: number) => void
}) {
  const [currentTwoLineTotal, setCurrentTwoLineTotal] = useState(DEFAULT_KOODO_TWO_LINE_TOTAL)
  const [remainingKoodoLinePrice, setRemainingKoodoLinePrice] = useState(DEFAULT_KOODO_TWO_LINE_TOTAL / 2)
  const [cancelCobaltToo, setCancelCobaltToo] = useState(false)
  const [secondPrimaryCard, setSecondPrimaryCard] = useState(false)

  // Not an input: the ledger already knows this. Cancelling Cobalt is the only
  // thing that changes it, because that's what moves the rest of the spend onto
  // the Rogers card. Only the three *hypothetical* plan prices are typeable.
  const otherRogersSpend = cancelCobaltToo ? spendOnAllCards : spendOnRogersCard

  const scenario = useMemo(
    () =>
      computeFidoSwitch({
        currentTwoLineTotal,
        remainingKoodoLinePrice,
        fidoQuotedPrice,
        currentRate: ROGERS_DOMESTIC_BASE_RATE,
        switchedRate: ROGERS_DOMESTIC_BONUS_RATE,
        otherRogersSpend,
        redeemTowardBill,
      }),
    [currentTwoLineTotal, remainingKoodoLinePrice, fidoQuotedPrice, otherRogersSpend, redeemTowardBill],
  )

  // §26 lives here rather than in its own card so this one calculation can both
  // drive the card below AND be folded into the combined total. Its "extra line
  // cost" is the marginal one: a one-card household pays 1 Fido + 1 Koodo, a
  // two-card household 2 Fido (each Account needs its own qualifying service).
  const twoCardCmp = useMemo(
    () =>
      compareOneVsTwoCards(
        twoCards.byPerson,
        rogersRates({ qualifying: true, redeemTowardBill }),
        fidoQuotedPrice - remainingKoodoLinePrice,
      ),
    [twoCards.byPerson, redeemTowardBill, fidoQuotedPrice, remainingKoodoLinePrice],
  )

  // A second primary card is only defined on top of the cancel-Cobalt scenario
  // (§26 prices both of its sides with everything already on Rogers), so it can
  // never contribute on its own.
  const secondCardActive = cancelCobaltToo && secondPrimaryCard

  const v = VERDICT_META[scenario.verdict]
  const combinedAnnual =
    scenario.annualDelta +
    (cancelCobaltToo ? cobaltCancelAnnualDelta : 0) +
    (secondCardActive ? twoCardCmp.netGainAnnual : 0)
  // Total that would run through the card post-switch, measured against the cap.
  const annualCardSpend = (otherRogersSpend + remainingKoodoLinePrice + fidoQuotedPrice) * 12

  const numberInput = (value: number, onChange: (n: number) => void, label: string) => (
    <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
      {label}
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        min={0}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={INPUT_CLASS}
      />
    </label>
  )

  return (
    <>
    <Card
      title="Switch 1 line to Fido?"
      action={<span className="text-xs text-[var(--muted)]">a Fido line lifts the whole card to 2%</span>}
    >
      <p className="mb-4 text-sm text-[var(--muted)]">
        Koodo&apos;s multi-line discount disappears when you drop to one line, so plug in your actual
        re-quote for the line staying behind. Not worth moving both lines, since two-line Koodo already
        beats two separate bills.
      </p>

      <div className="mb-3 flex flex-wrap gap-4">
        {numberInput(currentTwoLineTotal, setCurrentTwoLineTotal, 'Koodo today (2 lines)')}
        {numberInput(remainingKoodoLinePrice, setRemainingKoodoLinePrice, 'Koodo re-quote (1 line)')}
        {numberInput(fidoQuotedPrice, setFidoQuotedPrice, "Fido's quoted price")}
      </div>

      {/* Read-only: measured, not assumed. Only the plan prices above are guesses. */}
      <div className="mb-4 rounded-lg bg-[var(--surface-2)] p-3 text-xs text-[var(--muted)]">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-semibold text-[var(--foreground)]">
            Other spend the lift applies to: {formatCurrency(otherRogersSpend)}/mo
          </span>
          <span>
            from your last {monthsOfData} {monthsOfData === 1 ? 'month' : 'months'} —{' '}
            {cancelCobaltToo ? 'all cards combined' : 'Rogers card only'}, non-phone CAD purchases
          </span>
        </div>
        <p className="mt-1.5">
          This isn&apos;t typed in — it&apos;s measured from your statements, and it matters far more
          than the phone bill. At {formatCurrency(otherRogersSpend)}/mo the 1.5%→2% lift alone is worth{' '}
          <strong className="text-[var(--foreground)]">
            {formatCurrency(
              (Math.min(otherRogersSpend * 12, ROGERS_ANNUAL_CAP) *
                (ROGERS_DOMESTIC_BONUS_RATE - ROGERS_DOMESTIC_BASE_RATE)) /
                12,
            )}
            /mo
          </strong>
          {annualCardSpend > ROGERS_ANNUAL_CAP && (
            <>
              {' '}
              — capped, since only the first {formatCurrency(ROGERS_ANNUAL_CAP)}/yr of the{' '}
              {formatCurrency(annualCardSpend)} you&apos;d put on the card earns the elevated rate.
            </>
          )}
          {cancelCobaltToo ? '' : ' Tick “also cancel Cobalt” below to apply it to all your spend.'}
        </p>
      </div>

      <div
        key={scenario.verdict}
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
              Fido can cost up to{' '}
              <strong>
                {Number.isFinite(scenario.breakEvenPrice)
                  ? `${formatCurrency(scenario.breakEvenPrice)}/mo`
                  : 'basically anything'}
              </strong>{' '}
              and still leave you no worse off.
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-display text-2xl font-bold tabular-nums tracking-tight" style={{ color: v.color }}>
            {scenario.monthlyDelta >= 0 ? '+' : ''}
            {formatCurrency(scenario.monthlyDelta)}/mo
          </div>
          <div className="text-xs text-[var(--muted)]">{formatCurrency(scenario.annualDelta)}/yr</div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-[var(--surface-2)] p-3 text-xs">
        <span className="text-[var(--muted)]">
          Plan cost:{' '}
          <strong className={scenario.planCostDelta >= 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}>
            {scenario.planCostDelta >= 0 ? '+' : ''}
            {formatCurrency(scenario.planCostDelta)}/mo
          </strong>
        </span>
        <span className="text-[var(--muted)]">
          Extra cash back:{' '}
          <strong className="text-[var(--positive)]">+{formatCurrency(scenario.cashbackDelta)}/mo</strong>
        </span>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={cancelCobaltToo}
          onChange={(e) => setCancelCobaltToo(e.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        Also cancel Amex Cobalt — route everything through Rogers Mastercard
      </label>

      {/* Nested, and only reachable once Cobalt is cancelled: §26 prices both of
          its sides with everything already on Rogers, so a second primary card
          is not a standalone option. */}
      <label
        className={`mt-2 flex items-start gap-2 pl-6 text-sm ${
          cancelCobaltToo ? '' : 'opacity-50'
        }`}
      >
        <input
          type="checkbox"
          checked={secondPrimaryCard}
          disabled={!cancelCobaltToo}
          onChange={(e) => setSecondPrimaryCard(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
        />
        <span>
          Add a second primary Rogers card — one each, so two{' '}
          {formatCurrency(ROGERS_ANNUAL_CAP)} caps instead of one
          <span className="block text-xs text-[var(--muted)]">
            {cancelCobaltToo
              ? `Needs both Koodo lines on Fido (each account needs its own qualifying service). Worth ${
                  twoCardCmp.netGainAnnual >= 0 ? '+' : ''
                }${formatCurrency(twoCardCmp.netGainAnnual)}/yr — see the card below.`
              : 'Requires cancelling Cobalt first, so all spend runs through Rogers.'}
          </span>
        </span>
      </label>

      {cancelCobaltToo && (
        <div className="mt-2 flex flex-col gap-1.5 rounded-lg bg-[var(--surface-2)] p-3 text-sm">
          <div>
            <span className="font-semibold">Combined annual impact: </span>
            <span className={combinedAnnual >= 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}>
              {combinedAnnual >= 0 ? '+' : ''}
              {formatCurrency(combinedAnnual)}/yr
            </span>
            <span className="text-[var(--muted)]">
              {' '}
              ({formatCurrency(scenario.annualDelta)}/yr from the line switch, already including the rate
              lift on all {formatCurrency(otherRogersSpend)}/mo,{' '}
              {cobaltCancelAnnualDelta >= 0 ? '+' : '−'} {formatCurrency(Math.abs(cobaltCancelAnnualDelta))}
              /yr more from moving spend off Cobalt at the base {(ROGERS_DOMESTIC_BASE_RATE * 100).toFixed(1)}% rate
              {secondCardActive && (
                <>
                  , {twoCardCmp.netGainAnnual >= 0 ? '+' : '−'}{' '}
                  {formatCurrency(Math.abs(twoCardCmp.netGainAnnual))}/yr from the second primary card
                  — net of the extra Fido line
                </>
              )}
              )
            </span>
          </div>
          {/* The two decisions are independent — the line switch can still be a bad idea even
              when the combined total looks positive, if canceling Cobalt alone is carrying it.
              cobaltCancelAnnualDelta is deliberately the base-rate (no Fido) figure: without a
              Fido line you never become a qualifying customer, so that's the honest
              "cancel Cobalt but stay on Koodo" comparison. */}
          {scenario.annualDelta < 0 && (
            <div className="text-[var(--warning)]">
              ⚠ At this Fido price, canceling Cobalt and <strong>staying on Koodo</strong> nets{' '}
              {formatCurrency(cobaltCancelAnnualDelta)}/yr — {formatCurrency(-scenario.annualDelta)}/yr better than
              doing both. The line switch isn&apos;t worth it on its own yet.
            </div>
          )}
        </div>
      )}
    </Card>

    <TwoRogersCardsCard
      cmp={twoCardCmp}
      matrix={twoCards.matrix}
      selfName={twoCards.selfName}
      partnerName={twoCards.partnerName}
      fidoPricePerLine={fidoQuotedPrice}
      remainingKoodoLinePrice={remainingKoodoLinePrice}
      countedInCombined={secondCardActive}
    />
    </>
  )
}
