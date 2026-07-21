/**
 * Sanity checks for app/lib/retirement.ts + retirement-defaults.ts.
 * Run: `npx tsx scripts/check-retirement.ts`. Frozen fixture inputs → plausibility
 * bands on the year-by-year plan. Not authoritative (see RETIREMENT_PLAN.md §10).
 */
import { buildRetirementPlan, type RetirementInputs } from '../app/lib/retirement'
import { computeDefaults, deriveTiers, type DerivedForDefaults } from '../app/lib/retirement-defaults'

let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.log(`  ✗ ${name} ${detail}`)
  }
}

// Frozen fixture roughly matching the household (RETIREMENT_PLAN.md §1).
const inputs: RetirementInputs = {
  currentYear: 2026,
  self: {
    birthYear: 1981,
    grossSalary: 95000,
    realSalaryGrowth: 0,
    careerStartYear: 2010,
    careerStartSalary: 50000,
    arrivalYear: 2009,
  },
  partner: {
    birthYear: 1982,
    grossSalary: 80000,
    realSalaryGrowth: 0,
    careerStartYear: 2011,
    careerStartSalary: 35000,
    arrivalYear: 2010,
  },
  selfRrsp: 220000,
  partnerRrsp: 35000,
  tfsaTotal: 90000,
  dcBalance: 40000,
  currentEquityFraction: 0.55,
  houseValue: 1200000,
  mortgagePayoffYear: 2031,
  monthlyMortgagePayment: 2100,
  currentMonthlySpend: 8000,
  monthlyRrspContribution: 900,
  monthlyTfsaContribution: 300,
}

const derived: DerivedForDefaults = {
  inputs,
  categoryMonthly: {
    Home: 3200,
    Groceries: 1400,
    Health: 300,
    Dental: 120,
    Cars: 800,
    Subscriptions: 250,
    Transport: 200,
    Dining: 600,
    Entertainment: 300,
    Kids: 700,
    Investment: 1200,
    Travel: 500,
    Shopping: 600,
  },
  mortgagePortionMonthly: 2100,
}

console.log('Tiers')
const tiers = deriveTiers(derived)
check('essentials < today < snowbird', tiers.essentials < tiers.today && tiers.today < tiers.snowbird,
  JSON.stringify(tiers))
check('essentials in plausible band', tiers.essentials > 3000 && tiers.essentials < 8000, `${tiers.essentials}`)

console.log('Defaults')
const params = computeDefaults(derived)
check('lifestyle default snowbird', params.lifestyle === 'snowbird')
check('inflation 2.5%', params.inflation === 0.025)
check('equity return 6.6%', params.equityReturn === 0.066)

console.log('Plan')
const plan = buildRetirementPlan(inputs, params)
check('rows cover to age 95', plan.rows[plan.rows.length - 1].selfAge === 95, `${plan.rows[plan.rows.length - 1].selfAge}`)
check('retirement year = 1981 + age', plan.retirementYear === 1981 + params.retirementAge)
check('income layers = 5 (incl. tax)', plan.incomeLayers.length === 5)
check('tax layer is negative', (plan.incomeLayers.find((l) => l.key === 'tax')?.monthlyReal ?? 0) < 0)
check('HOOPP is a real number', plan.hooppAnnualReal > 5000 && plan.hooppAnnualReal < 60000, `${plan.hooppAnnualReal.toFixed(0)}`)
// Upper bound = the 2026 max clamp (conservative for a 2040s retiree, whose real
// max — with the CPP enhancement fully phased in — will be higher in today's dollars).
check('self CPP in band', plan.selfCppMonthlyReal > 500 && plan.selfCppMonthlyReal <= 1507.65, `${plan.selfCppMonthlyReal.toFixed(0)}`)
check('income at retirement positive', plan.incomeAtRetirementReal > 0, `${plan.incomeAtRetirementReal.toFixed(0)}`)
check('capital peaks then declines (retire drawdown)', (() => {
  const retIdx = plan.rows.findIndex((r) => r.retired)
  const peak = Math.max(...plan.rows.slice(0, retIdx + 2).map((r) => r.capitalReal))
  const end = plan.rows[plan.rows.length - 1].capitalReal
  return end < peak
})())
check('crisis path exists', plan.crisisCapitalReal.length === plan.rows.length)
check('draw phases produced', plan.drawPhases.length >= 1, `${plan.drawPhases.length}`)
check('recommended age within 50-70 or null',
  plan.recommendedRetireAge === null || (plan.recommendedRetireAge >= 50 && plan.recommendedRetireAge <= 70),
  `${plan.recommendedRetireAge}`)

console.log('Monotonicity: later retirement age → not worse gap')
{
  const early = buildRetirementPlan(inputs, { ...params, retirementAge: 55 })
  const late = buildRetirementPlan(inputs, { ...params, retirementAge: 65 })
  check('retiring later improves (or holds) the monthly gap', late.monthlyGapReal >= early.monthlyGapReal - 1,
    `55:${early.monthlyGapReal.toFixed(0)} 65:${late.monthlyGapReal.toFixed(0)}`)
  // CPP earnings stop at retirement: retiring at 55 must yield LESS CPP than at 65
  // (the 55–65 zero-earning years survive the dropout only partially).
  check('early retirement lowers CPP', early.selfCppMonthlyReal < late.selfCppMonthlyReal,
    `55:${early.selfCppMonthlyReal.toFixed(0)} 65:${late.selfCppMonthlyReal.toFixed(0)}`)
}

console.log('House sale models replacement housing (never free)')
{
  const keep = buildRetirementPlan(inputs, { ...params, sellHouse: false })
  const condo = buildRetirementPlan(inputs, { ...params, sellHouse: true, sellHouseAge: 75, sellHouseReplacement: 'condo' })
  const rent = buildRetirementPlan(inputs, { ...params, sellHouse: true, sellHouseAge: 75, sellHouseReplacement: 'rent' })
  const atAge = (p: typeof keep, age: number) => p.rows.find((r) => r.selfAge === age)!.capitalReal
  const end = (p: typeof keep) => p.rows[p.rows.length - 1].capitalReal
  check('selling (condo) still adds capital vs keeping', end(condo) > end(keep),
    `condo ${end(condo).toFixed(0)} keep ${end(keep).toFixed(0)}`)
  // The condo purchase consumes downsizeFraction of the proceeds: the sale-year
  // capital jump must be well below the full (real) house value.
  const jump = atAge(condo, 75) - atAge(keep, 75)
  const houseReal = inputs.houseValue *
    Math.pow((1 + params.houseAppreciation) / (1 + params.inflation), 75 - (inputs.currentYear - inputs.self.birthYear))
  check('condo purchase consumed from proceeds', jump < houseReal * 0.7,
    `jump ${jump.toFixed(0)} vs house ${houseReal.toFixed(0)}`)
  check('renting invests more at the sale than buying a condo', atAge(rent, 75) > atAge(condo, 75),
    `rent ${atAge(rent, 75).toFixed(0)} condo ${atAge(condo, 75).toFixed(0)}`)
}

console.log('Needed curve is a savings trajectory, not "retire today"')
{
  const first = plan.rows[0]
  const retire = plan.rows.find((r) => r.year === plan.retirementYear)!
  check('needed today < needed at retirement', first.neededReal < retire.neededReal,
    `today:${first.neededReal.toFixed(0)} retire:${retire.neededReal.toFixed(0)}`)
  check('needed is non-negative everywhere', plan.rows.every((r) => r.neededReal >= 0))
}

console.log('')
if (failed > 0) {
  console.error(`❌ ${failed} check(s) failed`)
  process.exit(1)
}
console.log('✅ all retirement-engine checks passed')
