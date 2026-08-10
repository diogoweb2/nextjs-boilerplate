import type { EnrichedTxn, ImportSource } from '@/app/lib/analytics'
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
  type PersonKey,
  type RogersSpendByPerson,
  type CardSource,
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
 * The two rewards-earning credit cards. Bank rows (`tangerine`, `scotia`) are
 * **deliberately excluded from this whole feature** per the owner: they are
 * chequing/debit activity, not card purchases, so they neither earn Cobalt
 * points nor Rogers cash back and there is no scenario here that moves them
 * onto a card. Keeping them was actively misleading — they carry no card
 * last-4, so §26 attributed every one of them to `self` and badly skewed the
 * per-cardholder split.
 */
const REWARD_EARNING_SOURCES: ReadonlySet<ImportSource> = new Set<ImportSource>(['master', 'amex'])

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
 * - **Bank rows are excluded** — see `REWARD_EARNING_SOURCES`.
 * - Ordinary transfers (CC payments, inter-account moves) stay excluded.
 */
function cardEligiblePurchases(flows: EnrichedTxn[], giftCardLoadIds: Set<number>): EnrichedTxn[] {
  return flows.filter(
    (t) =>
      t.amount > 0 &&
      REWARD_EARNING_SOURCES.has(t.source) &&
      (t.flow === 'expense' || giftCardLoadIds.has(t.id)),
  )
}

/** Everything the reward models need beyond the flows themselves. */
export type CardRewardContext = {
  /** transaction id → merchant country code (Master-format rows only). */
  countryById: Map<number, string | null>
  /** Transaction ids flipped to `transfer` by a gift-card load (§10c). */
  giftCardLoadIds: Set<number>
  /** transaction id → which cardholder made it, resolved from the card last-4
   *  via .env.local (app/lib/cardholders.ts). Never a name. */
  personById: Map<number, PersonKey>
}

/**
 * Buckets up to the trailing 12 complete months of real purchase spend (both
 * credit cards — the question is what spend *would* earn on Cobalt, not just
 * what's already on Amex) into the card's earn tiers. Server-only: pulls in
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
  const w = rogersWindow(flows, ctx)
  if (!w) return EMPTY_ROGERS_SPEND
  return bucketRogersSpend(w.inWindow, w.months, w.monthsOfData, ctx.countryById)
}

const EMPTY_ROGERS_SPEND: RogersSpendData = {
  monthsOfData: 0,
  domesticSpend: 0,
  foreignSpend: 0,
  familySpend: 0,
  monthly: [],
}

/** The trailing-12-month slice of card-eligible purchases, shared by every
 *  Rogers bucketing call so they all annualize over the same window. */
function rogersWindow(
  flows: EnrichedTxn[],
  ctx: CardRewardContext,
): { months: string[]; inWindow: EnrichedTxn[]; monthsOfData: number } | null {
  const purchases = cardEligiblePurchases(flows, ctx.giftCardLoadIds)
  const anchor = anchorMonth(flows)
  if (!anchor || purchases.length === 0) return null

  const months = trailingTwelveMonths(anchor)
  const monthSet = new Set(months)
  const inWindow = purchases.filter((t) => monthSet.has(t.txnDate.slice(0, 7)))
  if (inWindow.length === 0) return null
  const monthsOfData = new Set(inWindow.map((t) => t.txnDate.slice(0, 7))).size || 1
  return { months, inWindow, monthsOfData }
}

/** `monthsOfData` is passed in rather than derived, so a per-person subset is
 *  annualized (and cap-pro-rated) over the *household* window — otherwise a
 *  cardholder active in only 6 of 12 months would be handed a full cap. */
function bucketRogersSpend(
  txns: EnrichedTxn[],
  months: string[],
  monthsOfData: number,
  countryById: Map<number, string | null>,
): RogersSpendData {
  let domesticSpend = 0
  let foreignSpend = 0
  let familySpend = 0
  const byMonth = new Map<string, { domestic: number; foreign: number; family: number }>()

  for (const t of txns) {
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

/**
 * The same trailing-12-month spend, split by cardholder — the input to §26's
 * "two Rogers cards, one each?" question, where each Account carries its own
 * $61,000 cap.
 *
 * Attribution comes from the card last-4 (`ctx.personById`, resolved through
 * .env.local so no name touches the DB or this public repo). Both the Master
 * and Amex importers carry a last-4 (`app/lib/csv.ts`), and bank rows — the
 * ones that never had one — are already out of scope via
 * `REWARD_EARNING_SOURCES`, so the `?? 'self'` fallback should be unreachable
 * in practice. It stays as the same safe default the rest of the app uses.
 */
export function computeRogersSpendByPerson(
  flows: EnrichedTxn[],
  ctx: CardRewardContext,
): RogersSpendByPerson {
  const w = rogersWindow(flows, ctx)
  if (!w) {
    return {
      monthsOfData: 0,
      self: EMPTY_ROGERS_SPEND,
      partner: EMPTY_ROGERS_SPEND,
      combined: EMPTY_ROGERS_SPEND,
    }
  }

  const personOf = (t: EnrichedTxn): PersonKey => ctx.personById.get(t.id) ?? 'self'
  const bucket = (txns: EnrichedTxn[]) =>
    bucketRogersSpend(txns, w.months, w.monthsOfData, ctx.countryById)

  return {
    monthsOfData: w.monthsOfData,
    self: bucket(w.inWindow.filter((t) => personOf(t) === 'self')),
    partner: bucket(w.inWindow.filter((t) => personOf(t) === 'partner')),
    combined: bucket(w.inWindow),
  }
}

/** Annualized purchase spend per cardholder per card, plus both together —
 *  the plain "where does the money actually go" table behind §26's scenario. */
export type SpendMatrix = {
  monthsOfData: number
  /** Only sources with spend in the window, in a stable display order. */
  sources: CardSource[]
  rows: { person: PersonKey; bySource: Record<string, number>; total: number }[]
  totalsBySource: Record<string, number>
  grandTotal: number
}

// Only the reward-earning cards can ever appear (cardEligiblePurchases drops
// everything else). Typed as ImportSource, assigned into SpendMatrix['sources']
// (CardSource) — so if the two unions ever drift apart this stops compiling.
const SOURCE_ORDER: ImportSource[] = ['master', 'amex']

export function computeSpendMatrix(flows: EnrichedTxn[], ctx: CardRewardContext): SpendMatrix {
  const w = rogersWindow(flows, ctx)
  if (!w) {
    return { monthsOfData: 0, sources: [], rows: [], totalsBySource: {}, grandTotal: 0 }
  }
  const scale = 12 / w.monthsOfData

  const totals: Record<PersonKey, Record<string, number>> = { self: {}, partner: {} }
  const totalsBySource: Record<string, number> = {}
  const seen = new Set<ImportSource>()

  for (const t of w.inWindow) {
    const person = ctx.personById.get(t.id) ?? 'self'
    const amount = t.amount * scale
    totals[person][t.source] = (totals[person][t.source] ?? 0) + amount
    totalsBySource[t.source] = (totalsBySource[t.source] ?? 0) + amount
    seen.add(t.source)
  }

  const sources = SOURCE_ORDER.filter((s) => seen.has(s))
  const rows = (['self', 'partner'] as PersonKey[]).map((person) => ({
    person,
    bySource: totals[person],
    total: Object.values(totals[person]).reduce((a, b) => a + b, 0),
  }))

  return {
    monthsOfData: w.monthsOfData,
    sources,
    rows,
    totalsBySource,
    grandTotal: Object.values(totalsBySource).reduce((a, b) => a + b, 0),
  }
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
 * `onAllCards` means both credit cards; bank/debit rows are out of scope for
 * this whole feature (see `REWARD_EARNING_SOURCES`).
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
