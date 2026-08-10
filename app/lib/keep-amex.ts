// "Keep Amex, but switch to 2%" — §27.
//
// The question §25 answers is "is a Fido line worth it?", and the one §24
// answers is "Cobalt or Rogers?". Neither answers the one the owner actually
// asked: **if I get the Fido line but keep the Cobalt anyway, how much is that
// costing me?** A Fido line is not exclusive to cancelling Amex — it lifts the
// Rogers card to 2% whatever else is in the wallet — so "keep Amex at 2%" is a
// real third option sitting between today and going all-Rogers.
//
// Both scenarios are measured as an annual delta **against today** (two Koodo
// lines, Rogers at the 1.5% base rate, Cobalt kept), so the difference between
// them is exactly the price of keeping the Cobalt.

import { computeFidoSwitch, type FidoScenario, type FidoSwitchInput } from '@/app/lib/fido-switch'
import { ROGERS_ANNUAL_CAP } from '@/app/lib/amex-cobalt-core'

/** Annual gap below which keeping the Cobalt is a wash worth paying for the
 *  card's other perks (insurance, Amex Offers, the points being *flexible*
 *  rather than cash). Matches §26's ±$120/yr band — $10/mo. */
export const KEEP_AMEX_CLOSE_BAND = 120

export type KeepAmexComparison = {
  /** Get the Fido line, keep the Cobalt. Only the spend already on the Rogers
   *  card gets lifted to 2%; the Amex spend stays on the Amex. */
  keepAmex: FidoScenario
  /** Get the Fido line **and** cancel the Cobalt, so all spend lands on Rogers
   *  at 2%. `annualDelta` here excludes the Cobalt swing — see `cancelAnnual`. */
  cancelAmex: FidoScenario
  /** Annual delta vs. today for the keep-Amex path. */
  keepAnnual: number
  /** Annual delta vs. today for the cancel-Amex path, Cobalt swing included. */
  cancelAnnual: number
  /**
   * `cancelAnnual − keepAnnual`: what keeping the Cobalt costs per year once
   * both paths have the Fido line. Positive = cancelling is ahead by this much;
   * negative = the Cobalt is still earning its fee even at 2%.
   */
  costOfKeepingAmex: number
  /** Annual spend that would run through the Rogers card in each path — the
   *  figure the $61,000 cap bites on. Keeping the Amex keeps this smaller,
   *  which is a real (if backhanded) point in the keep column. */
  keepCardSpendAnnual: number
  cancelCardSpendAnnual: number
  /** True when that path's spend runs past the cap, so part of it earns only
   *  1.5% and the 2% lift is worth less than the headline suggests. */
  keepHitsCap: boolean
  cancelHitsCap: boolean
  /** Annualized spend that *only* the cancel path pushes past the cap — the
   *  slice that would earn 1.5% instead of 2% purely because the Amex spend
   *  moved over. 0 when even the combined total stays under. */
  spendPushedPastCap: number
  verdict: 'keep' | 'close' | 'cancel'
}

export type KeepAmexInput = Omit<FidoSwitchInput, 'otherRogersSpend'> & {
  /** Avg monthly non-phone domestic spend already on the Rogers card — the base
   *  the 2% lift applies to while the Cobalt stays in the wallet. */
  spendOnRogersCard: number
  /** Same across both credit cards — what reaches Rogers once Cobalt is gone. */
  spendOnAllCards: number
  /**
   * Annual gain from moving Cobalt's spend onto Rogers at the **base** 1.5%
   * rate (Rogers cash back minus Cobalt's net value). Base rate, not 2%: the
   * 0.5pp lift on that same spend is already inside `cancelAmex.annualDelta`,
   * which prices the switch against `spendOnAllCards`. Counting it in both
   * would double it — the same trap as §25 correction 3.
   */
  cobaltCancelAnnualDelta: number
}

export function compareKeepAmex(input: KeepAmexInput): KeepAmexComparison {
  const { spendOnRogersCard, spendOnAllCards, cobaltCancelAnnualDelta, ...base } = input
  const annualCap = base.annualCap ?? ROGERS_ANNUAL_CAP

  const keepAmex = computeFidoSwitch({ ...base, otherRogersSpend: spendOnRogersCard })
  const cancelAmex = computeFidoSwitch({ ...base, otherRogersSpend: spendOnAllCards })

  const keepAnnual = keepAmex.annualDelta
  const cancelAnnual = cancelAmex.annualDelta + cobaltCancelAnnualDelta

  // Phone bills ride the card too, so they count toward the cap.
  const phoneAfter =
    keepAmex.linesOnFido === 2
      ? base.fidoQuotedPrice * 2
      : base.remainingKoodoLinePrice + base.fidoQuotedPrice
  const keepCardSpendAnnual = (spendOnRogersCard + phoneAfter) * 12
  const cancelCardSpendAnnual = (spendOnAllCards + phoneAfter) * 12

  const costOfKeepingAmex = cancelAnnual - keepAnnual
  const verdict: KeepAmexComparison['verdict'] =
    costOfKeepingAmex < 0 ? 'keep' : costOfKeepingAmex <= KEEP_AMEX_CLOSE_BAND ? 'close' : 'cancel'

  return {
    keepAmex,
    cancelAmex,
    keepAnnual,
    cancelAnnual,
    costOfKeepingAmex,
    keepCardSpendAnnual,
    cancelCardSpendAnnual,
    keepHitsCap: keepCardSpendAnnual > annualCap,
    cancelHitsCap: cancelCardSpendAnnual > annualCap,
    spendPushedPastCap:
      Math.max(0, cancelCardSpendAnnual - annualCap) - Math.max(0, keepCardSpendAnnual - annualCap),
    verdict,
  }
}
