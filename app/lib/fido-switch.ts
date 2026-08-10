// "Switch 1 line to Fido?" — a pure what-if calculator for a hypothetical new
// plan price. Lives alongside the Amex Cobalt / Rogers model since the whole
// point is the Rogers Mastercard cash-back mechanic: a Fido line makes the
// household a "qualifying customer", which lifts the card's rate on EVERYTHING
// (1.5% → 2%), not just on the phone bill.

import {
  redemptionBonusValue,
  ROGERS_ANNUAL_CAP,
  ROGERS_DOMESTIC_BASE_RATE,
} from '@/app/lib/amex-cobalt-core'

export const DEFAULT_KOODO_TWO_LINE_TOTAL = 45.2

export type FidoScenario = {
  /** The most Fido can charge and still leave the household no worse off. */
  breakEvenPrice: number
  /** Positive = switching saves this much per month. */
  monthlyDelta: number
  annualDelta: number
  /** Cheaper/dearer phone bills alone, ignoring all cash back. */
  planCostDelta: number
  /** Extra cash back per month from the whole-card rate lift + redemption bonus. */
  cashbackDelta: number
  verdict: 'switch' | 'close' | 'stay'
}

export type FidoSwitchInput = {
  currentTwoLineTotal: number
  /**
   * Asked for explicitly (not assumed to be half the two-line total) because
   * dropping to one line usually loses Koodo's multi-line discount.
   */
  remainingKoodoLinePrice: number
  fidoQuotedPrice: number
  /** Card-wide rate today, with no qualifying service (1.5%). */
  currentRate: number
  /** Card-wide rate once a Fido line makes you a qualifying customer (2%). */
  switchedRate: number
  /** Rate everything reverts to past the annual cap (1.5%). */
  postCapRate?: number
  /** Annual spend past which the elevated rate stops. */
  annualCap?: number
  /**
   * Non-phone monthly spend that goes on the Rogers Mastercard. This is where
   * almost all the value lives — 0.5pp of a real month's spending dwarfs any
   * cash back on a ~$25 phone bill — so it defaults to the household's actual
   * Rogers-card spend rather than 0.
   */
  otherRogersSpend: number
  /** Apply the 1.5x redemption bonus on cash back put toward the Fido bill. */
  redeemTowardBill: boolean
}

/**
 * Monthly cash back earned across the phone bills + other Rogers spend at a
 * given card-wide rate. `qualifyingBill` is the Rogers-family bill available
 * to redeem against (0 today — Koodo is not a Rogers brand, so the redemption
 * bonus is itself something switching unlocks).
 */
function monthlyCashback(
  monthlySpend: number,
  rate: number,
  postCapRate: number,
  annualCap: number,
  qualifyingBill: number,
  redeem: boolean,
): number {
  // The cap is annual, so annualize, split at the cap, then come back to
  // monthly. Above the cap the elevated rate simply stops applying, which is
  // exactly what limits how much a Fido line is worth to a heavy spender.
  const annualSpend = monthlySpend * 12
  const under = Math.min(annualSpend, annualCap)
  const over = Math.max(0, annualSpend - annualCap)
  const earned = (under * rate + over * postCapRate) / 12
  // The 1.5x bonus only applies to cash back actually redeemed against a
  // qualifying bill, so it is capped by both what you earned and what you owe —
  // the latter divided by 1.5, since the bill caps the *credit*, not the
  // redemption. See `redemptionBonusValue`.
  const bonus = redeem ? redemptionBonusValue(earned, qualifyingBill) : 0
  return earned + bonus
}

/** Net monthly outlay attributable to this decision: phone bills minus all the
 *  cash back the card throws off (including on non-phone spend, since the rate
 *  on that spend is exactly what the switch changes). */
function netMonthlyCost(input: FidoSwitchInput, fidoPrice: number): number {
  const phone = input.remainingKoodoLinePrice + fidoPrice
  const cashback = monthlyCashback(
    phone + input.otherRogersSpend,
    input.switchedRate,
    input.postCapRate ?? ROGERS_DOMESTIC_BASE_RATE,
    input.annualCap ?? ROGERS_ANNUAL_CAP,
    fidoPrice,
    input.redeemTowardBill,
  )
  return phone - cashback
}

export function computeFidoSwitch(input: FidoSwitchInput): FidoScenario {
  const postCapRate = input.postCapRate ?? ROGERS_DOMESTIC_BASE_RATE
  const annualCap = input.annualCap ?? ROGERS_ANNUAL_CAP

  // Today: two Koodo lines, card-wide base rate, and no Rogers-family bill to
  // redeem against.
  const todayCashback = monthlyCashback(
    input.currentTwoLineTotal + input.otherRogersSpend,
    input.currentRate,
    postCapRate,
    annualCap,
    0,
    false,
  )
  const todayNetCost = input.currentTwoLineTotal - todayCashback

  const afterNetCost = netMonthlyCost(input, input.fidoQuotedPrice)
  const monthlyDelta = todayNetCost - afterNetCost

  const afterCashback = monthlyCashback(
    input.remainingKoodoLinePrice + input.fidoQuotedPrice + input.otherRogersSpend,
    input.switchedRate,
    postCapRate,
    annualCap,
    input.fidoQuotedPrice,
    input.redeemTowardBill,
  )

  // Break-even solved numerically: the redemption-bonus cap makes net cost a
  // piecewise-linear function of the Fido price, so bisection is both simpler
  // and more honest than a closed form that quietly ignores the cap. Net cost
  // rises monotonically with the Fido price, so this always converges.
  let lo = 0
  let hi = 1000
  if (netMonthlyCost(input, hi) < todayNetCost) {
    // Even an absurd plan wins (huge other-spend bump) — report the ceiling
    // rather than a misleading number.
    hi = Infinity
  } else {
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      if (netMonthlyCost(input, mid) < todayNetCost) lo = mid
      else hi = mid
    }
  }
  const breakEvenPrice = Number.isFinite(hi) ? (lo + hi) / 2 : Infinity

  // "Close" band = within $2/mo either way — small enough that the decision
  // comes down to porting hassle, not the dollars.
  const verdict: FidoScenario['verdict'] = monthlyDelta > 2 ? 'switch' : monthlyDelta >= -2 ? 'close' : 'stay'

  return {
    breakEvenPrice,
    monthlyDelta,
    annualDelta: monthlyDelta * 12,
    planCostDelta:
      input.currentTwoLineTotal - (input.remainingKoodoLinePrice + input.fidoQuotedPrice),
    cashbackDelta: afterCashback - todayCashback,
    verdict,
  }
}
