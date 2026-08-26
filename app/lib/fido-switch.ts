// "Switch 1 line to Fido?" — a pure what-if calculator for a hypothetical new
// plan price. Lives alongside the Amex Cobalt / Rogers model since the whole
// point is the Rogers Mastercard cash-back mechanic: a Fido line makes the
// household a "qualifying customer", which lifts the card's rate on EVERYTHING
// (1.5% → 2%), not just on the phone bill.

import { ROGERS_ANNUAL_CAP, ROGERS_DOMESTIC_BASE_RATE } from '@/app/lib/amex-cobalt-core'

export const DEFAULT_KOODO_TWO_LINE_TOTAL = 45.2

export type FidoScenario = {
  /** The most Fido can charge **per line** and still leave the household no
   *  worse off. With both lines moved that ceiling applies twice over, so it
   *  falls well below the one-line figure. */
  breakEvenPrice: number
  /** 1 or 2 — echoed back so the UI can say "per line" only when it matters. */
  linesOnFido: 1 | 2
  /** Positive = switching saves this much per month. */
  monthlyDelta: number
  annualDelta: number
  /** Cheaper/dearer phone bills alone, ignoring all cash back. */
  planCostDelta: number
  /** Extra cash back per month from the whole-card rate lift. Since Rogers
   *  dropped the redemption bonus this is the *only* cash-back effect of the
   *  switch — the Fido bill itself just earns the same rate as anything else. */
  cashbackDelta: number
  verdict: 'switch' | 'close' | 'stay'
}

export type FidoSwitchInput = {
  currentTwoLineTotal: number
  /**
   * Asked for explicitly (not assumed to be half the two-line total) because
   * dropping to one line usually loses Koodo's multi-line discount. Unused when
   * `switchBothLines` is on — there is no Koodo line left to re-quote.
   */
  remainingKoodoLinePrice: number
  /** Quoted price of **one** Fido line. */
  fidoQuotedPrice: number
  /**
   * Move both lines to Fido, leaving Koodo entirely. Now purely a plan-cost
   * question: one qualifying line already buys the whole 2% lift, so the second
   * line adds no cash-back upside of its own. (It used to double the redeemable
   * Rogers-family bill; that bonus no longer exists.)
   */
  switchBothLines?: boolean
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
}

/**
 * Monthly cash back earned across the phone bills + other Rogers spend at a
 * given card-wide rate. The Fido bill has no special redemption value any more,
 * so it enters here as ordinary spend and nothing else.
 */
function monthlyCashback(
  monthlySpend: number,
  rate: number,
  postCapRate: number,
  annualCap: number,
): number {
  // The cap is annual, so annualize, split at the cap, then come back to
  // monthly. Above the cap the elevated rate simply stops applying, which is
  // exactly what limits how much a Fido line is worth to a heavy spender.
  const annualSpend = monthlySpend * 12
  const under = Math.min(annualSpend, annualCap)
  const over = Math.max(0, annualSpend - annualCap)
  return (under * rate + over * postCapRate) / 12
}

/** How many lines end up on Fido. Only the plan cost turns on this now. */
export function fidoLineCount(input: Pick<FidoSwitchInput, 'switchBothLines'>): 1 | 2 {
  return input.switchBothLines ? 2 : 1
}

/** Net monthly outlay attributable to this decision: phone bills minus all the
 *  cash back the card throws off (including on non-phone spend, since the rate
 *  on that spend is exactly what the switch changes). */
function netMonthlyCost(input: FidoSwitchInput, fidoPrice: number): number {
  const lines = fidoLineCount(input)
  // Both lines moved → no Koodo line left to pay for.
  const phone = lines === 2 ? fidoPrice * 2 : input.remainingKoodoLinePrice + fidoPrice
  const cashback = monthlyCashback(
    phone + input.otherRogersSpend,
    input.switchedRate,
    input.postCapRate ?? ROGERS_DOMESTIC_BASE_RATE,
    input.annualCap ?? ROGERS_ANNUAL_CAP,
  )
  return phone - cashback
}

export function computeFidoSwitch(input: FidoSwitchInput): FidoScenario {
  const postCapRate = input.postCapRate ?? ROGERS_DOMESTIC_BASE_RATE
  const annualCap = input.annualCap ?? ROGERS_ANNUAL_CAP

  // Today: two Koodo lines, card-wide base rate.
  const todayCashback = monthlyCashback(
    input.currentTwoLineTotal + input.otherRogersSpend,
    input.currentRate,
    postCapRate,
    annualCap,
  )
  const todayNetCost = input.currentTwoLineTotal - todayCashback

  const afterNetCost = netMonthlyCost(input, input.fidoQuotedPrice)
  const monthlyDelta = todayNetCost - afterNetCost

  const lines = fidoLineCount(input)
  const afterPhone =
    lines === 2 ? input.fidoQuotedPrice * 2 : input.remainingKoodoLinePrice + input.fidoQuotedPrice
  const afterCashback = monthlyCashback(
    afterPhone + input.otherRogersSpend,
    input.switchedRate,
    postCapRate,
    annualCap,
  )

  // Break-even solved numerically: the annual cap makes net cost a
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
    planCostDelta: input.currentTwoLineTotal - afterPhone,
    cashbackDelta: afterCashback - todayCashback,
    linesOnFido: lines,
    verdict,
  }
}
