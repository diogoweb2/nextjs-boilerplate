import type { EnrichedTxn } from '@/app/lib/analytics'
import { addMonths, anchorMonth } from '@/app/lib/analytics'
import {
  TIER_META,
  classifyCobaltTier,
  valueFromPoints,
  cashbackFromSpend,
  compareCards,
  isRogersFamilyMerchant,
  isPhoneBillMerchant,
  DEFAULT_CENTS_PER_POINT,
  COBALT_FEE_MONTHLY,
  DEFAULT_ROGERS_RATES,
  type CobaltTier,
  type CobaltPointsData,
  type CobaltPointsTier,
  type CobaltAnalysis,
  type RogersSpendData,
  type RogersSpendMonth,
  type RogersAnalysis,
  type CardShowdown,
} from '@/app/lib/amex-cobalt-core'

export * from '@/app/lib/amex-cobalt-core'

function trailingTwelveMonths(anchor: string): string[] {
  const months: string[] = []
  for (let i = 11; i >= 0; i--) months.push(addMonths(anchor, -i))
  return months
}

/** True when a Master-format merchant country code (only Amex/bank rows lack
 *  one — see app/actions/projects.ts) indicates a non-Canadian purchase. */
function isForeignCountry(country: string | null | undefined): boolean {
  if (!country) return false
  const c = country.trim().toUpperCase()
  return c !== '' && c !== 'CA' && c !== 'CAN'
}

/**
 * The purchases a credit card would actually earn rewards on. Not the same set
 * as "expense flow", because of gift cards (§10c):
 *
 * - **Gift-card loads are included** even though `loadGiftCard` flips them to
 *   `flow = 'transfer'`. Buying a $100 Amazon card at Metro is a real $100
 *   swipe at a supermarket — it earns 5x whatever the app later does with the
 *   row for budgeting purposes.
 * - **`manual` rows are excluded** — gift-card *spends* (`goal:…:giftspend:…`)
 *   and goal-funding offsets are app-generated. Spending gift-card balance at
 *   the till involves no card at all, so it earns nothing; counting it would
 *   both double-count the original load and invent rewards out of nothing.
 * - Ordinary transfers (CC payments, inter-account moves) stay excluded.
 */
function cardEligiblePurchases(flows: EnrichedTxn[], giftCardLoadIds: Set<number>): EnrichedTxn[] {
  return flows.filter(
    (t) =>
      t.amount > 0 &&
      t.source !== 'manual' &&
      (t.flow === 'expense' || giftCardLoadIds.has(t.id)),
  )
}

/** Everything the reward models need beyond the flows themselves. */
export type CardRewardContext = {
  /** transaction id → merchant country code (Master-format rows only). */
  countryById: Map<number, string | null>
  /** Transaction ids flipped to `transfer` by a gift-card load (§10c). */
  giftCardLoadIds: Set<number>
}

/**
 * Buckets up to the trailing 12 complete months of real purchase spend (all
 * cards — the question is what spend *would* earn on Cobalt, not just what's
 * already on Amex) into the card's earn tiers. Server-only: pulls in
 * app/lib/analytics.ts (and therefore next/headers via demo.ts), so this
 * function must never be imported from a 'use client' component — see
 * amex-cobalt-core.ts for the client-safe re-pricing half.
 */
export function computeCobaltPoints(flows: EnrichedTxn[], ctx: CardRewardContext): CobaltPointsData {
  const purchases = cardEligiblePurchases(flows, ctx.giftCardLoadIds)
  const anchor = anchorMonth(flows)

  const emptyTiers: CobaltPointsTier[] = (Object.keys(TIER_META) as CobaltTier[]).map((tier) => ({
    tier,
    ...TIER_META[tier],
    spend: 0,
    points: 0,
  }))
  if (!anchor || purchases.length === 0) {
    return { monthsOfData: 0, annualizedSpend: 0, tiers: emptyTiers, monthly: [] }
  }

  const months = trailingTwelveMonths(anchor)
  const monthSet = new Set(months)
  const inWindow = purchases.filter((t) => monthSet.has(t.txnDate.slice(0, 7)))
  const monthsOfData = new Set(inWindow.map((t) => t.txnDate.slice(0, 7))).size || 1

  const tierTotals: Record<CobaltTier, { spend: number; points: number }> = {
    grocery5x: { spend: 0, points: 0 },
    streaming3x: { spend: 0, points: 0 },
    transit2x: { spend: 0, points: 0 },
    base1x: { spend: 0, points: 0 },
  }
  const spendByMonth = new Map<string, number>()
  const pointsByMonth = new Map<string, number>()

  for (const t of inWindow) {
    const tier = classifyCobaltTier(t.merchantName, t.categoryName)
    const points = t.amount * TIER_META[tier].multiplier
    tierTotals[tier].spend += t.amount
    tierTotals[tier].points += points
    const ym = t.txnDate.slice(0, 7)
    spendByMonth.set(ym, (spendByMonth.get(ym) ?? 0) + t.amount)
    pointsByMonth.set(ym, (pointsByMonth.get(ym) ?? 0) + points)
  }

  const tiers: CobaltPointsTier[] = (Object.keys(TIER_META) as CobaltTier[]).map((tier) => ({
    tier,
    ...TIER_META[tier],
    spend: tierTotals[tier].spend,
    points: tierTotals[tier].points,
  }))

  const totalSpendInWindow = tiers.reduce((s, t) => s + t.spend, 0)
  const annualizedSpend = (totalSpendInWindow / monthsOfData) * 12

  const monthly = months.map((ym) => ({
    ym,
    spend: spendByMonth.get(ym) ?? 0,
    points: pointsByMonth.get(ym) ?? 0,
  }))

  return { monthsOfData, annualizedSpend, tiers, monthly }
}

export function computeCobaltAnalysis(
  flows: EnrichedTxn[],
  ctx: CardRewardContext,
  opts: { centsPerPoint?: number; feeMonthly?: number } = {},
): CobaltAnalysis {
  return valueFromPoints(
    computeCobaltPoints(flows, ctx),
    opts.centsPerPoint ?? DEFAULT_CENTS_PER_POINT,
    opts.feeMonthly ?? COBALT_FEE_MONTHLY,
  )
}

/**
 * Buckets the same trailing-12-month spend into domestic / foreign totals —
 * independent of the cash-back rate assumptions, so the client can re-price
 * with `cashbackFromSpend` on every slider tick. `familySpend` (Rogers/Fido
 * bills) is a **subset** of `domesticSpend`, tracked separately only to cap
 * the redemption bonus — it still earns the same flat domestic rate as
 * everything else (the card's "2%" is whole-card, not merchant-specific).
 * `countryById` only has real values for Master-format card rows (Amex/bank
 * rows carry no merchant country code and are treated as domestic — see
 * `isForeignCountry`).
 */
export function computeRogersSpend(flows: EnrichedTxn[], ctx: CardRewardContext): RogersSpendData {
  const { countryById } = ctx
  const purchases = cardEligiblePurchases(flows, ctx.giftCardLoadIds)
  const anchor = anchorMonth(flows)
  if (!anchor || purchases.length === 0) {
    return { monthsOfData: 0, domesticSpend: 0, foreignSpend: 0, familySpend: 0, monthly: [] }
  }

  const months = trailingTwelveMonths(anchor)
  const monthSet = new Set(months)
  const inWindow = purchases.filter((t) => monthSet.has(t.txnDate.slice(0, 7)))
  const monthsOfData = new Set(inWindow.map((t) => t.txnDate.slice(0, 7))).size || 1

  let domesticSpend = 0
  let foreignSpend = 0
  let familySpend = 0
  const byMonth = new Map<string, { domestic: number; foreign: number; family: number }>()

  for (const t of inWindow) {
    const ym = t.txnDate.slice(0, 7)
    const bucket = byMonth.get(ym) ?? { domestic: 0, foreign: 0, family: 0 }
    if (isForeignCountry(countryById.get(t.id))) {
      foreignSpend += t.amount
      bucket.foreign += t.amount
    } else {
      domesticSpend += t.amount
      bucket.domestic += t.amount
      if (isRogersFamilyMerchant(t.merchantName)) {
        familySpend += t.amount
        bucket.family += t.amount
      }
    }
    byMonth.set(ym, bucket)
  }

  const monthly: RogersSpendMonth[] = months.map((ym) => {
    const b = byMonth.get(ym) ?? { domestic: 0, foreign: 0, family: 0 }
    return { ym, domesticSpend: b.domestic, foreignSpend: b.foreign, familySpend: b.family }
  })

  return { monthsOfData, domesticSpend, foreignSpend, familySpend, monthly }
}

export function computeCardShowdown(
  flows: EnrichedTxn[],
  ctx: CardRewardContext,
  opts: { centsPerPoint?: number; feeMonthly?: number } = {},
): CardShowdown & { cobalt: CobaltAnalysis; rogers: RogersAnalysis } {
  const cobalt = computeCobaltAnalysis(flows, ctx, opts)
  const rogers = cashbackFromSpend(computeRogersSpend(flows, ctx), DEFAULT_ROGERS_RATES)
  return { cobalt, rogers, ...compareCards(cobalt, rogers) }
}

/**
 * Average monthly **non-phone domestic** spend, split by which card it's on
 * today. Feeds the §25 Fido calculator's "other Rogers spend" input — the base
 * the 1.5%→2% qualifying-customer lift applies to, which is where essentially
 * all the value of switching lives (0.5pp of a real month's spending dwarfs any
 * cash back on a ~$25 phone bill).
 *
 * Phone bills are excluded because the calculator models them explicitly;
 * counting them here too would double-count. Foreign spend is excluded because
 * its rate (net 0.5%) doesn't change with qualifying status.
 *
 * `onRogersCard` uses `source === 'master'` — the Rogers Bank Mastercard
 * ingests under that source (§1). If the owner ever carries a second
 * Master-format card the figure would be overstated, which is why the UI shows
 * the basis and window alongside the number instead of hiding the derivation.
 * It is rendered read-only: the ledger already knows this, so asking for it
 * would be asking the owner to re-type data the app has.
 */
export function computePhoneSwitchSpendBasis(
  flows: EnrichedTxn[],
  ctx: CardRewardContext,
): { monthsOfData: number; onRogersCard: number; onAllCards: number } {
  const { countryById } = ctx
  const anchor = anchorMonth(flows)
  const purchases = cardEligiblePurchases(flows, ctx.giftCardLoadIds)
  if (!anchor || purchases.length === 0) return { monthsOfData: 0, onRogersCard: 0, onAllCards: 0 }

  const monthSet = new Set(trailingTwelveMonths(anchor))
  const inWindow = purchases.filter(
    (t) =>
      monthSet.has(t.txnDate.slice(0, 7)) &&
      !isForeignCountry(countryById.get(t.id)) &&
      !isPhoneBillMerchant(t.merchantName),
  )
  const monthsOfData = new Set(inWindow.map((t) => t.txnDate.slice(0, 7))).size || 1

  let onRogersCard = 0
  let onAllCards = 0
  for (const t of inWindow) {
    onAllCards += t.amount
    if (t.source === 'master') onRogersCard += t.amount
  }

  return {
    monthsOfData,
    onRogersCard: onRogersCard / monthsOfData,
    onAllCards: onAllCards / monthsOfData,
  }
}
