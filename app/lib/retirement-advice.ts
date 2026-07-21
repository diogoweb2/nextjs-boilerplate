/**
 * The consultant's voice — rule-generated advice cards (RETIREMENT_PLAN.md §7).
 * Pure functions over PlanResult + params, priority-ordered, max 4 shown by the UI.
 * Every card carries a computed dollar impact, because numbers persuade. NO AI.
 */
import { formatCurrencyCompact } from './format'
import type { PlanResult, RetirementParams } from './retirement'
import { glideEquityFraction } from './retirement'
import type { RetirementData } from '@/app/actions/retirement'
import { RDSP } from './canada-rules'

export type AdviceCard = {
  key: string
  /** One-sentence hero action line (the first card feeds the hero verdict). */
  headline: string
  title: string
  body: string
  href?: string
  linkLabel?: string
}

const mo = (v: number) => `${formatCurrencyCompact(v)}/mo`

export function buildAdvice(
  plan: PlanResult,
  params: RetirementParams,
  data: RetirementData
): AdviceCard[] {
  const cards: AdviceCard[] = []
  const kid1 = data.names.kid1

  // 1. RDSP not open → always #1 until done (free money).
  if (!params.rdspOpen) {
    const grantWaiting = Math.min(RDSP.annualGrantCatchupCap, 10500)
    cards.push({
      key: 'rdsp',
      headline: `Opening ${kid1}'s RDSP this year captures up to ${formatCurrencyCompact(grantWaiting)} in unclaimed government grants.`,
      title: `Open ${kid1}'s RDSP`,
      body: `He's DTC-approved, so he's eligible now. Because grant room carries forward to when the DTC was first approved, up to ${formatCurrencyCompact(grantWaiting)} of catch-up CDSG grant is waiting — the single highest-return move in this whole plan.`,
    })
  }

  // 2. Too conservative vs the glidepath → dollar cost of the bond drag.
  const targetEquity = glideEquityFraction(data.inputs.self.birthYear ? new Date().getFullYear() - data.inputs.self.birthYear : 45, params)
  const actualEquity = data.inputs.currentEquityFraction
  if (actualEquity < targetEquity - 0.1) {
    // Rough dollar drag: gap × (equity−bond spread) × investable capital × years to retirement.
    const investable = data.inputs.selfRrsp + data.inputs.partnerRrsp + data.inputs.tfsaTotal + data.inputs.dcBalance
    const yearsToRetire = Math.max(1, plan.retirementYear - data.inputs.currentYear)
    const drag = (targetEquity - actualEquity) * (params.equityReturn - params.bondReturn) * investable * yearsToRetire
    cards.push({
      key: 'aggressive',
      headline: `Rotating your bond-heavy mix toward the glidepath could add ≈ ${formatCurrencyCompact(drag)} by ${plan.retirementYear}.`,
      title: 'You may be invested too safely',
      body: `You're about ${(actualEquity * 100).toFixed(0)}% in equities; at your ${yearsToRetire}-year horizon the consultant target is ≈ ${(targetEquity * 100).toFixed(0)}%. The bond-heavy mix costs roughly ${formatCurrencyCompact(drag)} by retirement. Rotate on the next dip — your investment report already watches for it.`,
      href: '/accounts/investments/report',
      linkLabel: 'See the dip signal →',
    })
  }

  // 3. Plan short → cheapest fix first.
  if (!plan.onTrack) {
    const gap = Math.abs(plan.monthlyGapReal)
    // Rough monthly-contribution fix: annualize the gap-funded shortfall over years to retirement.
    const yearsToRetire = Math.max(1, plan.retirementYear - data.inputs.currentYear)
    const extraMonthly = Math.round(((gap * 12) / (yearsToRetire * 1.4)) / 12 / 50) * 50
    cards.push({
      key: 'short',
      headline: `Raising savings by about ${mo(extraMonthly)} closes the ${mo(gap)} gap.`,
      title: 'Closing the gap',
      body: `You're ${mo(gap)} short of the ${plan.lifestyleMonthlyReal ? 'selected' : ''} lifestyle. Cheapest fix first: add ≈ ${mo(extraMonthly)} in savings — or retire a year later, or step the lifestyle down one tier.`,
    })
  } else if (plan.recommendedRetireAge && plan.recommendedRetireAge < plan.selfRetireAge) {
    cards.push({
      key: 'ahead',
      headline: `You could retire at ${plan.recommendedRetireAge} — or upgrade your travel.`,
      title: "You're ahead",
      body: `The plan funds your lifestyle as early as age ${plan.recommendedRetireAge}. You could retire ${plan.selfRetireAge - plan.recommendedRetireAge} year(s) sooner, or keep the date and add a second Europe trip a year.`,
    })
  }

  // 4. Crisis resilience check.
  cards.push({
    key: 'crisis',
    headline: plan.survivesCrisis
      ? `Even if a 2008-style crash hits the year before you retire, the plan survives.`
      : `A historical-style crash before retirement would break the current plan — build a bigger buffer.`,
    title: 'Crash test',
    body: plan.survivesCrisis
      ? `Run through the worst deterministic sequence of −${(params.crisisEquityDrop * 100).toFixed(0)}% bear markets, your money still lasts to age ${params.planToAge}. That's why the glidepath keeps a bond floor — you spend bonds/TFSA in a crash, never sell equities low.`
      : `Under the modeled crisis sequence the portfolio runs dry before age ${params.planToAge}. Retire a little later, save a bit more, or keep a larger cash/bond cushion so a crash year doesn't force selling equities low.`,
  })

  // 5. Post-mortgage redirect nudge.
  if (params.postMortgageRedirect < 0.5) {
    const freed = data.inputs.monthlyMortgagePayment
    cards.push({
      key: 'redirect',
      headline: `When the mortgage ends, redirecting more of the freed ${mo(freed)} accelerates everything.`,
      title: 'The mortgage windfall',
      body: `The mortgage frees up ≈ ${mo(freed)} in ${data.inputs.mortgagePayoffYear}. You're redirecting ${(params.postMortgageRedirect * 100).toFixed(0)}% of it to savings — nudging that up is one of the biggest levers you have.`,
    })
  }

  return cards
}
