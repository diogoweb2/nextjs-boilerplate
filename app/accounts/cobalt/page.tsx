import { CobaltAnalysis } from '@/app/components/CobaltAnalysis'
import { computeCobaltPoints, computeRogersSpend, computePhoneSwitchSpendBasis } from '@/app/lib/amex-cobalt'
import { loadAllFlows } from '@/app/lib/analytics'
import { loadCardRewardContext } from '@/app/actions/amex-cobalt'
import { isDemoSession } from '@/app/lib/demo'

export const dynamic = 'force-dynamic'

export default async function AccountsCobaltPage() {
  const demo = await isDemoSession()
  const [allFlows, ctx] = demo
    ? [(await import('@/app/lib/demo-data')).demoAllFlows(), await loadCardRewardContext()]
    : await Promise.all([loadAllFlows(), loadCardRewardContext()])

  const points = computeCobaltPoints(allFlows, ctx)
  const rogersSpend = computeRogersSpend(allFlows, ctx)
  const switchBasis = computePhoneSwitchSpendBasis(allFlows, ctx)

  return <CobaltAnalysis points={points} rogersSpend={rogersSpend} switchBasis={switchBasis} />
}
