/**
 * Sanity checks for app/lib/canada-rules.ts — run with `npx tsx scripts/check-canada-rules.ts`.
 * Not a formal test suite (the repo has no test runner); these are golden-value
 * assertions that catch regressions in the pure Canadian-rules math. Every check
 * is a plausibility band, not a claim of authoritative accuracy (see §10).
 */
import {
  ympeFor,
  estimateCpp,
  reconstructEarnings,
  cppStartFactor,
  estimateOas,
  oasClawback,
  oasResidencyFraction,
  estimateHoopp,
  hooppEarlyFactor,
  rrifMinFactor,
  ontarioIncomeTax,
  grossUpFromNet,
  householdTaxWithSplitting,
  rdspGrantForContribution,
} from '../app/lib/canada-rules'

let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name} ${detail}`)
  }
}
function near(a: number, b: number, tol: number) {
  return Math.abs(a - b) <= tol
}

console.log('YMPE')
check('2026 known value', ympeFor(2026) === 74900)
check('future extrapolates up', ympeFor(2035) > ympeFor(2026), `got ${ympeFor(2035)}`)

console.log('CPP start factor')
check('60 → −36% (0.64)', near(cppStartFactor(60), 0.64, 0.001), `${cppStartFactor(60)}`)
check('65 → 1', cppStartFactor(65) === 1)
check('70 → +42%', near(cppStartFactor(70), 1.42, 0.001), `${cppStartFactor(70)}`)

console.log('CPP estimate (owner: 2010 $50k → 2026 ~$95k, start 65)')
{
  const e = reconstructEarnings(2010, 50000, 2026, 95000, 2041)
  const { monthlyAt65 } = estimateCpp(e, 65)
  // Immigrant with ~30 solid years by 65: expect a healthy fraction of max (~$900–$1433).
  check('in plausible band', monthlyAt65 > 700 && monthlyAt65 <= 1433, `got ${monthlyAt65.toFixed(0)}`)
}

console.log('OAS')
// Arrived at 18 (1999) → at 65 (2046): 40+ yrs after 18 → full.
check('40+ yrs after 18 → full', oasResidencyFraction(1999, 65, 1981) === 1)
// Arrived 2026 → at 65 (2046): 20 yrs → half.
check('20 yrs → half', near(oasResidencyFraction(2026, 65, 1981), 0.5, 0.001), `${oasResidencyFraction(2026, 65, 1981)}`)
{
  const arrival = 2009
  const birth = 1981
  // At 65: 2046 − max(2009, 1999) = 37 years → 37/40
  const frac = oasResidencyFraction(arrival, 65, birth)
  check('37/40 residency', near(frac, 37 / 40, 0.001), `got ${frac.toFixed(3)}`)
  const oas = estimateOas(arrival, 65, birth)
  check('OAS ≈ 0.925 × full', near(oas, 727.67 * 37 / 40, 1), `got ${oas.toFixed(2)}`)
}
check('clawback zero below threshold', oasClawback(9000, 80000) === 0)
check('clawback 15% above threshold', near(oasClawback(9000, 100000), Math.min(9000, (100000 - 93454) * 0.15), 1))

console.log('HOOPP')
{
  // Partner: ~$80k best-5 avg, 20 years service by retirement.
  const annual = estimateHoopp(80000, 20)
  // ≈ 20 × (1.5% × ~72k + 2% × ~8k) ≈ 20 × (1080 + 160) ≈ $24.8k/yr
  check('20yr @ $80k in band', annual > 20000 && annual < 32000, `got ${annual.toFixed(0)}`)
  check('unreduced at 60', hooppEarlyFactor(60, 20) === 1)
  check('reduced at 55', hooppEarlyFactor(55, 20) < 1)
  check('85-factor unreduces early', hooppEarlyFactor(58, 30) === 1)
}

console.log('RRIF minimums')
check('71 → 5.28%', rrifMinFactor(71) === 0.0528)
check('65 → 1/25', near(rrifMinFactor(65), 1 / 25, 1e-9))
check('95 → 20%', rrifMinFactor(95) === 0.2)

console.log('Ontario tax')
{
  const t50 = ontarioIncomeTax(50000)
  // ~ marginal ~20% combined minus BPA credits → effective ~10-14%
  check('$50k tax in band', t50 > 4000 && t50 < 9000, `got ${t50.toFixed(0)}`)
  const t150 = ontarioIncomeTax(150000)
  check('$150k tax in band', t150 > 35000 && t150 < 50000, `got ${t150.toFixed(0)}`)
  check('zero at/below BPA', ontarioIncomeTax(10000) === 0, `got ${ontarioIncomeTax(10000)}`)
}

console.log('Gross-up from net')
{
  const gross = grossUpFromNet(60000)
  const net = gross - ontarioIncomeTax(gross)
  check('round-trips', near(net, 60000, 50), `net ${net.toFixed(0)} from gross ${gross}`)
}

console.log('Pension income splitting')
{
  // Concentrated income (she has HOOPP, he has little) → splitting must lower total.
  const noHelp = householdTaxWithSplitting(90000, 10000, 0, { aAge65: true, bAge65: true })
  const withSplit = householdTaxWithSplitting(90000, 10000, 80000, { aAge65: true, bAge65: true })
  check('splitting lowers tax', withSplit < noHelp, `split ${withSplit.toFixed(0)} vs ${noHelp.toFixed(0)}`)
}

console.log('RDSP grant')
check('high tier $1500 → $3500', rdspGrantForContribution(1500, true) === 3500)
check('high tier $500 → $1500', rdspGrantForContribution(500, true) === 1500)
check('low tier $1000 → $1000', rdspGrantForContribution(1000, false) === 1000)
check('low tier capped at $1000', rdspGrantForContribution(5000, false) === 1000)

console.log('')
if (failed > 0) {
  console.error(`❌ ${failed} check(s) failed`)
  process.exit(1)
}
console.log('✅ all canada-rules checks passed')
