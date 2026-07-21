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
check('income layers = 4', plan.incomeLayers.length === 4)
check('HOOPP is a real number', plan.hooppAnnualReal > 5000 && plan.hooppAnnualReal < 60000, `${plan.hooppAnnualReal.toFixed(0)}`)
check('self CPP in band', plan.selfCppMonthlyReal > 500 && plan.selfCppMonthlyReal <= 1433, `${plan.selfCppMonthlyReal.toFixed(0)}`)
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
}

console.log('')
if (failed > 0) {
  console.error(`❌ ${failed} check(s) failed`)
  process.exit(1)
}
console.log('✅ all retirement-engine checks passed')
