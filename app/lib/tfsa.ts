/**
 * TFSA contribution-room math — pure and deterministic (no AI, no external data).
 *
 * Room is DERIVED, never stored: we anchor to a CRA-confirmed baseline (the room
 * the owner read off the CRA "My Account" page as of a Jan 1) and then apply the
 * federal rules forward from there. This means tagging a transfer as a TFSA
 * contribution instantly recalculates the remaining room, and the number is
 * always at least as current as CRA's (which only updates after you file).
 *
 * The two rules the app must respect (BUSINESS_RULES.md §16):
 *  1. A WITHDRAWAL only restores room on Jan 1 of the FOLLOWING year — never in
 *     the same year it was taken out.
 *  2. Re-contributing money you withdrew earlier the same year is an
 *     over-contribution unless you have other unused room (penalty 1%/month on
 *     the excess).
 */

export type RegisteredEntry = {
  kind: 'contribution' | 'withdrawal'
  amount: number // always positive
  occurredAt: string // YYYY-MM-DD
}

/**
 * Federal TFSA annual dollar limits by year (indexed to inflation, rounded to the
 * nearest $500). Used to grow the room past the baseline year. The baseline
 * already bakes in every year up to and including its own, so only years strictly
 * after the baseline year are added here. An unknown future year falls back to the
 * most recent known limit (a safe under/over of ±$0–500, surfaced as an estimate).
 */
export const TFSA_ANNUAL_LIMITS: Record<number, number> = {
  2009: 5000, 2010: 5000, 2011: 5000, 2012: 5000,
  2013: 5500, 2014: 5500, 2015: 10000, 2016: 5500,
  2017: 5500, 2018: 5500, 2019: 6000, 2020: 6000,
  2021: 6000, 2022: 6000, 2023: 6500, 2024: 7000,
  2025: 7000, 2026: 7000,
}

const KNOWN_YEARS = Object.keys(TFSA_ANNUAL_LIMITS).map(Number)
const LATEST_KNOWN_YEAR = Math.max(...KNOWN_YEARS)

/** The annual limit for a year, falling back to the latest known for the future. */
export function annualLimitFor(year: number): number {
  return TFSA_ANNUAL_LIMITS[year] ?? TFSA_ANNUAL_LIMITS[LATEST_KNOWN_YEAR]
}

function yearOf(iso: string): number {
  return Number(iso.slice(0, 4))
}

const round2 = (n: number) => Math.round(n * 100) / 100

export type TfsaRoom = {
  /** Contribution room available right now. Negative = over-contributed. */
  room: number
  baselineAmount: number
  baselineDate: string
  /** Annual limits added since the baseline year (future-year growth). */
  addedSinceBaseline: number
  /** Σ contributions dated on/after the baseline date. */
  contributionsSinceBaseline: number
  /** Contributions dated within the current calendar year. */
  contributionsThisYear: number
  /** Withdrawals taken this year whose room only returns next Jan 1. */
  withdrawalsPendingReturn: number
  /** This year's annual limit (for context). */
  annualLimit: number
  /** True when any limit used is an estimated (future) year. */
  estimated: boolean
  overContributed: boolean
  /** Plain-language guidance about room, returns and penalties. */
  warnings: string[]
}

/**
 * Compute current TFSA room from a baseline + the contribution/withdrawal ledger.
 *
 * @param baselineAmount room the CRA reported as of `baselineDate`
 * @param baselineDate   a Jan-1 ISO date the baseline is "as of"
 * @param entries        contributions (room −) and withdrawals (room + next year)
 * @param asOf           today (YYYY-MM-DD); defaults to the system date
 */
export function computeTfsaRoom(
  baselineAmount: number,
  baselineDate: string,
  entries: RegisteredEntry[],
  asOf: string = new Date().toISOString().slice(0, 10),
): TfsaRoom {
  const baselineYear = yearOf(baselineDate)
  const currentYear = yearOf(asOf)

  // 1. Grow the baseline by every annual limit AFTER the baseline year.
  let addedSinceBaseline = 0
  let estimated = false
  for (let y = baselineYear + 1; y <= currentYear; y++) {
    addedSinceBaseline += annualLimitFor(y)
    if (y > LATEST_KNOWN_YEAR) estimated = true
  }

  // 2. Subtract contributions made on/after the baseline date.
  let contributionsSinceBaseline = 0
  let contributionsThisYear = 0
  // 3. Withdrawals add room back on Jan 1 of the year AFTER they were taken.
  let withdrawalReturns = 0
  let withdrawalsPendingReturn = 0
  for (const e of entries) {
    if (e.occurredAt < baselineDate) continue
    if (e.kind === 'contribution') {
      contributionsSinceBaseline += e.amount
      if (yearOf(e.occurredAt) === currentYear) contributionsThisYear += e.amount
    } else {
      // Room returns Jan 1 of the next year; only counts if that day has arrived.
      if (yearOf(e.occurredAt) < currentYear) withdrawalReturns += e.amount
      else withdrawalsPendingReturn += e.amount
    }
  }

  const room = round2(
    baselineAmount + addedSinceBaseline - contributionsSinceBaseline + withdrawalReturns,
  )
  const overContributed = room < -0.005

  const warnings: string[] = []
  if (overContributed) {
    warnings.push(
      `Over-contributed by ${money(-room)}. The CRA charges a 1%/month penalty on the excess until it's withdrawn.`,
    )
  } else if (room < 1000) {
    warnings.push(`Only ${money(room)} of room left — watch the next contribution.`)
  }
  if (withdrawalsPendingReturn > 0.005) {
    warnings.push(
      `${money(withdrawalsPendingReturn)} you withdrew this year does NOT free up room until Jan 1, ${currentYear + 1}. Re-contributing it now counts as an over-contribution unless you have room above.`,
    )
  }
  if (estimated) {
    warnings.push(`Includes an estimated future annual limit — confirm the official figure.`)
  }

  return {
    room,
    baselineAmount: round2(baselineAmount),
    baselineDate,
    addedSinceBaseline: round2(addedSinceBaseline),
    contributionsSinceBaseline: round2(contributionsSinceBaseline),
    contributionsThisYear: round2(contributionsThisYear),
    withdrawalsPendingReturn: round2(withdrawalsPendingReturn),
    annualLimit: annualLimitFor(currentYear),
    estimated,
    overContributed,
    warnings,
  }
}

function money(n: number): string {
  return n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 })
}
