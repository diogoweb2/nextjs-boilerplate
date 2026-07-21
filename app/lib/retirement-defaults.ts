/**
 * The consultant's default numbers — `computeDefaults(derived) → RetirementParams`
 * (RETIREMENT_PLAN.md §4, §5.1, §8). Engine defaults are computed from the derived
 * inputs on every load, so they improve over time and auto-adjust to new imports;
 * a saved override in `retirement_settings` pins a value until "Restore defaults".
 *
 * The lifestyle tiers are derived from THEIR real spending (the app's superpower),
 * not a generic replacement-ratio.  Pure & deterministic (no AI).
 */
import type { RetirementInputs, RetirementParams, LifestyleTier } from './retirement'

/** Category spend map: trailing-12-complete-month monthly average per category. */
export type CategoryAverages = Record<string, number>

export type DerivedForDefaults = {
  inputs: RetirementInputs
  /** Monthly category averages, today's dollars (from analytics). */
  categoryMonthly: CategoryAverages
  /** The mortgage-portion of the Home category (dies at payoff). */
  mortgagePortionMonthly: number
}

const S = (m: CategoryAverages, cat: string) => m[cat] ?? 0

/**
 * Derive the three lifestyle tiers (today's-dollar monthly targets) from real
 * category averages (§4). Every tier is also an override target the owner can nudge.
 */
export function deriveTiers(d: DerivedForDefaults): Record<LifestyleTier, number> {
  const m = d.categoryMonthly
  const homeNoMortgage = Math.max(0, S(m, 'Home') - d.mortgagePortionMonthly)

  // Essentials — "fine, but no travel". One car, half the dining/entertainment.
  const essentials =
    homeNoMortgage +
    S(m, 'Groceries') +
    S(m, 'Health') +
    S(m, 'Dental') +
    S(m, 'Cars') * 0.6 + // ≈ one car
    S(m, 'Subscriptions') +
    S(m, 'Transport') +
    (S(m, 'Dining') + S(m, 'Entertainment')) * 0.5

  // Today's Life — current lifestyle minus what retirement removes.
  const total = Object.values(m).reduce((s, v) => s + v, 0)
  const todayLife = Math.max(
    essentials,
    total -
      d.mortgagePortionMonthly -
      S(m, 'Kids') -
      S(m, 'Investment') -
      S(m, 'Cars') * 0.15 /* commute share */
  )

  // Snowbird Dream — Today's Life restructured for 6 months in Brazil + trips.
  // Half the year the variable categories run at a Brazil multiplier; plus trips.
  const brazilMultiplier = 0.55
  const variable = S(m, 'Groceries') + S(m, 'Dining') + S(m, 'Entertainment') + S(m, 'Transport')
  const brazilSavings = variable * 0.5 * (1 - brazilMultiplier)
  const brazilHousing = 1400 * 0.5 // 6 months rent, CAD-equiv
  const tripsMonthly = (4000 + 8000) / 12 // 2 Brazil round-trips + 1 Europe/yr
  const snowbird = todayLife - brazilSavings + brazilHousing + tripsMonthly

  return {
    essentials: round2(essentials),
    today: round2(todayLife),
    snowbird: round2(snowbird),
  }
}

/** The full consultant default parameter set. */
export function computeDefaults(d: DerivedForDefaults): RetirementParams {
  const tierMonthly = deriveTiers(d)

  return {
    // Basic — default retirement age is set by the caller to the recommended age;
    // here we seed a sensible starting point (58), the UI replaces with recommended.
    retirementAge: 58,
    partnerRetirementAgeOffset: 0,
    lifestyle: 'snowbird', // the motivating default (§2.1)
    tierMonthly,

    inflation: 0.025, // BoC target-band midpoint (§5.1)
    equityReturn: 0.066, // FP Canada 2025 projection-standard (§5.1)
    bondReturn: 0.036,
    fees: 0.0025,

    postMortgageRedirect: 0.5, // a deliberately human default (§5.2)
    extraMonthlySavings: 0,
    employerMatchRate: 0.03, // owner to confirm from a pay stub (§1)

    selfCppAge: 65,
    partnerCppAge: 65,
    selfOasAge: 65,
    partnerOasAge: 65,

    hooppServiceStartYear: 2021, // "few years there" — owner confirms (§5.4)
    hooppIndexingOfCpi: 0.75,

    glideBase: 110, // 110 − age in equities (§5.8)
    glideEquityFloor: 0.3,
    deriskStartYearsBeforeRetire: 7,

    tfsaFloorMonths: 6,
    tfsaFloorMonthsPostMortgage: 3,

    sellHouse: false, // keep the house by default (also the son's home, §6)
    sellHouseAge: 75,
    houseAppreciation: 0.035, // Toronto long-run avg (§1)
    sellHouseReplacement: 'condo', // selling is never free — model the next home
    downsizeFraction: 0.55, // a Toronto condo ≈ 55% of the house's sale value
    condoFeesMonthly: 700,
    rentMonthly: 2800,

    crisisEnabled: true,
    crisisEveryYears: 9, // ≈ a −30% bear every 9 years (§5.9)
    crisisEquityDrop: 0.3,
    crisisRecoveryYears: 3,

    rdspOpen: false, // action item #1 until done (§6)
    rdspAnnualContribution: 1500,

    planToAge: 95,
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
