/**
 * RESP / CESG grant math — pure and deterministic. The point of this engine is
 * the one number no single institution computes for you: "deposit $X more before
 * Dec 31 to capture $Y in free government grant."
 *
 * Canada Education Savings Grant (CESG) rules (BUSINESS_RULES.md §16):
 *  - Basic CESG matches 20% of contributions.
 *  - Up to $500/year on the first $2,500 contributed.
 *  - Unused grant room carries forward; you can claim up to $1,000/year (on
 *    $5,000) when catching up — but only one extra year's worth at a time.
 *  - Lifetime grant cap: $7,200 per child.
 *  - Lifetime CONTRIBUTION cap: $50,000 per child (no annual contribution limit).
 *  - Grant is paid until the end of the year the child turns 17 (catch-up rules
 *    apply at 16–17).
 */

export const CESG_RATE = 0.2
export const CESG_ANNUAL_BASE = 500 // 20% of the $2,500 annual sweet spot
export const CESG_ANNUAL_MAX = 1000 // base + one year carry-forward (20% of $5,000)
export const CESG_LIFETIME_MAX = 7200
export const RESP_LIFETIME_CONTRIBUTION_MAX = 50000
export const CESG_LAST_YEAR_AGE = 17 // grant paid through the year the child turns 17

import type { RegisteredEntry } from '@/app/lib/tfsa'

const round2 = (n: number) => Math.round(n * 100) / 100
const yearOf = (iso: string) => Number(iso.slice(0, 4))

export type RespGrant = {
  contributionsThisYear: number
  lifetimeContributions: number
  /** Grant earned on this year's contributions so far. */
  grantEarnedThisYear: number
  /** This year's grant ceiling: $500, or up to $1,000 with carry-forward. */
  annualGrantCap: number
  grantReceivedLifetime: number
  lifetimeGrantRemaining: number
  /** Grant still claimable THIS year (annualGrantCap − earned, capped lifetime). */
  freeGrantAvailableThisYear: number
  /** $ to contribute more this year to capture all `freeGrantAvailableThisYear`. */
  roomToMaxGrantThisYear: number
  /** Remaining lifetime contribution headroom ($50k cap). */
  contributionRoomRemaining: number
  /** Last calendar year the grant can be received (null if birth year unknown). */
  grantDeadlineYear: number | null
  expired: boolean
  warnings: string[]
}

/**
 * @param entries            contribution ledger (withdrawals ignored for grant)
 * @param contributionBaseline lifetime contributions made before tracking started
 * @param grantBaselineReceived lifetime CESG already received before tracking
 * @param grantCarryForward  unused CESG carry-forward room available now ($ grant)
 * @param beneficiaryBirthYear for the age-17 deadline (null = unknown)
 * @param asOf               today (YYYY-MM-DD)
 */
export function computeRespGrant(
  entries: RegisteredEntry[],
  opts: {
    contributionBaseline?: number | null
    grantBaselineReceived?: number | null
    grantCarryForward?: number | null
    beneficiaryBirthYear?: number | null
  },
  asOf: string = new Date().toISOString().slice(0, 10),
): RespGrant {
  const currentYear = yearOf(asOf)
  const contribBaseline = opts.contributionBaseline ?? 0
  const grantBaseline = opts.grantBaselineReceived ?? 0
  const carryForward = Math.max(0, opts.grantCarryForward ?? 0)

  // Sum tracked contributions per year (withdrawals don't affect grant/cap here).
  const byYear = new Map<number, number>()
  let trackedTotal = 0
  for (const e of entries) {
    if (e.kind !== 'contribution') continue
    trackedTotal += e.amount
    byYear.set(yearOf(e.occurredAt), (byYear.get(yearOf(e.occurredAt)) ?? 0) + e.amount)
  }
  const contributionsThisYear = byYear.get(currentYear) ?? 0
  const lifetimeContributions = round2(contribBaseline + trackedTotal)

  // This year's grant ceiling: base $500 + however much carry-forward we can use
  // (a single extra year, so capped at another $500).
  const annualGrantCap = CESG_ANNUAL_BASE + Math.min(carryForward, CESG_ANNUAL_BASE)

  // Grant earned in prior TRACKED years (base cap only — carry-forward is modelled
  // for the actionable current year). Plus this year's earned grant.
  let priorTrackedGrant = 0
  for (const [y, amt] of byYear) {
    if (y >= currentYear) continue
    priorTrackedGrant += Math.min(amt * CESG_RATE, CESG_ANNUAL_BASE)
  }
  const grantEarnedThisYearRaw = Math.min(contributionsThisYear * CESG_RATE, annualGrantCap)

  // Cap everything by the lifetime $7,200 ceiling.
  const grantBeforeThisYear = Math.min(grantBaseline + priorTrackedGrant, CESG_LIFETIME_MAX)
  const grantEarnedThisYear = round2(
    Math.min(grantEarnedThisYearRaw, CESG_LIFETIME_MAX - grantBeforeThisYear),
  )
  const grantReceivedLifetime = round2(grantBeforeThisYear + grantEarnedThisYear)
  const lifetimeGrantRemaining = round2(Math.max(0, CESG_LIFETIME_MAX - grantReceivedLifetime))

  const freeGrantAvailableThisYear = round2(
    Math.min(annualGrantCap - grantEarnedThisYear, lifetimeGrantRemaining),
  )
  const roomToMaxGrantThisYear = round2(Math.max(0, freeGrantAvailableThisYear / CESG_RATE))
  const contributionRoomRemaining = round2(
    Math.max(0, RESP_LIFETIME_CONTRIBUTION_MAX - lifetimeContributions),
  )

  const grantDeadlineYear =
    opts.beneficiaryBirthYear != null ? opts.beneficiaryBirthYear + CESG_LAST_YEAR_AGE : null
  const expired = grantDeadlineYear != null && currentYear > grantDeadlineYear

  const warnings: string[] = []
  if (expired) {
    warnings.push(`Grant eligibility ended after ${grantDeadlineYear}. New contributions earn no CESG.`)
  } else if (freeGrantAvailableThisYear > 0.005) {
    warnings.push(
      `Deposit ${money(roomToMaxGrantThisYear)} more before Dec 31 to capture ${money(freeGrantAvailableThisYear)} in free CESG grant.`,
    )
  } else if (lifetimeGrantRemaining <= 0.005) {
    warnings.push(`Lifetime CESG maxed at ${money(CESG_LIFETIME_MAX)} — well done. 🎉`)
  } else {
    warnings.push(`This year's grant is already maxed. 🎉`)
  }
  if (lifetimeContributions > RESP_LIFETIME_CONTRIBUTION_MAX + 0.005) {
    warnings.push(
      `Over the ${money(RESP_LIFETIME_CONTRIBUTION_MAX)} lifetime contribution limit — excess is penalized 1%/month.`,
    )
  }
  if (grantDeadlineYear != null && !expired && currentYear >= grantDeadlineYear - 1) {
    warnings.push(`Last chance: grant eligibility ends after ${grantDeadlineYear}.`)
  }

  return {
    contributionsThisYear: round2(contributionsThisYear),
    lifetimeContributions,
    grantEarnedThisYear,
    annualGrantCap,
    grantReceivedLifetime,
    lifetimeGrantRemaining,
    freeGrantAvailableThisYear,
    roomToMaxGrantThisYear,
    contributionRoomRemaining,
    grantDeadlineYear,
    expired,
    warnings,
  }
}

function money(n: number): string {
  return n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 })
}
