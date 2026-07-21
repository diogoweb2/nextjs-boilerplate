/**
 * THE RETIREMENT ENGINE — pure, deterministic, db-free (RETIREMENT_PLAN.md §5).
 *
 * `buildRetirementPlan(inputs, params) → PlanResult` runs one year-by-year
 * simulation from now to age 95 in nominal dollars, deflating for display. Two
 * passes: a baseline and a historical-crisis pass (the shaded cone). Everything is
 * a pure function of (derived inputs, params) so the client recomputes it live on
 * every slider drag. NO AI, NO external data, NO randomness (crises are placed
 * deterministically, not Monte-Carlo'd).
 *
 * Money conventions:
 *  - Internally nominal (grows with inflation). `deflate(value, year)` converts to
 *    today's dollars for display. All headline outputs are today's dollars.
 *  - "Investable capital" = RRSP + TFSA-above-floor + DC + non-reg. Excludes the
 *    house, RESP (kid's education), and RDSP (the son's money).
 */
import {
  estimateCpp,
  estimateOas,
  estimateHoopp,
  hooppEarlyFactor,
  reconstructEarnings,
  rrifMinFactor,
  householdTaxWithSplitting,
} from './canada-rules'

/* ─────────────────────────── Inputs (derived) ─────────────────────────── */

export type Person = {
  birthYear: number
  /** Current gross annual salary (derived from payroll; gross for CPP/HOOPP). */
  grossSalary: number
  /** Real salary growth (0 = flat below inflation; the owner's default for self). */
  realSalaryGrowth: number
  /** First full-time Canadian year (for CPP reconstruction). */
  careerStartYear: number
  /** Salary in the start year (for CPP reconstruction). */
  careerStartSalary: number
  /** Year they immigrated / became resident (for OAS residency). */
  arrivalYear: number
}

export type RetirementInputs = {
  /** Simulation "now". */
  currentYear: number
  self: Person
  partner: Person
  /** RRSP balances today. */
  selfRrsp: number
  partnerRrsp: number
  /** TFSA total market value today (both spouses). */
  tfsaTotal: number
  /** Employer DC / matched RRSP balance today (self). */
  dcBalance: number
  /** Current equity fraction of the investable portfolio (from iTrade buckets). */
  currentEquityFraction: number
  /** House value today. */
  houseValue: number
  /** Calendar year the mortgage is paid off (from projectMortgage). */
  mortgagePayoffYear: number
  /** Monthly mortgage payment that frees up at payoff (today's dollars). */
  monthlyMortgagePayment: number
  /** Current monthly lifestyle spend baseline (today's dollars, from analytics). */
  currentMonthlySpend: number
  /** Current monthly investing/savings flow (today's dollars) split RRSP/TFSA. */
  monthlyRrspContribution: number
  monthlyTfsaContribution: number
}

/* ─────────────────────────── Parameters ─────────────────────────── */

export type LifestyleTier = 'essentials' | 'today' | 'snowbird'

export type RetirementParams = {
  /** Owner's retirement age (partner retires the same calendar year by default). */
  retirementAge: number
  partnerRetirementAgeOffset: number // partner age = self retire year mapped; offset in years
  lifestyle: LifestyleTier
  /** Monthly lifestyle target per tier (today's dollars) — overridable. */
  tierMonthly: Record<LifestyleTier, number>

  inflation: number
  equityReturn: number
  bondReturn: number
  fees: number

  /** Fraction of freed-up mortgage payment redirected to savings after payoff. */
  postMortgageRedirect: number
  /** Extra monthly savings on top of observed flow (today's dollars). */
  extraMonthlySavings: number
  /** Employer RRSP match as a fraction of the owner's gross salary (§1). */
  employerMatchRate: number

  /** CPP/OAS start ages per spouse. */
  selfCppAge: number
  partnerCppAge: number
  selfOasAge: number
  partnerOasAge: number

  /** HOOPP (partner). */
  hooppServiceStartYear: number
  hooppIndexingOfCpi: number

  /** Glidepath: equity% = glideBase − age, floored at glideFloor, at retirement. */
  glideBase: number
  glideEquityFloor: number
  deriskStartYearsBeforeRetire: number

  /** TFSA emergency floor in months of the Essentials tier. */
  tfsaFloorMonths: number
  tfsaFloorMonthsPostMortgage: number

  /** House. Selling is never free: a replacement home is always modeled. */
  sellHouse: boolean
  sellHouseAge: number
  houseAppreciation: number
  /** What replaces the house after selling: buy a smaller condo, or rent. */
  sellHouseReplacement: 'condo' | 'rent'
  /** Condo mode: fraction of the sale proceeds spent on the replacement condo. */
  downsizeFraction: number
  /** Condo mode: monthly maintenance fees added to spend from the sale (today's $). */
  condoFeesMonthly: number
  /** Rent mode: monthly rent added to spend from the sale (today's $). */
  rentMonthly: number

  /** Crises (Advanced). */
  crisisEnabled: boolean
  crisisEveryYears: number
  crisisEquityDrop: number
  crisisRecoveryYears: number

  /** RDSP (son). */
  rdspOpen: boolean
  rdspAnnualContribution: number

  /** Plan horizon (longevity). */
  planToAge: number
}

/* ─────────────────────────── Result ─────────────────────────── */

export type YearRow = {
  year: number
  selfAge: number
  partnerAge: number
  retired: boolean
  /** Investable capital, today's dollars. */
  capitalReal: number
  /** Required-capital glidepath at this year, today's dollars. */
  neededReal: number
  /** Guaranteed monthly income this year, today's dollars. */
  guaranteedMonthlyReal: number
  /** Total monthly income funded this year, today's dollars. */
  fundedMonthlyReal: number
  /** RRSP/RRIF draw this year, today's dollars (0 while accumulating). */
  rrspDrawReal: number
  tfsaDrawReal: number
  equityFraction: number
}

export type IncomeLayer = {
  key: string
  label: string
  monthlyReal: number
}

export type PlanResult = {
  retirementYear: number
  selfRetireAge: number
  partnerRetireAge: number
  lifestyleMonthlyReal: number
  /** Monthly income at retirement, today's dollars. */
  incomeAtRetirementReal: number
  /** Structural breakdown of that income (waterfall). */
  incomeLayers: IncomeLayer[]
  onTrack: boolean
  /** Whether the baseline capital lasts to plan end at the CHOSEN retirement age
   *  (the same lifetime test the consultant recommendation uses). Distinct from
   *  onTrack, which additionally requires a non-negative year-one income gap. */
  survivesToPlanEnd: boolean
  /** Signed monthly surplus/shortfall at retirement, today's dollars. This is a
   *  first-years snapshot (before all pensions switch on); a negative value here
   *  can still coexist with survivesToPlanEnd because later CPP/OAS backfill it. */
  monthlyGapReal: number
  /** Earliest age (given the params) that funds the selected lifestyle to plan end. */
  recommendedRetireAge: number | null
  /** Year-by-year baseline path. */
  rows: YearRow[]
  /** Crisis-pass capital path (the cone's lower edge), today's dollars per year. */
  crisisCapitalReal: number[]
  /** Whether the plan survives the crisis pass (never runs out before plan end). */
  survivesCrisis: boolean
  /** Ahead/behind the needed curve at the chosen retirement age, today's dollars. */
  capitalVsNeededAtRetireReal: number
  hooppAnnualReal: number
  selfCppMonthlyReal: number
  partnerCppMonthlyReal: number
  /** Per-phase decumulation instructions ("sell $X/mo from RRSP, ages A–B"). */
  drawPhases: { fromAge: number; toAge: number; rrspMonthly: number; tfsaMonthly: number }[]
}

/* ─────────────────────────── Helpers ─────────────────────────── */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Target equity fraction on the glidepath for a given age (accumulation → retire). */
export function glideEquityFraction(age: number, p: RetirementParams): number {
  const raw = (p.glideBase - age) / 100
  return clamp(raw, p.glideEquityFloor, 0.95)
}

/** Blended nominal return for a given equity fraction, net of fees. */
function blendedReturn(equityFraction: number, p: RetirementParams): number {
  const gross = equityFraction * p.equityReturn + (1 - equityFraction) * p.bondReturn
  return gross - p.fees
}

/* ─────────────────────────── The engine ─────────────────────────── */

/** Effective tax retained on registered withdrawals (≈ blended RRSP 22% / TFSA 0%). */
const WITHDRAWAL_NET_FACTOR = 0.85

export function buildRetirementPlan(
  inputs: RetirementInputs,
  params: RetirementParams
): PlanResult {
  // CPP for one spouse: earnings stop at retirement (no contributions once retired),
  // then zero-earning years run to the CPP start age — both ends of the contributory
  // period are padded with zeros, exactly as CPP counts them.
  const cppMonthly = (person: Person, cppAge: number, retirementYr: number): number => {
    const cppStartYear = person.birthYear + cppAge
    const lastEarningYear = Math.max(person.careerStartYear, Math.min(cppStartYear, retirementYr))
    const earnings = reconstructEarnings(
      person.careerStartYear,
      person.careerStartSalary,
      inputs.currentYear,
      person.grossSalary,
      lastEarningYear,
      person.realSalaryGrowth
    )
    for (let y = lastEarningYear + 1; y <= cppStartYear; y++) earnings.push({ year: y, earnings: 0 })
    return estimateCpp(earnings, cppAge, person.birthYear).monthlyAtStart
  }

  // All guaranteed-income building blocks for a given retirement age (today's $).
  // CPP and HOOPP both depend on the retirement age (earnings/service stop), so the
  // recommended-age probe must rebuild this per candidate age.
  const makeConst = (retireAge: number, crisis: boolean): SimConst => {
    const retirementYr = inputs.self.birthYear + retireAge
    const partnerRetAge = retirementYr - inputs.partner.birthYear + params.partnerRetirementAgeOffset
    const selfCpp = cppMonthly(inputs.self, params.selfCppAge, retirementYr)
    const partnerCpp = cppMonthly(inputs.partner, params.partnerCppAge, retirementYr)
    const selfOas = estimateOas(inputs.self.arrivalYear, params.selfOasAge, inputs.self.birthYear)
    const partnerOas = estimateOas(inputs.partner.arrivalYear, params.partnerOasAge, inputs.partner.birthYear)
    // HOOPP: best-5-year avg ≈ current gross (partner grows with inflation → flat real).
    const hooppService = Math.max(0, retirementYr - params.hooppServiceStartYear)
    const hooppAnnual =
      estimateHoopp(inputs.partner.grossSalary, hooppService) *
      hooppEarlyFactor(partnerRetAge, hooppService)
    // Steady-state household tax once everything is in pay (HOOPP is the partner's
    // splittable pension income).
    const steadyTaxAnnual = householdTaxWithSplitting(
      hooppAnnual + (partnerCpp + partnerOas) * 12,
      (selfCpp + selfOas) * 12,
      hooppAnnual,
      { aAge65: true, bAge65: true }
    )
    return {
      retirementYear: retirementYr,
      partnerRetireAge: partnerRetAge,
      selfCpp,
      partnerCpp,
      selfOas,
      partnerOas,
      hooppAnnual,
      steadyTaxAnnual,
      lifestyleMonthly: params.tierMonthly[params.lifestyle],
      essentialsMonthly: params.tierMonthly.essentials,
      partnerAgeGap: inputs.partner.birthYear - inputs.self.birthYear,
      annualSavingsRealToday:
        (inputs.monthlyRrspContribution + inputs.monthlyTfsaContribution + params.extraMonthlySavings) * 12 +
        inputs.self.grossSalary * params.employerMatchRate,
      crisis,
    }
  }

  const c = makeConst(params.retirementAge, false)
  const { retirementYear, partnerRetireAge, selfCpp, partnerCpp, selfOas, partnerOas, hooppAnnual } = c

  const lifestyleMonthly = c.lifestyleMonthly
  const sim = runSimulation(inputs, params, c)
  const crisisSim = params.crisisEnabled
    ? runSimulation(inputs, params, { ...c, crisis: true })
    : sim

  // Steady-state income waterfall (today's dollars). CPP/OAS are shown at their
  // chosen start ages even when retirement comes earlier — they WILL be part of
  // retirement income; before they start, savings withdrawals bridge the gap
  // (that bridge is visible in drawPhases, not hidden from the verdict).
  const retireRow = sim.rows.find((r) => r.year === retirementYear) ?? sim.rows[sim.rows.length - 1]
  const fromAges = (a: number, b: number) => (a === b ? `from ${a}` : `from ${a}/${b}`)
  const layers: IncomeLayer[] = [
    { key: 'hoopp', label: 'Her hospital pension (HOOPP)', monthlyReal: hooppAnnual / 12 },
    {
      key: 'cpp',
      label: `Government pensions (CPP × 2, ${fromAges(params.selfCppAge, params.partnerCppAge)})`,
      monthlyReal: selfCpp + partnerCpp,
    },
    {
      key: 'oas',
      label: `Old Age Security (OAS × 2, ${fromAges(params.selfOasAge, params.partnerOasAge)})`,
      monthlyReal: selfOas + partnerOas,
    },
  ]
  const guaranteedMonthly = layers.reduce((s, l) => s + l.monthlyReal, 0)
  // The savings layer is the SUSTAINABLE draw the portfolio can support, not the
  // (front-loaded) first-year meltdown. Approximate it as a level real annuity of
  // the retirement-year capital over the remaining years — this is what makes the
  // waterfall represent a durable income, and keeps early retirement from looking
  // artificially rich (an early first-year RRSP meltdown is not permanent income).
  const yearsInRetirement = Math.max(1, params.planToAge - params.retirementAge)
  const realReturn = 0.03 // conservative ~3% real for the annuity
  const annuityFactor = realReturn / (1 - Math.pow(1 + realReturn, -yearsInRetirement))
  const sustainableSavingsMonthly = (retireRow.capitalReal * annuityFactor) / 12
  layers.push({ key: 'savings', label: 'Your savings (RRSP/TFSA draw)', monthlyReal: sustainableSavingsMonthly })

  // The verdict is AFTER tax — lifestyle targets are spending (net) numbers, so
  // comparing them against gross income would flatter the plan.
  const taxMonthly =
    c.steadyTaxAnnual / 12 + sustainableSavingsMonthly * (1 - WITHDRAWAL_NET_FACTOR)
  layers.push({ key: 'tax', label: 'Income tax (est.)', monthlyReal: -taxMonthly })

  const incomeAtRetirement = guaranteedMonthly + sustainableSavingsMonthly - taxMonthly
  const monthlyGap = incomeAtRetirement - lifestyleMonthly

  // Recommended age: earliest 50–70 where the plan funds the lifestyle to the end.
  // Each probe rebuilds CPP/HOOPP for that age (earlier retirement = smaller both).
  let recommended: number | null = null
  for (let age = 50; age <= 70; age++) {
    const probe = runSimulation(inputs, { ...params, retirementAge: age }, makeConst(age, false))
    if (probe.survives) {
      recommended = age
      break
    }
  }

  const capVsNeeded = retireRow.capitalReal - retireRow.neededReal

  return {
    retirementYear,
    selfRetireAge: params.retirementAge,
    partnerRetireAge,
    lifestyleMonthlyReal: lifestyleMonthly,
    incomeAtRetirementReal: incomeAtRetirement,
    incomeLayers: layers,
    onTrack: monthlyGap >= 0 && sim.survives,
    survivesToPlanEnd: sim.survives,
    monthlyGapReal: monthlyGap,
    recommendedRetireAge: recommended,
    rows: sim.rows,
    crisisCapitalReal: crisisSim.rows.map((r) => r.capitalReal),
    survivesCrisis: crisisSim.survives,
    capitalVsNeededAtRetireReal: capVsNeeded,
    hooppAnnualReal: hooppAnnual,
    selfCppMonthlyReal: selfCpp,
    partnerCppMonthlyReal: partnerCpp,
    drawPhases: sim.drawPhases,
  }
}

/* ─────────────────────────── Simulation core ─────────────────────────── */

type SimConst = {
  retirementYear: number
  partnerRetireAge: number
  selfCpp: number
  partnerCpp: number
  selfOas: number
  partnerOas: number
  hooppAnnual: number
  /** Household tax on the steady-state guaranteed income (today's $, annual). */
  steadyTaxAnnual: number
  lifestyleMonthly: number
  essentialsMonthly: number
  /** partner.birthYear − self.birthYear (to map self age → partner age). */
  partnerAgeGap: number
  /** Current real annual savings incl. employer match (for the needed-curve). */
  annualSavingsRealToday: number
  crisis: boolean
}

function runSimulation(
  inputs: RetirementInputs,
  p: RetirementParams,
  c: SimConst
): { rows: YearRow[]; survives: boolean; drawPhases: PlanResult['drawPhases'] } {
  const rows: YearRow[] = []
  const startYear = inputs.currentYear
  const endYear = inputs.self.birthYear + p.planToAge

  // Nominal balances.
  let rrsp = inputs.selfRrsp + inputs.partnerRrsp
  let tfsa = inputs.tfsaTotal
  let dc = inputs.dcBalance
  let nonReg = 0

  // Deterministic crisis years: one the year before retirement, the rest spaced.
  const crisisYears = new Set<number>()
  if (c.crisis && p.crisisEnabled) {
    const horizon = endYear - startYear
    const n = Math.max(1, Math.floor(horizon / p.crisisEveryYears))
    crisisYears.add(c.retirementYear - 1)
    for (let i = 1; i < n; i++) {
      crisisYears.add(startYear + Math.round((i * horizon) / n))
    }
  }

  const inflate = (todaysDollars: number, year: number) =>
    todaysDollars * Math.pow(1 + p.inflation, year - startYear)
  const deflate = (nominal: number, year: number) =>
    nominal / Math.pow(1 + p.inflation, year - startYear)

  let survives = true
  const drawSamples: { age: number; rrspMonthly: number; tfsaMonthly: number }[] = []

  for (let year = startYear; year <= endYear; year++) {
    const selfAge = year - inputs.self.birthYear
    const partnerAge = year - inputs.partner.birthYear
    const retired = year >= c.retirementYear

    // ── Asset mix (glidepath), start de-risking N years before retirement ──
    const deriskStart = c.retirementYear - p.deriskStartYearsBeforeRetire
    let equityFraction: number
    if (year < deriskStart) {
      equityFraction = glideEquityFraction(selfAge, p)
    } else {
      // Linear glide from the pre-derisk mix down to 40% at retirement, floored.
      const yrsToRetire = Math.max(0, c.retirementYear - year)
      const startMix = glideEquityFraction(inputs.self.birthYear + (p.retirementAge - p.deriskStartYearsBeforeRetire), p)
      const t = p.deriskStartYearsBeforeRetire === 0 ? 1 : 1 - yrsToRetire / p.deriskStartYearsBeforeRetire
      equityFraction = clamp(startMix + (0.4 - startMix) * t, p.glideEquityFloor, startMix)
    }
    let ret = blendedReturn(equityFraction, p)
    if (crisisYears.has(year)) {
      ret = equityFraction * (-p.crisisEquityDrop) + (1 - equityFraction) * (-0.05)
    } else {
      // Recovery years after a crash: equities rebound (~+12% nominal, §5.9).
      for (const cy of crisisYears) {
        if (year > cy && year <= cy + p.crisisRecoveryYears) {
          ret = equityFraction * 0.12 + (1 - equityFraction) * p.bondReturn - p.fees
          break
        }
      }
    }

    // TFSA emergency floor (nominal): flips lower after the mortgage is paid off.
    const floorMonths = year >= inputs.mortgagePayoffYear ? p.tfsaFloorMonthsPostMortgage : p.tfsaFloorMonths
    const tfsaFloorNominal = inflate(c.essentialsMonthly * floorMonths, year)

    let rrspDrawReal = 0
    let tfsaDrawReal = 0

    if (!retired) {
      // ── Accumulation ──
      // Grow balances, then add contributions.
      rrsp *= 1 + ret
      tfsa *= 1 + ret
      dc *= 1 + ret
      nonReg *= 1 + ret

      const mortgageFreed = year > inputs.mortgagePayoffYear
        ? inputs.monthlyMortgagePayment * 12 * p.postMortgageRedirect
        : 0
      const annualRrsp = inflate(
        inputs.monthlyRrspContribution * 12 + inputs.self.grossSalary * p.employerMatchRate,
        year
      ) + inflate(mortgageFreed * 0.6, year)
      const annualTfsa = inflate(
        inputs.monthlyTfsaContribution * 12 + p.extraMonthlySavings * 12,
        year
      ) + inflate(mortgageFreed * 0.4, year)
      rrsp += annualRrsp
      tfsa += annualTfsa
    } else {
      // ── Decumulation: fund the (inflated) lifestyle target ──
      let targetAnnual = inflate(c.lifestyleMonthly * 12, year)

      // Selling the house is never free: from the sale on, replacement housing
      // (condo fees or rent) is added to the year's spend…
      const houseSold = p.sellHouse && selfAge >= p.sellHouseAge
      if (houseSold) {
        const housingMonthly =
          p.sellHouseReplacement === 'rent' ? p.rentMonthly : p.condoFeesMonthly
        targetAnnual += inflate(housingMonthly * 12, year)
      }
      // …and in the sale year, only the proceeds NET of the replacement condo are
      // invested (renting invests everything — the rent line above pays for it).
      // Proceeds land before this year's draws so they can fund it.
      if (p.sellHouse && selfAge === p.sellHouseAge) {
        const houseNominal = inputs.houseValue * Math.pow(1 + p.houseAppreciation, year - startYear)
        nonReg +=
          p.sellHouseReplacement === 'rent'
            ? houseNominal
            : houseNominal * (1 - p.downsizeFraction)
      }

      // 1. Guaranteed income first.
      // HOOPP accrues on a salary that keeps pace with inflation until retirement,
      // so it's fully indexed to the retirement year; the 75%-of-CPI conditional-
      // indexing cushion only applies to years IN retirement.
      const bridge = partnerAge < 65 ? c.hooppAnnual * 0.15 : 0
      const hooppReal =
        c.hooppAnnual *
          Math.pow(1 + p.inflation, c.retirementYear - startYear) *
          Math.pow(1 + p.inflation * p.hooppIndexingOfCpi, Math.max(0, year - c.retirementYear)) +
        inflate(bridge, year)
      const cppSelf = selfAge >= p.selfCppAge ? inflate(c.selfCpp * 12, year) : 0
      const cppPartner = partnerAge >= p.partnerCppAge ? inflate(c.partnerCpp * 12, year) : 0
      const oasSelf = selfAge >= p.selfOasAge ? inflate(c.selfOas * 12, year) : 0
      const oasPartner = partnerAge >= p.partnerOasAge ? inflate(c.partnerOas * 12, year) : 0
      const guaranteedGross = hooppReal + cppSelf + cppPartner + oasSelf + oasPartner

      // Tax on guaranteed income (with pension splitting between spouses).
      const guaranteedTax = householdTaxWithSplitting(
        deflate(hooppReal + cppSelf + oasSelf, year),
        deflate(cppPartner + oasPartner, year),
        deflate(hooppReal, year),
        { aAge65: selfAge >= 65, bAge65: partnerAge >= 65 }
      ) * Math.pow(1 + p.inflation, year - startYear)

      let need = targetAnnual - (guaranteedGross - guaranteedTax)

      // Grow balances first (returns apply on the year's average roughly at start).
      rrsp *= 1 + ret
      tfsa *= 1 + ret
      dc *= 1 + ret
      nonReg *= 1 + ret

      // 2. RRSP/RRIF meltdown. Age 71+ enforce the RRIF minimum.
      let rrspDraw = 0
      if (need > 0 && rrsp + dc > 0) {
        const pool = rrsp + dc
        // Gross up for tax at an approximate marginal rate on withdrawals.
        const grossNeeded = need / 0.78 // ≈ 22% effective on the withdrawal
        rrspDraw = Math.min(pool, grossNeeded)
      }
      if (selfAge >= 71) {
        const rrifMin = (rrsp + dc) * rrifMinFactor(selfAge)
        rrspDraw = Math.max(rrspDraw, rrifMin)
      }
      // Deduct from RRSP then DC.
      const fromRrsp = Math.min(rrsp, rrspDraw)
      rrsp -= fromRrsp
      dc -= Math.min(dc, rrspDraw - fromRrsp)
      const rrspNet = rrspDraw * 0.78
      need -= rrspNet
      // Forced RRIF minimum above the year's need: the excess doesn't vanish —
      // it's reinvested (TFSA room first in reality; non-reg is close enough here).
      if (need < 0) {
        nonReg += -need
        need = 0
      }

      // 3. TFSA last (and the crisis buffer — draw TFSA in a crash year).
      // In a pinch the emergency floor can be dipped, but never below zero.
      let tfsaDraw = 0
      if (need > 0) {
        tfsaDraw = Math.min(tfsa, need)
        tfsa -= tfsaDraw
        need -= tfsaDraw
      }

      // 4. Non-reg (house proceeds land here).
      if (need > 0 && nonReg > 0) {
        const d = Math.min(nonReg, need)
        nonReg -= d
        need -= d
      }

      if (need > 1) survives = false // couldn't fund the lifestyle this year

      rrspDrawReal = deflate(rrspNet, year)
      tfsaDrawReal = deflate(tfsaDraw, year)
      drawSamples.push({ age: selfAge, rrspMonthly: rrspDrawReal / 12, tfsaMonthly: tfsaDrawReal / 12 })
    }

    // Investable capital (today's dollars): RRSP + TFSA-above-floor + DC + non-reg.
    const capitalNominal = rrsp + Math.max(0, tfsa - tfsaFloorNominal) + dc + nonReg
    const capitalReal = deflate(capitalNominal, year)

    // Needed-capital glidepath: capital that, with guaranteed income, funds the
    // lifestyle to plan end. Approx via the annuity-factor of the remaining gap.
    const neededReal = requiredCapital(p, c, selfAge)

    // Guaranteed monthly actually in pay this year (today's dollars).
    const guaranteedMonthlyReal = !retired
      ? 0
      : c.hooppAnnual / 12 +
        (selfAge >= p.selfCppAge ? c.selfCpp : 0) +
        (partnerAge >= p.partnerCppAge ? c.partnerCpp : 0) +
        (selfAge >= p.selfOasAge ? c.selfOas : 0) +
        (partnerAge >= p.partnerOasAge ? c.partnerOas : 0)

    rows.push({
      year,
      selfAge,
      partnerAge,
      retired,
      capitalReal,
      neededReal,
      guaranteedMonthlyReal,
      fundedMonthlyReal: retired ? c.lifestyleMonthly : 0,
      rrspDrawReal,
      tfsaDrawReal,
      equityFraction,
    })
  }

  return { rows, survives, drawPhases: summarizeDrawPhases(drawSamples) }
}

/**
 * Required investable capital at a given age — the chart's dashed "where you
 * should be" line (§2.3).
 *
 * At/after the retirement age: the present value of every remaining year's
 * AFTER-TAX income gap (lifestyle − net guaranteed income actually in pay that
 * year — bridge years before CPP/OAS start need more), grossed up for the tax on
 * registered withdrawals, at a conservative real return.
 *
 * Before the retirement age: the savings TRAJECTORY that reaches the required-at-
 * retirement amount — the retirement number discounted back, net of the present
 * value of the savings still planned between now and then. (Not "enough to retire
 * today", which would make everyone look permanently behind.)
 */
function requiredCapital(
  p: RetirementParams,
  c: SimConst,
  selfAge: number
): number {
  // Real return assumption for the glidepath (conservative 40/60-ish).
  const realReturn = Math.max(0.005, blendedReturn(0.5, p) - p.inflation)
  const retireAge = p.retirementAge

  if (selfAge >= retireAge) {
    const netSteadyMonthly =
      c.hooppAnnual / 12 + c.selfCpp + c.partnerCpp + c.selfOas + c.partnerOas -
      c.steadyTaxAnnual / 12
    let pv = 0
    for (let a = selfAge; a < p.planToAge; a++) {
      const partnerAge = a - c.partnerAgeGap
      // Guaranteed income not yet in pay at this age (the bridge, counted gross —
      // slightly conservative).
      const missing =
        (a < p.selfCppAge ? c.selfCpp : 0) +
        (a < p.selfOasAge ? c.selfOas : 0) +
        (partnerAge < p.partnerCppAge ? c.partnerCpp : 0) +
        (partnerAge < p.partnerOasAge ? c.partnerOas : 0)
      // Post-sale replacement housing (condo fees / rent) raises the spend target.
      const extraHousing =
        p.sellHouse && a >= p.sellHouseAge
          ? p.sellHouseReplacement === 'rent'
            ? p.rentMonthly
            : p.condoFeesMonthly
          : 0
      const gapAnnual =
        Math.max(0, c.lifestyleMonthly + extraHousing - netSteadyMonthly + missing) * 12
      pv += (gapAnnual / WITHDRAWAL_NET_FACTOR) / Math.pow(1 + realReturn, a - selfAge)
    }
    return pv
  }

  const yrs = retireAge - selfAge
  const atRetirement = requiredCapital(p, c, retireAge)
  const contribPv =
    (c.annualSavingsRealToday * (1 - Math.pow(1 + realReturn, -yrs))) / realReturn
  return Math.max(0, atRetirement / Math.pow(1 + realReturn, yrs) - contribPv)
}

/** Collapse per-year draw samples into a few readable phases (§5.7 instructions). */
function summarizeDrawPhases(
  samples: { age: number; rrspMonthly: number; tfsaMonthly: number }[]
): PlanResult['drawPhases'] {
  if (samples.length === 0) return []
  const phases: PlanResult['drawPhases'] = []
  const round = (v: number) => Math.round(v / 100) * 100
  let cur = {
    fromAge: samples[0].age,
    toAge: samples[0].age,
    rrspMonthly: round(samples[0].rrspMonthly),
    tfsaMonthly: round(samples[0].tfsaMonthly),
  }
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]
    if (round(s.rrspMonthly) === cur.rrspMonthly && round(s.tfsaMonthly) === cur.tfsaMonthly) {
      cur.toAge = s.age
    } else {
      phases.push(cur)
      cur = { fromAge: s.age, toAge: s.age, rrspMonthly: round(s.rrspMonthly), tfsaMonthly: round(s.tfsaMonthly) }
    }
  }
  phases.push(cur)
  return phases
}
