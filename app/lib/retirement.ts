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

  /** House. */
  sellHouse: boolean
  sellHouseAge: number
  houseAppreciation: number

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
  /** Signed monthly surplus/shortfall at retirement, today's dollars. */
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

export function buildRetirementPlan(
  inputs: RetirementInputs,
  params: RetirementParams
): PlanResult {
  const retirementYear = inputs.self.birthYear + params.retirementAge
  const partnerRetireAge = retirementYear - inputs.partner.birthYear + params.partnerRetirementAgeOffset

  // Guaranteed-income building blocks (today's dollars, computed once).
  const selfEarnings = reconstructEarnings(
    inputs.self.careerStartYear,
    inputs.self.careerStartSalary,
    inputs.currentYear,
    inputs.self.grossSalary,
    inputs.self.birthYear + params.selfCppAge,
    inputs.self.realSalaryGrowth
  )
  const partnerEarnings = reconstructEarnings(
    inputs.partner.careerStartYear,
    inputs.partner.careerStartSalary,
    inputs.currentYear,
    inputs.partner.grossSalary,
    inputs.partner.birthYear + params.partnerCppAge,
    inputs.partner.realSalaryGrowth
  )
  const selfCpp = estimateCpp(selfEarnings, params.selfCppAge, inputs.self.birthYear).monthlyAtStart
  const partnerCpp = estimateCpp(partnerEarnings, params.partnerCppAge, inputs.partner.birthYear).monthlyAtStart

  const selfOas = estimateOas(inputs.self.arrivalYear, params.selfOasAge, inputs.self.birthYear)
  const partnerOas = estimateOas(inputs.partner.arrivalYear, params.partnerOasAge, inputs.partner.birthYear)

  // HOOPP: best-5-year avg ≈ current gross (partner grows with inflation → flat real).
  const hooppService = Math.max(0, retirementYear - params.hooppServiceStartYear)
  const hooppAnnualUnreduced = estimateHoopp(inputs.partner.grossSalary, hooppService)
  const hooppAnnual =
    hooppAnnualUnreduced * hooppEarlyFactor(partnerRetireAge, hooppService)

  const lifestyleMonthly = params.tierMonthly[params.lifestyle]
  const essentialsMonthly = params.tierMonthly.essentials

  const sim = runSimulation(inputs, params, {
    retirementYear,
    partnerRetireAge,
    selfCpp,
    partnerCpp,
    selfOas,
    partnerOas,
    hooppAnnual,
    lifestyleMonthly,
    essentialsMonthly,
    crisis: false,
  })
  const crisisSim = params.crisisEnabled
    ? runSimulation(inputs, params, {
        retirementYear,
        partnerRetireAge,
        selfCpp,
        partnerCpp,
        selfOas,
        partnerOas,
        hooppAnnual,
        lifestyleMonthly,
        essentialsMonthly,
        crisis: true,
      })
    : sim

  // Income-at-retirement waterfall (today's dollars, at the retirement year).
  const retireRow = sim.rows.find((r) => r.year === retirementYear) ?? sim.rows[sim.rows.length - 1]
  const bridge = partnerRetireAge < 65 ? hooppAnnual * 0.15 : 0 // HOOPP bridge to 65 (approx)
  const layers: IncomeLayer[] = [
    { key: 'hoopp', label: 'Her hospital pension (HOOPP)', monthlyReal: (hooppAnnual + bridge) / 12 },
    {
      key: 'cpp',
      label: 'Government pensions (CPP × 2)',
      monthlyReal: (params.retirementAge >= params.selfCppAge ? selfCpp : 0) +
        (partnerRetireAge >= params.partnerCppAge ? partnerCpp : 0),
    },
    {
      key: 'oas',
      label: 'Old Age Security (OAS × 2)',
      monthlyReal: (params.retirementAge >= params.selfOasAge ? selfOas : 0) +
        (partnerRetireAge >= params.partnerOasAge ? partnerOas : 0),
    },
  ]
  const guaranteedMonthly = layers.reduce((s, l) => s + l.monthlyReal, 0)
  // The savings layer is the SUSTAINABLE draw the portfolio can support, not the
  // (front-loaded) first-year meltdown. Approximate it as a level real annuity of
  // the retirement-year capital over the remaining years — this is what makes the
  // waterfall represent a durable income, and keeps early retirement from looking
  // artificially rich (an early first-year RRSP meltdown is not permanent income).
  const yearsInRetirement = Math.max(1, params.planToAge - params.retirementAge)
  const realReturn = Math.max(0.005, sim.rows[0] ? 0.03 : 0.03) // conservative ~3% real
  const annuityFactor = realReturn < 1e-6
    ? 1 / yearsInRetirement
    : realReturn / (1 - Math.pow(1 + realReturn, -yearsInRetirement))
  const sustainableSavingsMonthly = (retireRow.capitalReal * annuityFactor) / 12
  // Cap the savings contribution at the lifestyle gap — you don't draw more than
  // you need — but the surplus (if any) is what puts the plan "ahead".
  const lifestyleGap = Math.max(0, lifestyleMonthly - guaranteedMonthly)
  const savingsForLifestyle = Math.min(sustainableSavingsMonthly, lifestyleGap)
  layers.push({ key: 'savings', label: 'Your savings (RRSP/TFSA draw)', monthlyReal: savingsForLifestyle })

  const incomeAtRetirement = guaranteedMonthly + sustainableSavingsMonthly
  const monthlyGap = incomeAtRetirement - lifestyleMonthly

  // Recommended age: earliest 50–70 where the plan funds the lifestyle to the end.
  let recommended: number | null = null
  for (let age = 50; age <= 70; age++) {
    const probe = runSimulation(inputs, { ...params, retirementAge: age }, {
      retirementYear: inputs.self.birthYear + age,
      partnerRetireAge: inputs.self.birthYear + age - inputs.partner.birthYear + params.partnerRetirementAgeOffset,
      selfCpp,
      partnerCpp,
      selfOas,
      partnerOas,
      hooppAnnual,
      lifestyleMonthly,
      essentialsMonthly,
      crisis: false,
    })
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
  lifestyleMonthly: number
  essentialsMonthly: number
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
        inputs.monthlyRrspContribution * 12 + inputs.self.grossSalary * 0.03 /* employer match */,
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
      const targetAnnual = inflate(c.lifestyleMonthly * 12, year)

      // 1. Guaranteed income first.
      const bridge = partnerAge < 65 ? c.hooppAnnual * 0.15 : 0
      const hooppReal = c.hooppAnnual * Math.pow(1 + p.inflation * p.hooppIndexingOfCpi, year - startYear) + inflate(bridge, year)
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

      // 3. TFSA last (and the crisis buffer — draw TFSA in a crash year).
      let tfsaDraw = 0
      if (need > 0) {
        const available = Math.max(0, tfsa - tfsaFloorNominal)
        tfsaDraw = Math.min(available + tfsaFloorNominal, need) // in a pinch, dip the floor
        tfsa -= tfsaDraw
        need -= tfsaDraw
      }

      // 4. Non-reg (house proceeds land here).
      if (need > 0 && nonReg > 0) {
        const d = Math.min(nonReg, need)
        nonReg -= d
        need -= d
      }

      // House sale (proceeds → non-reg).
      if (p.sellHouse && selfAge === p.sellHouseAge) {
        const houseNominal = inputs.houseValue * Math.pow(1 + p.houseAppreciation, year - startYear)
        nonReg += houseNominal
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

    // Guaranteed monthly (today's dollars) for the chart/waterfall.
    const guaranteedMonthlyReal =
      (retired ? 1 : 0) *
      ((c.hooppAnnual + (selfAge >= p.selfCppAge ? c.selfCpp * 12 : 0)) / 12)

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
 * Required investable capital at a given age so that, combined with guaranteed
 * income, the lifestyle is funded to plan end. Uses a present-value annuity of the
 * remaining income gap at a conservative real return.
 */
function requiredCapital(
  p: RetirementParams,
  c: SimConst,
  selfAge: number
): number {
  const yearsToEnd = Math.max(0, p.planToAge - selfAge)
  // Real return assumption for the glidepath (conservative 40/60-ish).
  const realReturn = Math.max(0.005, blendedReturn(0.5, p) - p.inflation)
  // Average guaranteed monthly once fully in payment (today's dollars).
  const guaranteedMonthly =
    c.hooppAnnual / 12 + c.selfCpp + c.partnerCpp + c.selfOas + c.partnerOas
  const gapMonthly = Math.max(0, c.lifestyleMonthly - guaranteedMonthly)
  const gapAnnual = gapMonthly * 12
  // Present value of a level real annuity for the remaining years.
  if (yearsToEnd <= 0) return 0
  const pv = realReturn < 1e-6
    ? gapAnnual * yearsToEnd
    : gapAnnual * (1 - Math.pow(1 + realReturn, -yearsToEnd)) / realReturn
  return pv
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
