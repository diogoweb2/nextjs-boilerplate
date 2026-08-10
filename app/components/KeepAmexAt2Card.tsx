'use client'

import { Card } from '@/app/components/AppShell'
import { formatCurrency } from '@/app/lib/format'
import {
  ROGERS_ANNUAL_CAP,
  ROGERS_DOMESTIC_BASE_RATE,
  ROGERS_DOMESTIC_BONUS_RATE,
  COBALT_FEE_MONTHLY,
} from '@/app/lib/amex-cobalt-core'
import { KEEP_AMEX_CLOSE_BAND, type KeepAmexComparison } from '@/app/lib/keep-amex'

const VERDICT_META = {
  keep: {
    label: 'Keep the Amex',
    emoji: '✅',
    color: 'var(--positive)',
    bg: 'color-mix(in srgb, var(--positive) 12%, transparent)',
  },
  close: {
    label: 'Close enough to keep it',
    emoji: '🤔',
    color: 'var(--warning)',
    bg: 'color-mix(in srgb, var(--warning) 14%, transparent)',
  },
  cancel: {
    label: 'Too expensive to keep',
    emoji: '⚠️',
    color: 'var(--negative)',
    bg: 'color-mix(in srgb, var(--negative) 12%, transparent)',
  },
} as const

/**
 * "Keep Amex, but switch to 2%?" (§27).
 *
 * A Fido line is not an all-or-nothing move: it lifts the Rogers card to 2%
 * whether or not the Cobalt stays in the wallet. So there are three futures,
 * not two — today, keep-both-at-2%, and all-Rogers-at-2% — and the only number
 * that decides the Cobalt's fate is the gap between the last two.
 *
 * Both paths are measured as an annual delta against today (two Koodo lines,
 * Rogers at 1.5%, Cobalt kept), so their difference is exactly what the Cobalt
 * costs to keep once the Fido line exists.
 */
export function KeepAmexAt2Card({
  cmp,
  spendOnRogersCard,
  spendOnAllCards,
  monthsOfData,
}: {
  cmp: KeepAmexComparison
  /** Avg monthly non-phone domestic spend on the Rogers card today. */
  spendOnRogersCard: number
  /** Same across both cards — what Rogers would see with Cobalt gone. */
  spendOnAllCards: number
  monthsOfData: number
}) {
  const v = VERDICT_META[cmp.verdict]
  const cost = cmp.costOfKeepingAmex
  const amexSpend = Math.max(0, spendOnAllCards - spendOnRogersCard)
  // The whole question in one line: what the Cobalt costs vs. what it charges.
  const costVsFee = cost / (COBALT_FEE_MONTHLY * 12)

  return (
    <Card
      title="Keep Amex, but switch to 2%?"
      action={
        <span className="text-xs text-[var(--muted)]">the Fido line doesn&apos;t require cancelling</span>
      }
    >
      <p className="mb-4 text-sm text-[var(--muted)]">
        A Fido line makes you a qualifying customer, and that lifts the Rogers card to{' '}
        {(ROGERS_DOMESTIC_BONUS_RATE * 100).toFixed(1)}% on <em>everything</em> —{' '}
        <strong>whether or not you cancel the Cobalt</strong>. So this compares the two futures that
        both have the Fido line: keep both cards, or go all-Rogers. Everything below is measured
        against today — two Koodo lines, Rogers at{' '}
        {(ROGERS_DOMESTIC_BASE_RATE * 100).toFixed(1)}%, Cobalt kept — using the plan prices you typed
        above.
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
              {cost < 0 ? (
                <>
                  Keeping the Cobalt is <strong>ahead</strong> of going all-Rogers, even with both at
                  2%. Get the Fido line and keep the card.
                </>
              ) : (
                <>
                  Keeping the Cobalt costs <strong>{formatCurrency(cost)}/yr</strong> versus moving
                  everything to Rogers — {formatCurrency(cost / 12)}/mo, or{' '}
                  {costVsFee < 0.05 ? 'next to nothing' : `${costVsFee.toFixed(1)}× its own annual fee`}.
                </>
              )}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div
            className="font-display text-2xl font-bold tabular-nums tracking-tight"
            style={{ color: v.color }}
          >
            {cost >= 0 ? '−' : '+'}
            {formatCurrency(Math.abs(cost))}/yr
          </div>
          <div className="text-xs text-[var(--muted)]">price of keeping the Cobalt</div>
        </div>
      </div>

      {/* The three futures, side by side. */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Path
          title="Today"
          subtitle="Koodo, Rogers at 1.5%, Cobalt kept"
          amount={0}
          muted
        />
        <Path
          title="Keep Amex + Fido"
          subtitle={`2% on the ${formatCurrency(spendOnRogersCard)}/mo already on Rogers`}
          amount={cmp.keepAnnual}
        />
        <Path
          title="Cancel Amex + Fido"
          subtitle={`2% on all ${formatCurrency(spendOnAllCards)}/mo`}
          amount={cmp.cancelAnnual}
        />
      </div>

      <div className="mt-3 flex flex-col gap-2 rounded-lg bg-[var(--surface-2)] p-3 text-xs text-[var(--muted)]">
        <p>
          <strong className="text-[var(--foreground)]">Why there&apos;s a gap at all:</strong> keeping
          the Cobalt leaves {formatCurrency(amexSpend)}/mo of spend on the Amex, where it earns points
          instead of {(ROGERS_DOMESTIC_BONUS_RATE * 100).toFixed(1)}% cash back — and you still pay the{' '}
          {formatCurrency(COBALT_FEE_MONTHLY)}/mo fee. The Fido line itself is worth the same either
          way, so it cancels out of this comparison entirely. Based on your last {monthsOfData}{' '}
          {monthsOfData === 1 ? 'month' : 'months'} of non-phone CAD purchases.
        </p>
        <p>
          <strong className="text-[var(--foreground)]">The 2% is capped</strong> at the first{' '}
          {formatCurrency(ROGERS_ANNUAL_CAP)} of account spend per year; past that everything drops to{' '}
          {(ROGERS_DOMESTIC_BASE_RATE * 100).toFixed(1)}%.{' '}
          {cmp.cancelHitsCap ? (
            cmp.keepHitsCap ? (
              <span className="text-[var(--warning)]">
                Both paths run past it ({formatCurrency(cmp.keepCardSpendAnnual)}/yr keeping the Amex,{' '}
                {formatCurrency(cmp.cancelCardSpendAnnual)}/yr without), so part of the spend earns
                only the base rate either way. ⚠
              </span>
            ) : (
              <span className="text-[var(--warning)]">
                Keeping the Amex stays under it ({formatCurrency(cmp.keepCardSpendAnnual)}/yr), but
                cancelling pushes {formatCurrency(cmp.spendPushedPastCap)}/yr past the line, where it
                earns {(ROGERS_DOMESTIC_BASE_RATE * 100).toFixed(1)}% instead of{' '}
                {(ROGERS_DOMESTIC_BONUS_RATE * 100).toFixed(1)}% — that shrinks the case for
                cancelling. ⚠
              </span>
            )
          ) : (
            <span className="text-[var(--positive)]">
              Neither path gets near it — {formatCurrency(cmp.cancelCardSpendAnnual)}/yr at most, with{' '}
              {formatCurrency(ROGERS_ANNUAL_CAP - cmp.cancelCardSpendAnnual)} of headroom. ✓
            </span>
          )}
        </p>
        {cmp.verdict === 'close' && (
          <p>
            <strong className="text-[var(--foreground)]">Under {formatCurrency(KEEP_AMEX_CLOSE_BAND)}/yr</strong>{' '}
            is inside the band where the Cobalt&apos;s non-cash perks (transferable points rather than
            cash back, travel insurance, Amex Offers) plausibly cover the difference — this is the
            &ldquo;keep it&rdquo; answer you were looking for.
          </p>
        )}
        <p>
          Drag the point-value slider above: the gap moves with it, since every point the Cobalt earns
          is priced at that assumption.
        </p>
      </div>
    </Card>
  )
}

function Path({
  title,
  subtitle,
  amount,
  muted,
}: {
  title: string
  subtitle: string
  amount: number
  muted?: boolean
}) {
  const color = muted
    ? 'var(--muted)'
    : amount >= 0
      ? 'var(--positive)'
      : 'var(--negative)'
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-[var(--surface-2)] p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{title}</div>
      <div className="font-display text-lg font-bold tabular-nums tracking-tight" style={{ color }}>
        {muted ? 'baseline' : `${amount >= 0 ? '+' : ''}${formatCurrency(amount)}/yr`}
      </div>
      <div className="text-xs text-[var(--muted)]">{subtitle}</div>
    </div>
  )
}
