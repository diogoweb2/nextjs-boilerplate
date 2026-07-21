/**
 * Canada retirement-rules constants + pure calculators — the correctness surface
 * behind the Retirement Consultant (BUSINESS_RULES.md §20, RETIREMENT_PLAN.md §3).
 *
 * NO AI, NO external calls, NO DB. Every function here is a pure function of its
 * arguments and the constant tables in this file. The tables carry a `lastVerified`
 * date; the UI shows a discreet "rules last updated" note, and BUSINESS_RULES §20
 * keeps a VERIFY-list of every figure that must be re-checked against the current
 * CRA / Service Canada / HOOPP publications.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠️  VERIFY-BEFORE-TRUSTING (as of 2026-07 — owner confirms in-browser):
 *   - YMPE / YAMPE table (CPP), max CPP at 65
 *   - OAS full monthly amount + clawback (recovery-tax) threshold
 *   - TFSA 2026 annual limit / RRSP dollar limit
 *   - ODSP single/couple rates, Canada Disability Benefit amount
 *   - RRIF minimum-withdrawal factor table
 *   - RDSP grant (CDSG) tiers + bond (CDSB) amounts
 *   - Ontario + federal tax brackets, basic personal amounts, credits
 * These are best-known values, not authoritative. See §10 "Honest limitations".
 * ────────────────────────────────────────────────────────────────────────────
 */

export const RULES_LAST_VERIFIED = '2026-07'

/* ══════════════════════════════════════════════════════════════════════════
 * CPP — Canada Pension Plan
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Year's Maximum Pensionable Earnings (YMPE) history. Real values 2010–2026;
 * future years are grown by wage inflation in `ympeFor`. This is the ceiling on
 * pensionable earnings each year — the CPP replacement is a fraction of the
 * average YMPE, so this table anchors the whole CPP reconstruction (§5.3).
 */
export const YMPE: Record<number, number> = {
  2010: 47200, 2011: 48300, 2012: 50100, 2013: 51100, 2014: 52500,
  2015: 53600, 2016: 54900, 2017: 55300, 2018: 55900, 2019: 57400,
  2020: 58700, 2021: 61600, 2022: 64900, 2023: 66600, 2024: 68500,
  2025: 71300, 2026: 74900,
}

/**
 * Year's Additional Maximum Pensionable Earnings (YAMPE) — the CPP2 ceiling that
 * began in 2024 (≈ 107% of YMPE in 2024, 114% from 2025 on). The enhancement
 * layer (CPP2) covers earnings between YMPE and YAMPE at a higher replacement.
 */
export const YAMPE: Record<number, number> = {
  2024: 73200, 2025: 81200, 2026: 85400,
}

const YMPE_YEARS = Object.keys(YMPE).map(Number)
const LATEST_YMPE_YEAR = Math.max(...YMPE_YEARS)
const EARLIEST_YMPE_YEAR = Math.min(...YMPE_YEARS)

/** Assumed future wage growth for projecting the YMPE past the known table. */
export const YMPE_WAGE_GROWTH = 0.032 // ≈ inflation 2.5% + ~1% real wage growth

/** YMPE for any year, extrapolated with wage growth beyond the known table. */
export function ympeFor(year: number): number {
  if (YMPE[year]) return YMPE[year]
  if (year < EARLIEST_YMPE_YEAR) return YMPE[EARLIEST_YMPE_YEAR]
  const base = YMPE[LATEST_YMPE_YEAR]
  return Math.round((base * Math.pow(1 + YMPE_WAGE_GROWTH, year - LATEST_YMPE_YEAR)) / 100) * 100
}

/** YAMPE for a year (CPP2). Before 2024 there was no YAMPE (returns the YMPE). */
export function yampeFor(year: number): number {
  if (year < 2024) return ympeFor(year)
  if (YAMPE[year]) return YAMPE[year]
  // Post-table: hold the ≈114% ratio to the projected YMPE.
  return Math.round((ympeFor(year) * 1.14) / 100) * 100
}

/**
 * Maximum CPP retirement pension at 65 (monthly), current year. Used only as a
 * sanity clamp — the reconstruction should never exceed this. Best-known 2026.
 */
export const CPP_MAX_MONTHLY_AT_65 = 1433.0 // ⚠️ verify (2025 was ~1433; 2026 TBD)

/** Base CPP replaces 25% of the average of the best pensionable-earnings ratios. */
export const CPP_BASE_REPLACEMENT = 0.25
/** Enhancement (post-2019) lifts replacement toward 33.33% on covered earnings. */
export const CPP_ENHANCED_REPLACEMENT = 0.3333
/** The general low-earnings dropout: the lowest ~17% of contributory months drop. */
export const CPP_DROPOUT_RATE = 0.17
/** Actuarial adjustment: −0.6%/mo (−7.2%/yr) before 65, +0.7%/mo (+8.4%/yr) after. */
export const CPP_EARLY_MONTHLY = 0.006
export const CPP_LATE_MONTHLY = 0.007

/** Adjustment factor for starting CPP at `startAge` (60–70) vs the base at 65. */
export function cppStartFactor(startAge: number): number {
  const months = (startAge - 65) * 12
  if (months < 0) return 1 + months * CPP_EARLY_MONTHLY // months negative → reduction
  return 1 + months * CPP_LATE_MONTHLY
}

export type EarningsPoint = { year: number; earnings: number }

/**
 * Reconstruct an annual gross-earnings history from two known points (start-year
 * salary and current salary), linearly interpolated between them and held flat
 * after the current year to the CPP start age. Immigrant CPP starts at the first
 * Canadian year — pre-arrival years are simply absent (and the dropout erases the
 * rest), which is exactly why immigrant CPP is better than people fear (§5.3).
 */
export function reconstructEarnings(
  startYear: number,
  startEarnings: number,
  currentYear: number,
  currentEarnings: number,
  throughYear: number,
  realGrowthAfter = 0
): EarningsPoint[] {
  const out: EarningsPoint[] = []
  for (let y = startYear; y <= throughYear; y++) {
    let e: number
    if (y <= currentYear) {
      const t = currentYear === startYear ? 1 : (y - startYear) / (currentYear - startYear)
      e = startEarnings + (currentEarnings - startEarnings) * t
    } else {
      e = currentEarnings * Math.pow(1 + realGrowthAfter, y - currentYear)
    }
    out.push({ year: y, earnings: Math.max(0, e) })
  }
  return out
}

/**
 * Estimate the monthly CPP retirement pension (today's-dollar terms, at `startAge`).
 * Deterministic reconstruction (§5.3): per year compute the pensionable-earnings
 * ratio `min(earnings, YMPE)/YMPE`, apply the general dropout to the weakest years,
 * average the survivors, take 25% (base) of the 5-yr-average YMPE, add a prorated
 * enhancement for post-2019 years, then apply the start-age factor and clamp to max.
 */
export function estimateCpp(
  earnings: EarningsPoint[],
  startAge: number,
  refYear = new Date().getFullYear()
): { monthlyAt65: number; monthlyAtStart: number; ratioAvg: number } {
  if (earnings.length === 0) return { monthlyAt65: 0, monthlyAtStart: 0, ratioAvg: 0 }

  const ratios = earnings.map((p) => Math.min(p.earnings, ympeFor(p.year)) / ympeFor(p.year))
  // General dropout: remove the lowest ~17% of contributory years.
  const dropCount = Math.floor(ratios.length * CPP_DROPOUT_RATE)
  const kept = [...ratios].sort((a, b) => a - b).slice(dropCount)
  const ratioAvg = kept.reduce((s, r) => s + r, 0) / kept.length

  // Average YMPE over the last 5 years (the pension is stated in current dollars).
  const avgYmpe5 =
    [refYear, refYear - 1, refYear - 2, refYear - 3, refYear - 4]
      .map(ympeFor)
      .reduce((s, v) => s + v, 0) / 5

  const baseAnnual = CPP_BASE_REPLACEMENT * ratioAvg * avgYmpe5

  // Enhancement: post-2019 years contribute extra replacement, prorated by how many
  // of a full ~40-yr career were enhanced (caps the young enhancement fairly).
  const enhancedYears = earnings.filter((p) => p.year >= 2019).length
  const enhFraction = Math.min(1, enhancedYears / 40)
  const enhAnnual =
    (CPP_ENHANCED_REPLACEMENT - CPP_BASE_REPLACEMENT) * ratioAvg * avgYmpe5 * enhFraction

  let monthlyAt65 = (baseAnnual + enhAnnual) / 12
  monthlyAt65 = Math.min(monthlyAt65, CPP_MAX_MONTHLY_AT_65)

  const monthlyAtStart = monthlyAt65 * cppStartFactor(startAge)
  return { monthlyAt65, monthlyAtStart, ratioAvg }
}

/* ══════════════════════════════════════════════════════════════════════════
 * OAS — Old Age Security
 * ══════════════════════════════════════════════════════════════════════════ */

/** Full OAS monthly amount at 65 (today's dollars). ⚠️ verify each quarter. */
export const OAS_FULL_MONTHLY = 727.67 // best-known 2026 (65–74 rate)
/** Net-income threshold where the OAS recovery tax (clawback) begins. ⚠️ verify. */
export const OAS_CLAWBACK_THRESHOLD = 93454 // best-known 2026
export const OAS_CLAWBACK_RATE = 0.15
/** OAS residency: full at 40 years in Canada after age 18; prorated below. */
export const OAS_FULL_RESIDENCY_YEARS = 40
export const OAS_MIN_RESIDENCY_YEARS = 10
/** Delay bonus: +0.6%/mo (+7.2%/yr) up to age 70. No early OAS (earliest 65). */
export const OAS_LATE_MONTHLY = 0.006

/** Residency fraction at a given start age from an arrival year (capped at 1). */
export function oasResidencyFraction(arrivalYear: number, startAge: number, birthYear: number): number {
  const startYear = birthYear + startAge
  const yearsInCanadaAfter18 = Math.max(0, startYear - Math.max(arrivalYear, birthYear + 18))
  if (yearsInCanadaAfter18 < OAS_MIN_RESIDENCY_YEARS) return yearsInCanadaAfter18 / OAS_FULL_RESIDENCY_YEARS
  return Math.min(1, yearsInCanadaAfter18 / OAS_FULL_RESIDENCY_YEARS)
}

/** Start-age factor for OAS (65 = 1, +0.6%/mo to 70). */
export function oasStartFactor(startAge: number): number {
  const months = Math.max(0, (startAge - 65) * 12)
  return 1 + months * OAS_LATE_MONTHLY
}

/** Monthly OAS (today's dollars) for a person, before clawback. */
export function estimateOas(arrivalYear: number, startAge: number, birthYear: number): number {
  return OAS_FULL_MONTHLY * oasResidencyFraction(arrivalYear, startAge, birthYear) * oasStartFactor(startAge)
}

/** Annual OAS clawback (recovery tax) given individual net income. */
export function oasClawback(annualOas: number, netIncome: number): number {
  if (netIncome <= OAS_CLAWBACK_THRESHOLD) return 0
  return Math.min(annualOas, (netIncome - OAS_CLAWBACK_THRESHOLD) * OAS_CLAWBACK_RATE)
}

/* ══════════════════════════════════════════════════════════════════════════
 * HOOPP — Healthcare of Ontario Pension Plan (partner's DB pension) §5.4
 * ══════════════════════════════════════════════════════════════════════════ */

/** HOOPP accrual: 1.5% up to the 5-yr-avg YMPE, 2.0% above, per year of service. */
export const HOOPP_LOW_ACCRUAL = 0.015
export const HOOPP_HIGH_ACCRUAL = 0.02
/** Conditional indexing cushion: model 75% of CPI (HOOPP indexing is conditional). */
export const HOOPP_INDEXING_OF_CPI = 0.75
/** Survivor pension fraction (noted in Advanced). */
export const HOOPP_SURVIVOR_FRACTION = 2 / 3

/**
 * Annual HOOPP pension (today's dollars) at an unreduced retirement.
 * Best-5-consecutive-years average earnings × years of service, split at the
 * 5-yr-average YMPE. Early-retirement reduction is applied by the caller via
 * `hooppEarlyFactor`. Bridge benefit to 65 is modeled in the engine (§5.4).
 */
export function estimateHoopp(
  best5AvgEarnings: number,
  yearsOfService: number,
  refYear = new Date().getFullYear()
): number {
  const avgYmpe5 =
    [refYear, refYear - 1, refYear - 2, refYear - 3, refYear - 4]
      .map(ympeFor)
      .reduce((s, v) => s + v, 0) / 5
  const low = Math.min(best5AvgEarnings, avgYmpe5)
  const high = Math.max(0, best5AvgEarnings - avgYmpe5)
  return yearsOfService * (HOOPP_LOW_ACCRUAL * low + HOOPP_HIGH_ACCRUAL * high)
}

/**
 * Early-retirement reduction factor. HOOPP is unreduced at 60 (or the 85 factor:
 * age + service ≥ 85). Before that, a simple ~3%/yr reduction is a reasonable
 * deterministic approximation of HOOPP's early-retirement bridge reduction.
 */
export function hooppEarlyFactor(retireAge: number, yearsOfService: number): number {
  if (retireAge >= 60 || retireAge + yearsOfService >= 85) return 1
  const yearsEarly = 60 - retireAge
  return Math.max(0.5, 1 - 0.03 * yearsEarly)
}

/* ══════════════════════════════════════════════════════════════════════════
 * RRIF — minimum-withdrawal factors (age at start of year → fraction) §5.7
 * ══════════════════════════════════════════════════════════════════════════ */

/** Prescribed RRIF minimum-withdrawal factors. Below 71 the formula is 1/(90−age). */
export const RRIF_MIN_FACTORS: Record<number, number> = {
  71: 0.0528, 72: 0.0540, 73: 0.0553, 74: 0.0567, 75: 0.0582,
  76: 0.0598, 77: 0.0617, 78: 0.0636, 79: 0.0658, 80: 0.0682,
  81: 0.0708, 82: 0.0738, 83: 0.0771, 84: 0.0808, 85: 0.0851,
  86: 0.0899, 87: 0.0955, 88: 0.1021, 89: 0.1099, 90: 0.1192,
  91: 0.1306, 92: 0.1449, 93: 0.1634, 94: 0.1879, 95: 0.2000,
}

/** RRIF minimum-withdrawal factor for the age at the start of the year. */
export function rrifMinFactor(age: number): number {
  if (age < 71) return age >= 90 ? 0.2 : 1 / (90 - age)
  if (age >= 95) return RRIF_MIN_FACTORS[95]
  return RRIF_MIN_FACTORS[age] ?? 1 / Math.max(1, 90 - age)
}

/* ══════════════════════════════════════════════════════════════════════════
 * TFSA / RRSP contribution limits (RRSP dollar cap; TFSA lives in tfsa.ts) §5.6
 * ══════════════════════════════════════════════════════════════════════════ */

/** RRSP is 18% of prior-year earned income, capped at this dollar limit. ⚠️ verify. */
export const RRSP_DOLLAR_LIMIT_2026 = 33810 // best-known 2026
export const RRSP_EARNED_INCOME_RATE = 0.18

/** RRSP contribution room a person generates from a gross salary (before carry-fwd). */
export function rrspRoomFromSalary(grossSalary: number, year = 2026): number {
  const cap = year >= 2026 ? RRSP_DOLLAR_LIMIT_2026 : RRSP_DOLLAR_LIMIT_2026
  return Math.min(grossSalary * RRSP_EARNED_INCOME_RATE, cap)
}

/* ══════════════════════════════════════════════════════════════════════════
 * Ontario + federal income tax (progressive, simplified) §5.7
 * ══════════════════════════════════════════════════════════════════════════ */

type Bracket = { upTo: number; rate: number }

/** Federal 2026 brackets (best-known). Last bracket upTo = Infinity. */
export const FEDERAL_BRACKETS: Bracket[] = [
  { upTo: 57375, rate: 0.145 }, // ⚠️ first-bracket rate reduced to 14.5% (2025 mid-year)
  { upTo: 114750, rate: 0.205 },
  { upTo: 177882, rate: 0.26 },
  { upTo: 253414, rate: 0.29 },
  { upTo: Infinity, rate: 0.33 },
]

/** Ontario 2026 brackets (best-known, before surtax which we omit as simplified). */
export const ONTARIO_BRACKETS: Bracket[] = [
  { upTo: 52886, rate: 0.0505 },
  { upTo: 105775, rate: 0.0915 },
  { upTo: 150000, rate: 0.1116 },
  { upTo: 220000, rate: 0.1216 },
  { upTo: Infinity, rate: 0.1316 },
]

export const FEDERAL_BPA = 16129 // basic personal amount (approx, high-income phased)
export const ONTARIO_BPA = 12747
/** Age amount (65+) and pension income amount — modeled as credits at lowest rate. */
export const FEDERAL_AGE_AMOUNT = 9028
export const FEDERAL_PENSION_AMOUNT = 2000

function taxFromBrackets(income: number, brackets: Bracket[]): number {
  let tax = 0
  let prev = 0
  for (const b of brackets) {
    if (income <= prev) break
    const slice = Math.min(income, b.upTo) - prev
    tax += slice * b.rate
    prev = b.upTo
  }
  return tax
}

/**
 * Combined Ontario + federal income tax on `taxable`, netting the basic personal
 * amount and (when `age65` / `hasPensionIncome`) the age + pension credits at the
 * lowest bracket rate. Simplified — no surtax, no dividend credits (§10).
 */
export function ontarioIncomeTax(
  taxable: number,
  opts: { age65?: boolean; hasPensionIncome?: boolean } = {}
): number {
  if (taxable <= 0) return 0
  const fedLow = FEDERAL_BRACKETS[0].rate
  const onLow = ONTARIO_BRACKETS[0].rate

  let fedCredits = FEDERAL_BPA
  let onCredits = ONTARIO_BPA
  if (opts.age65) {
    fedCredits += FEDERAL_AGE_AMOUNT
    onCredits += FEDERAL_AGE_AMOUNT * 0.5 // Ontario age amount is smaller; approx
  }
  if (opts.hasPensionIncome) {
    fedCredits += FEDERAL_PENSION_AMOUNT
    onCredits += FEDERAL_PENSION_AMOUNT
  }

  const fed = Math.max(0, taxFromBrackets(taxable, FEDERAL_BRACKETS) - fedCredits * fedLow)
  const on = Math.max(0, taxFromBrackets(taxable, ONTARIO_BRACKETS) - onCredits * onLow)
  return fed + on
}

/** Reverse lookup: gross income whose after-tax ≈ `netTarget` (for salary gross-up). */
export function grossUpFromNet(netTarget: number, opts?: { age65?: boolean }): number {
  if (netTarget <= 0) return 0
  // Monotonic; bisection on gross.
  let lo = netTarget
  let hi = netTarget * 2.2 + 20000
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    const net = mid - ontarioIncomeTax(mid, opts)
    if (net > netTarget) hi = mid
    else lo = mid
  }
  return Math.round((lo + hi) / 2)
}

/**
 * Household tax with pension income splitting between two spouses (§5.7). Eligible
 * pension income (RRIF/DB after 65) can be split up to 50% to equalize brackets;
 * we compute the optimal split by trying transfers and taking the minimum total.
 */
export function householdTaxWithSplitting(
  spouseAIncome: number,
  spouseBIncome: number,
  splittablePension: number,
  opts: { aAge65?: boolean; bAge65?: boolean } = {}
): number {
  const noSplit =
    ontarioIncomeTax(spouseAIncome, { age65: opts.aAge65, hasPensionIncome: splittablePension > 0 }) +
    ontarioIncomeTax(spouseBIncome, { age65: opts.bAge65 })
  let best = noSplit
  // Try splitting up to 50% of eligible pension from A to B in 10% steps.
  for (let f = 0.1; f <= 0.5001; f += 0.1) {
    const move = splittablePension * f
    const t =
      ontarioIncomeTax(spouseAIncome - move, { age65: opts.aAge65, hasPensionIncome: true }) +
      ontarioIncomeTax(spouseBIncome + move, { age65: opts.bAge65, hasPensionIncome: true })
    if (t < best) best = t
  }
  return best
}

/* ══════════════════════════════════════════════════════════════════════════
 * RDSP — grants for the DTC-approved son §6
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Canada Disability Savings Grant (CDSG). At family income below the threshold:
 * 300% on the first $500 and 200% on the next $1,000 (=$3,500/yr max match);
 * above the threshold: 100% on the first $1,000 (=$1,000/yr). Carry-forward lets
 * unused grant room (back to DTC eligibility, up to 10 years) be claimed, capped
 * at $10,500 of grant per year. Lifetime CDSG cap is $70,000.  ⚠️ verify amounts.
 */
export const RDSP = {
  incomeThreshold: 111733, // family net income cut for the high match tier ⚠️ verify
  lifetimeGrantCap: 70000,
  annualGrantCatchupCap: 10500,
  // Canada Disability Savings Bond (income-tested; likely $0 for this family).
  bondIncomeThreshold: 36502, // ⚠️ verify
  bondMaxAnnual: 1000,
  bondLifetimeCap: 20000,
} as const

/** CDSG grant earned on a contribution for one year, honoring the high/low tier. */
export function rdspGrantForContribution(contribution: number, highTier: boolean): number {
  if (contribution <= 0) return 0
  if (highTier) {
    const first = Math.min(contribution, 500) * 3
    const next = Math.min(Math.max(0, contribution - 500), 1000) * 2
    return first + next // max $3,500 at $1,500 contribution
  }
  return Math.min(contribution, 1000) * 1 // max $1,000 at $1,000 contribution
}

/* ══════════════════════════════════════════════════════════════════════════
 * ODSP + Canada Disability Benefit — the son's adult income §6
 * ══════════════════════════════════════════════════════════════════════════ */

/** ODSP single basic needs + shelter, monthly (today's dollars). ⚠️ verify. */
export const ODSP_SINGLE_MONTHLY = 1368
/** Canada Disability Benefit (2025 rules), monthly. ⚠️ verify. */
export const CANADA_DISABILITY_BENEFIT_MONTHLY = 200
/** Governments under-index disability benefits — grow at half of inflation (§6). */
export const DISABILITY_BENEFIT_INDEXING = 0.5
