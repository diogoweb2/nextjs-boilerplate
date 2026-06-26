import { db } from '@/db'
import { categories } from '@/db/schema'
import { Card, EmptyHint } from '@/app/components/AppShell'
import { EmergencyFund } from '@/app/components/EmergencyFund'
import { RunwayWidget } from '@/app/components/charts/RunwayWidget'
import { SafeToMoveWidget } from '@/app/components/charts/SafeToMoveWidget'
import {
  loadEmergencyFund,
  loadOutstandingCardBalance,
  recordAndLoadRunwayHistory,
} from '@/app/actions/emergency'
import { loadCashflowPlan } from '@/app/actions/cashflow'
import { loadAllFlows } from '@/app/lib/analytics'
import { computeRunwayInputs, buildScenarios } from '@/app/lib/runway'
import { isDemoSession } from '@/app/lib/demo'

export const dynamic = 'force-dynamic'

export default async function AccountsEmergencyPage() {
  const demo = await isDemoSession()

  const [emergency, outstandingCards, cashflowPlan] = await Promise.all([
    loadEmergencyFund(),
    loadOutstandingCardBalance(),
    loadCashflowPlan(),
  ])

  const [allFlows, catRows] = demo
    ? await (async () => {
        const d = await import('@/app/lib/demo-data')
        return [d.demoAllFlows(), d.demoCategoryRows()] as const
      })()
    : await Promise.all([loadAllFlows(), db.select().from(categories)])

  const bucketMeta = catRows.map((c) => ({ name: c.name, kind: c.kind, bucket: c.bucket }))
  const runwayInputs = computeRunwayInputs(allFlows, bucketMeta)
  const earnerNames = {
    self: process.env.SELF_NAME ?? 'Me',
    partner: process.env.PARTNER_NAME ?? 'Partner',
  }

  const availableCash = Math.max(0, emergency.total - outstandingCards)
  const worstMonths = buildScenarios(runwayInputs, availableCash, false, earnerNames).scenarios.reduce<
    number | null
  >((worst, s) => (s.months === null ? worst : worst === null ? s.months : Math.min(worst, s.months)), null)

  const runwayHistory = emergency.hasData
    ? demo
      ? (await import('@/app/lib/demo-data')).demoRunwayHistory()
      : await recordAndLoadRunwayHistory(worstMonths)
    : []

  return (
    <>
      <EmergencyFund data={emergency} />

      {emergency.hasData && (
        <div className="mt-5 flex flex-col gap-5">
          <Card
            title="Emergency runway"
            action={
              <span className="text-xs text-[var(--muted)]">worst-case months of coverage</span>
            }
          >
            <RunwayWidget
              fund={emergency.total}
              committed={outstandingCards}
              inputs={runwayInputs}
              names={earnerNames}
              history={runwayHistory}
            />
          </Card>

          <Card title="Safe to move to investment">
            <SafeToMoveWidget plan={cashflowPlan} />
          </Card>
        </div>
      )}

      {!emergency.hasData && (
        <Card className="mt-5">
          <EmptyHint>
            Set your chequing balances on this page to see how many months your emergency fund
            would cover.
          </EmptyHint>
        </Card>
      )}
    </>
  )
}
