import { CobaltAnalysis } from '@/app/components/CobaltAnalysis'
import {
  computeCobaltPoints,
  computeRogersSpend,
  computePhoneSwitchSpendBasis,
  computeRogersSpendByPerson,
  computeSpendMatrix,
} from '@/app/lib/amex-cobalt'
import { loadAllFlows } from '@/app/lib/analytics'
import { loadCardRewardContext } from '@/app/actions/amex-cobalt'
import { getPersonNames } from '@/app/lib/cardholders'
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

  // Names come from .env.local (never the DB or this public repo) and are
  // resolved server-side, so only the display strings cross to the client.
  const { selfName, partnerName } = getPersonNames()
  const twoCards = {
    byPerson: computeRogersSpendByPerson(allFlows, ctx),
    matrix: computeSpendMatrix(allFlows, ctx),
    selfName,
    partnerName,
  }

  return (
    <CobaltAnalysis
      points={points}
      rogersSpend={rogersSpend}
      switchBasis={switchBasis}
      twoCards={twoCards}
    />
  )
}
