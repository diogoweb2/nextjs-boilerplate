// Client-safe half of the Amex Cobalt model: pure math with no server-only
// imports, so the accounts-tab slider can re-price points on every tick
// without a round trip. Split out of amex-cobalt.ts (which pulls in
// app/lib/analytics.ts, transitively importing next/headers via demo.ts and
// therefore unusable from a 'use client' component).

/** Amex Cobalt membership fee, billed monthly (no annual option). */
export const COBALT_FEE_MONTHLY = 15.99

/** Default Membership Rewards point value in cents. Real-world redemption value
 *  ranges ~0.7¢ (statement credit) to ~1¢+ (fixed-points travel / transfer
 *  partners). Shown as an adjustable slider on the accounts tab. */
export const DEFAULT_CENTS_PER_POINT = 1.0

export type CobaltTier = 'grocery5x' | 'streaming3x' | 'transit2x' | 'base1x'

export const TIER_META: Record<CobaltTier, { label: string; multiplier: number; color: string }> = {
  grocery5x: { label: 'Groceries (5x)', multiplier: 5, color: '#22c55e' },
  streaming3x: { label: 'Streaming (3x)', multiplier: 3, color: '#a855f7' },
  transit2x: { label: 'Gas / transit / rideshare (2x)', multiplier: 2, color: '#3b82f6' },
  base1x: { label: 'Everything else (1x)', multiplier: 1, color: '#94a3b8' },
}

// Merchant-name keyword lists, kept here (not the DB) so the whole model is
// auditable in one file, same spirit as BIGGEST_PURCHASE_EXCLUDE_MERCHANTS.
//
// Matched on WORD BOUNDARIES, not raw substrings: bare `includes` made "mobil"
// match "Fido Mobile"/"Koodo Mobility" (filing phone bills as 2x gas), "max"
// match "Maxi" (a grocery chain), and "esso" match "espresso".
// Amazon is deliberately NOT here. An amazon.ca order earns the base 1x — it's
// not a grocery store. What earns 5x is buying an Amazon **gift card** at the
// supermarket till, and that charge already posts under the supermarket's own
// name (Metro/Freshco/…), so it matches on that. The explicit "gift card"
// keywords only catch a split part the owner relabelled (§4/§10c) — per the
// owner, gift cards on this ledger are always bought at a supermarket.
const GROCERY_KEYWORDS = ['metro', 'freshco', 'food basics', 'gift card', 'giftcard']
const STREAMING_KEYWORDS = [
  'netflix', 'spotify', 'disney', 'crave', 'prime video', 'apple tv', 'youtube premium',
  'youtube tv', 'paramount', 'crunchyroll', 'hbo', 'max', 'peacock', 'deezer', 'tidal', 'apple music',
]
const GAS_KEYWORDS = [
  'petro-canada', 'petro canada', 'esso', 'shell', 'circle k', 'costco gas', 'husky',
  'pioneer', 'ultramar', 'mobil', 'canadian tire gas',
]
const TRANSIT_KEYWORDS = ['presto', 'go transit', 'union station', 'ttc', 'uber', 'lyft']

/** Precompiled once — `classifyCobaltTier` runs per transaction per re-render. */
function wordMatcher(needles: string[]): RegExp {
  const escaped = needles.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i')
}

const GROCERY_RE = wordMatcher(GROCERY_KEYWORDS)
const STREAMING_RE = wordMatcher(STREAMING_KEYWORDS)
const GAS_TRANSIT_RE = wordMatcher([...GAS_KEYWORDS, ...TRANSIT_KEYWORDS])

/**
 * Classifies a transaction into an Amex Cobalt earn tier. "Amazon" is treated
 * as the grocery tier per the owner's confirmation that every Amazon charge on
 * this ledger is a gift card bought at the supermarket checkout, not an
 * amazon.com order — re-check this assumption if that ever changes.
 */
export function classifyCobaltTier(merchantName: string, categoryName: string): CobaltTier {
  if (GROCERY_RE.test(merchantName)) return 'grocery5x'
  if (categoryName === 'Subscriptions' && STREAMING_RE.test(merchantName)) return 'streaming3x'
  if (GAS_TRANSIT_RE.test(merchantName)) return 'transit2x'
  return 'base1x'
}

export type CobaltPointsTier = {
  tier: CobaltTier
  label: string
  color: string
  multiplier: number
  spend: number
  points: number
}

export type CobaltPointsMonth = { ym: string; spend: number; points: number }

/** Point totals only — independent of the $/point assumption, so the client
 *  can re-price them live without a server round trip. */
export type CobaltPointsData = {
  monthsOfData: number
  annualizedSpend: number
  tiers: CobaltPointsTier[]
  monthly: CobaltPointsMonth[]
}

export type CobaltTierBreakdown = CobaltPointsTier & { valueDollars: number }
export type CobaltMonthPoint = CobaltPointsMonth & { valueDollars: number; fee: number; net: number }

export type CobaltAnalysis = {
  monthsOfData: number
  annualizedSpend: number
  annualizedPointsValue: number
  annualFee: number
  netAnnualValue: number
  breakEvenMonthlySpend: number
  tiers: CobaltTierBreakdown[]
  monthly: CobaltMonthPoint[]
  verdict: 'keep' | 'close' | 'cancel'
}

/** Re-prices already-bucketed point totals at a given ¢/point + fee. Pure and
 *  cheap enough to re-run on every slider tick, client-side. */
export function valueFromPoints(
  data: CobaltPointsData,
  centsPerPoint: number,
  feeMonthly: number = COBALT_FEE_MONTHLY,
): CobaltAnalysis {
  const toValue = (points: number) => (points * centsPerPoint) / 100

  const tiers: CobaltTierBreakdown[] = data.tiers.map((t) => ({ ...t, valueDollars: toValue(t.points) }))
  const monthly: CobaltMonthPoint[] = data.monthly.map((m) => {
    const valueDollars = toValue(m.points)
    return { ...m, valueDollars, fee: feeMonthly, net: valueDollars - feeMonthly }
  })

  const totalSpendInWindow = tiers.reduce((s, t) => s + t.spend, 0)
  const totalValueInWindow = tiers.reduce((s, t) => s + t.valueDollars, 0)
  const annualizedPointsValue = data.monthsOfData > 0 ? (totalValueInWindow / data.monthsOfData) * 12 : 0
  const annualFee = feeMonthly * 12
  const netAnnualValue = annualizedPointsValue - annualFee

  // Blended $-of-spend needed per month to cover the fee, at this spend mix's
  // average points-value-per-dollar rate.
  const avgValueRate = totalSpendInWindow > 0 ? totalValueInWindow / totalSpendInWindow : 0
  const breakEvenMonthlySpend = avgValueRate > 0 ? feeMonthly / avgValueRate : Infinity

  // "Close" band = within one month's fee either side of break-even — a
  // near-wash where the answer depends on the point-value assumption, not a
  // clear-cut keep or cancel.
  const verdict: CobaltAnalysis['verdict'] =
    netAnnualValue > feeMonthly ? 'keep' : netAnnualValue >= -feeMonthly ? 'close' : 'cancel'

  return {
    monthsOfData: data.monthsOfData,
    annualizedSpend: data.annualizedSpend,
    annualizedPointsValue,
    annualFee,
    netAnnualValue,
    breakEvenMonthlySpend,
    tiers,
    monthly,
    verdict,
  }
}

// ── Rogers Bank Mastercard World Elite comparison ──────────────────────────
// The Cobalt fee only "costs" something relative to the free alternative
// already sitting in the wallet: no annual fee, flat cash back, no multiplier
// bookkeeping. Worth-it means beating this, not just beating $0.
//
// Per the card's actual terms (not a merchant-category bonus, corrected after
// the owner spotted the mismodel): cash back is a **whole-card rate**, 1.5% on
// eligible purchases normally or 2% on ALL of them once you hold ≥1 qualifying
// Rogers/Fido/Shaw/Comwave service — plus a separate 1.5x REDEMPTION bonus
// (not an earn bonus) when accumulated cash back is applied toward one of
// those bills specifically.

/** Flat cash back on domestic (CAD) purchases with no qualifying service, and
 *  the rate everything reverts to once the annual cap is hit. */
export const ROGERS_DOMESTIC_BASE_RATE = 0.015
/** Flat cash back on domestic (CAD) purchases once ≥1 qualifying service (Rogers/Fido/Shaw/Comwave) is active. */
export const ROGERS_DOMESTIC_BONUS_RATE = 0.02
/** Gross cash back on foreign-currency purchases, before the FX fee. */
export const ROGERS_FOREIGN_GROSS_RATE = 0.03
/** Canada's standard foreign-transaction fee, baked into the converted charge. */
export const FX_FEE = 0.025
/**
 * Net cash back on foreign-currency (USD) purchases: 3% back minus the 2.5% FX
 * fee = +0.5%, not the full 3%.
 */
export const ROGERS_FOREIGN_NET_RATE = ROGERS_FOREIGN_GROSS_RATE - FX_FEE
/**
 * Once the annual cap is hit, foreign purchases fall to the 1.5% base rate but
 * still pay the 2.5% FX fee — so post-cap foreign spend is **net negative**
 * (−1%). Worth surfacing: past the cap the card actively costs money abroad.
 */
export const ROGERS_FOREIGN_NET_RATE_POST_CAP = ROGERS_DOMESTIC_BASE_RATE - FX_FEE
/**
 * Annual spend cap on the elevated ("cash back offer") rates. Per the
 * cardholder agreement: "These cash back offers are available on the first
 * $61,000 spent on your Account during your annual period. After that, your
 * eligible purchases will earn cash back at the base rate of 1.5% until your
 * Reset Date." So both the 2% domestic and 3% foreign offers stop at this line.
 */
export const ROGERS_ANNUAL_CAP = 61_000
/** Extra value (on top of 1x) when cash back is redeemed toward a qualifying
 *  Rogers/Fido/Shaw/Comwave bill instead of a plain statement credit. Applies at
 *  redemption, so it is not subject to the annual spend cap. */
export const ROGERS_REDEMPTION_BONUS = 0.5

export const ROGERS_FAMILY_KEYWORDS = ['rogers', 'fido', 'shaw', 'comwave']
const ROGERS_FAMILY_RE = wordMatcher(ROGERS_FAMILY_KEYWORDS)

export function isRogersFamilyMerchant(merchantName: string): boolean {
  return ROGERS_FAMILY_RE.test(merchantName)
}

/**
 * Any mobile/phone carrier bill. Used to carve phone spend OUT of the
 * "other Rogers spend" base in the §25 Fido calculator, which models the phone
 * bills explicitly — counting them in both places would double-count them.
 * Deliberately omits a bare "bell" (it would match Taco Bell, Campbell, …).
 */
const PHONE_BILL_KEYWORDS = [
  'koodo', 'fido', 'rogers', 'telus', 'chatr', 'bell canada', 'bell mobility',
  'virgin mobile', 'virgin plus', 'public mobile', 'freedom mobile', 'lucky mobile',
]
const PHONE_BILL_RE = wordMatcher(PHONE_BILL_KEYWORDS)

export function isPhoneBillMerchant(merchantName: string): boolean {
  return PHONE_BILL_RE.test(merchantName)
}

/** `familySpend` is a subset of `domesticSpend` (it still earns the flat
 *  domestic rate) — tracked separately only to cap the redemption bonus, which
 *  can't exceed what's actually owed on those bills. */
export type RogersSpendMonth = { ym: string; domesticSpend: number; foreignSpend: number; familySpend: number }

/** Raw spend buckets only — independent of the cash-back rate assumptions, so
 *  the client can re-price them live (same split as CobaltPointsData/points). */
export type RogersSpendData = {
  monthsOfData: number
  domesticSpend: number
  foreignSpend: number
  familySpend: number
  monthly: RogersSpendMonth[]
}

export type RogersRates = {
  /** Domestic rate below the annual cap. */
  domestic: number
  /** Foreign net rate below the annual cap. */
  foreign: number
  /** Domestic rate once cumulative annual spend passes the cap. */
  domesticPostCap: number
  /** Foreign net rate past the cap — negative, since the FX fee outlives the offer. */
  foreignPostCap: number
  /** Spend past which the elevated rates stop, for the observed window. */
  annualCap: number
  /** Apply the 1.5x redemption bonus, capped at that month's family spend. */
  redeemTowardBill: boolean
}

/** Assembles the six rate fields from the two decisions that actually vary, so
 *  callers never hand-roll (and never forget the post-cap pair). */
export function rogersRates(opts: {
  /** Holding ≥1 Rogers/Fido/Shaw/Comwave service lifts domestic 1.5% → 2%. */
  qualifying: boolean
  redeemTowardBill?: boolean
  annualCap?: number
}): RogersRates {
  return {
    domestic: opts.qualifying ? ROGERS_DOMESTIC_BONUS_RATE : ROGERS_DOMESTIC_BASE_RATE,
    foreign: ROGERS_FOREIGN_NET_RATE,
    domesticPostCap: ROGERS_DOMESTIC_BASE_RATE,
    foreignPostCap: ROGERS_FOREIGN_NET_RATE_POST_CAP,
    annualCap: opts.annualCap ?? ROGERS_ANNUAL_CAP,
    redeemTowardBill: opts.redeemTowardBill ?? false,
  }
}

export const DEFAULT_ROGERS_RATES: RogersRates = rogersRates({ qualifying: false })

export type RogersMonthPoint = RogersSpendMonth & { cashback: number }

export type RogersAnalysis = {
  monthsOfData: number
  domesticSpend: number
  foreignSpend: number
  familySpend: number
  annualizedCashback: number
  monthly: RogersMonthPoint[]
  /** Annualized spend measured against the cap — drives the UI warning. */
  annualizedSpend: number
  /** True when spend runs past the cap, so some of it earns only the base rate. */
  hitsAnnualCap: boolean
  /** Annualized $ lost to the cap vs. an uncapped world. 0 when under it. */
  capCostAnnual: number
}

/**
 * Re-prices already-bucketed Rogers spend at a given set of cash-back rates.
 * Pure — cheap enough to re-run on every slider tick, client-side.
 *
 * The annual cap makes this **order-dependent**: spend is walked month by month
 * in calendar order, and the month that straddles the cap has its domestic and
 * foreign amounts split pro rata between the elevated and base rates. The cap is
 * pro-rated to the observed window (`cap × monthsOfData / 12`) so that a ledger
 * shorter than a year isn't handed a full year's worth of headroom before being
 * annualized back up.
 */
export function cashbackFromSpend(data: RogersSpendData, rates: RogersRates = DEFAULT_ROGERS_RATES): RogersAnalysis {
  const windowCap = data.monthsOfData > 0 ? (rates.annualCap * data.monthsOfData) / 12 : rates.annualCap

  let cumulative = 0
  // Both tracked pre-redemption-bonus, so the cap's cost is a like-for-like
  // comparison (the bonus is a redemption mechanic, unaffected by the cap).
  let earnedCapped = 0
  let earnedUncapped = 0

  const monthly: RogersMonthPoint[] = data.monthly.map((m) => {
    const monthSpend = m.domesticSpend + m.foreignSpend
    const roomBefore = Math.max(0, windowCap - cumulative)
    // Fraction of this month's spend still under the cap.
    const underShare = monthSpend > 0 ? Math.min(1, roomBefore / monthSpend) : 1
    const domRate = underShare * rates.domestic + (1 - underShare) * rates.domesticPostCap
    const forRate = underShare * rates.foreign + (1 - underShare) * rates.foreignPostCap

    const earned = m.domesticSpend * domRate + m.foreignSpend * forRate
    // The bonus can't exceed what's actually redeemed against the bill, nor
    // what's been earned to redeem in the first place.
    const bonus = rates.redeemTowardBill ? Math.min(earned, m.familySpend) * ROGERS_REDEMPTION_BONUS : 0

    earnedCapped += earned
    earnedUncapped += m.domesticSpend * rates.domestic + m.foreignSpend * rates.foreign
    cumulative += monthSpend
    return { ...m, cashback: earned + bonus }
  })

  const cashbackInWindow = monthly.reduce((sum, m) => sum + m.cashback, 0)
  const scale = data.monthsOfData > 0 ? 12 / data.monthsOfData : 0
  const annualizedCashback = cashbackInWindow * scale
  const annualizedSpend = cumulative * scale
  const capCostAnnual = Math.max(0, (earnedUncapped - earnedCapped) * scale)

  return {
    monthsOfData: data.monthsOfData,
    domesticSpend: data.domesticSpend,
    foreignSpend: data.foreignSpend,
    familySpend: data.familySpend,
    annualizedCashback,
    monthly,
    annualizedSpend,
    hitsAnnualCap: cumulative > windowCap,
    capCostAnnual,
  }
}

export type CardShowdown = {
  /** Cobalt net value minus Rogers cash back, annualized — positive = Cobalt ahead. */
  advantage: number
  verdict: 'cobalt' | 'close' | 'rogers'
}

/** Compares an already-priced Cobalt analysis against Rogers' (fixed-rate,
 *  fee-free) cash back. Pure — safe to re-run on every point-value slider tick. */
export function compareCards(cobalt: CobaltAnalysis, rogers: RogersAnalysis): CardShowdown {
  const advantage = cobalt.netAnnualValue - rogers.annualizedCashback
  // "Close" band mirrors the standalone verdict: within one month's Cobalt fee
  // either way, the two cards are close enough that the point-value assumption
  // (not the math) decides it.
  const verdict: CardShowdown['verdict'] =
    advantage > COBALT_FEE_MONTHLY ? 'cobalt' : advantage >= -COBALT_FEE_MONTHLY ? 'close' : 'rogers'
  return { advantage, verdict }
}
