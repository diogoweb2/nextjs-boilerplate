'use server'

import { asc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { accountSnapshots, holdingSnapshots, registeredAccounts } from '@/db/schema'
import { isDemoSession } from '@/app/lib/demo'
import { balanceAsOf, type BalanceSnapshot, type FundSource } from '@/app/lib/emergency'
import { loadBankFlows } from '@/app/actions/emergency'
import { loadMortgageProjection } from '@/app/actions/goals'

const round2 = (n: number) => Math.round(n * 100) / 100

function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m, 0).getDate()
  return `${ym}-${String(d).padStart(2, '0')}`
}

export type NetWorthData = {
  hasData: boolean
  netWorth: number
  assets: { chequing: number; investments: number }
  liabilities: { mortgage: number }
  /** Net worth at each month-end across the requested window (for the trend). */
  series: { ym: string; value: number }[]
}

/**
 * Net worth = chequing (Tangerine + Scotia) + investments (TFSA + RESP, full
 * market value) − the mortgage balance still owed. A read-only assembly of
 * existing data (no double-counting): chequing from the emergency-fund snapshots/
 * flows, investments from the iTrade holdings snapshots, mortgage from the same
 * projection the Goals page uses. The series walks the requested months so the
 * dashboard chart respects the selected period. Credit-card balances are excluded
 * (a within-month timing item paid off monthly), keeping the figure stable.
 *
 * @param months YM list (ascending) to plot — the dashboard's selected window.
 */
export async function loadNetWorth(months: string[]): Promise<NetWorthData> {
  if (await isDemoSession()) {
    const { demoNetWorth } = await import('@/app/lib/demo-data')
    return demoNetWorth(months)
  }

  const [chequingRows, holdingRows, flows, mortgage] = await Promise.all([
    db
      .select({
        source: accountSnapshots.source,
        balance: accountSnapshots.balance,
        occurredAt: accountSnapshots.occurredAt,
        createdAt: accountSnapshots.createdAt,
      })
      .from(accountSnapshots)
      .where(inArray(accountSnapshots.source, ['tangerine', 'scotia'])),
    db
      .select({
        accountId: holdingSnapshots.accountId,
        total: holdingSnapshots.totalValueCad,
        occurredAt: holdingSnapshots.occurredAt,
      })
      .from(holdingSnapshots)
      .innerJoin(registeredAccounts, eq(holdingSnapshots.accountId, registeredAccounts.id))
      .where(eq(registeredAccounts.archived, false))
      .orderBy(asc(holdingSnapshots.occurredAt)),
    loadBankFlows(),
    loadMortgageProjection(),
  ])

  const chequingSnaps: BalanceSnapshot[] = chequingRows.map((r) => ({
    source: r.source as FundSource,
    balance: Number(r.balance),
    occurredAt: r.occurredAt,
    createdAt: r.createdAt.toISOString(),
  }))

  // Holdings grouped per account (ascending), so we can take each account's latest
  // snapshot at or before a given date.
  const holdingsByAccount = new Map<number, { occurredAt: string; total: number }[]>()
  for (const h of holdingRows) {
    const list = holdingsByAccount.get(h.accountId) ?? []
    list.push({ occurredAt: h.occurredAt, total: Number(h.total) })
    holdingsByAccount.set(h.accountId, list)
  }
  const investmentsAsOf = (dateStr: string): number => {
    let sum = 0
    for (const list of holdingsByAccount.values()) {
      const latest = list.filter((s) => s.occurredAt <= dateStr).at(-1)
      if (latest) sum += latest.total
    }
    return sum
  }

  // Mortgage balance at a month-end: the projection's `actual` path (historical,
  // projected between snapshots); falls back to the current balance.
  const mortgageByYm = new Map<string, number>()
  if (mortgage) for (const p of mortgage.series) if (p.actual != null) mortgageByYm.set(p.ym, p.actual)
  const mortgageAsOf = (ym: string): number => mortgageByYm.get(ym) ?? mortgage?.currentBalance ?? 0

  const series = months.map((ym) => {
    const eom = lastDayOfMonth(ym)
    const chequing =
      (balanceAsOf('tangerine', chequingSnaps, flows, eom) ?? 0) +
      (balanceAsOf('scotia', chequingSnaps, flows, eom) ?? 0)
    const value = chequing + investmentsAsOf(eom) - mortgageAsOf(ym)
    return { ym, value: round2(value) }
  })

  // Headline = "now": current balances minus the current mortgage balance.
  const today = new Date().toISOString().slice(0, 10)
  const chequingNow =
    (balanceAsOf('tangerine', chequingSnaps, flows, today) ?? 0) +
    (balanceAsOf('scotia', chequingSnaps, flows, today) ?? 0)
  const investmentsNow = investmentsAsOf(today)
  const mortgageNow = mortgage?.currentBalance ?? 0

  return {
    hasData: chequingSnaps.length > 0 || holdingRows.length > 0,
    netWorth: round2(chequingNow + investmentsNow - mortgageNow),
    assets: { chequing: round2(chequingNow), investments: round2(investmentsNow) },
    liabilities: { mortgage: round2(mortgageNow) },
    series,
  }
}
