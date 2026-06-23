'use server'

import { revalidatePath } from 'next/cache'
import { and, asc, eq, inArray, notLike } from 'drizzle-orm'
import { db } from '@/db'
import { accountSnapshots, runwaySnapshots, transactions } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { isDemoSession } from '@/app/lib/demo'
import {
  accountBalances,
  fundTotal,
  historySeries,
  ACCOUNT_SOURCES,
  type BalanceSnapshot,
  type BankFlow,
  type FundSource,
  type AccountBalance,
} from '@/app/lib/emergency'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function revalidate() {
  revalidatePath('/goals')
  revalidatePath('/')
}

/**
 * Real imported bank flows for the two chequing accounts. Queries `transactions`
 * directly (NOT loadAllFlows, which drops card payments) because a card payment
 * or investment transfer out of the account really does change its balance.
 * Synthetic goal moves (externalId LIKE 'goal:%') are excluded — no real cash
 * moves for those, so they must not shift the fund. See BUSINESS_RULES.md §12.
 */
export async function loadBankFlows(): Promise<BankFlow[]> {
  const rows = await db
    .select({
      source: transactions.source,
      txnDate: transactions.txnDate,
      amount: transactions.amount,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.source, ['tangerine', 'scotia']),
        notLike(transactions.externalId, 'goal:%'),
      ),
    )
  return rows.map((r) => ({ source: r.source as FundSource, txnDate: r.txnDate, amount: Number(r.amount) }))
}

async function loadSnapshots(): Promise<BalanceSnapshot[]> {
  const rows = await db
    .select({
      source: accountSnapshots.source,
      balance: accountSnapshots.balance,
      occurredAt: accountSnapshots.occurredAt,
    })
    .from(accountSnapshots)
    .orderBy(asc(accountSnapshots.occurredAt))
  return rows.map((r) => ({ source: r.source as FundSource, balance: Number(r.balance), occurredAt: r.occurredAt }))
}

/**
 * Outstanding (unpaid) credit-card balance — money already committed but not yet
 * out of the bank, so the runway treats it as reducing available cash before the
 * statement is paid (and re-adjusts once it's paid). The Emergency Fund card (§12)
 * ignores this — only the runway nets it out.
 *
 * Per card (master, amex) we sum the **charges since the most recent payment**
 * (the current unpaid cycle): non-payment rows — charges +, refunds − — dated
 * after the last `is_payment` row. This avoids the all-time-net pitfall where
 * payments for pre-tracking charges leave a misleading negative baseline. With no
 * payment on record yet, the whole charge history counts. Summed, clamped ≥ 0.
 */
export async function loadOutstandingByCard(): Promise<{ master: number; amex: number }> {
  if (await isDemoSession()) {
    const { demoOutstandingByCard } = await import('@/app/lib/demo-data')
    return demoOutstandingByCard()
  }
  const rows = await db
    .select({
      source: transactions.source,
      amount: transactions.amount,
      txnDate: transactions.txnDate,
      isPayment: transactions.isPayment,
    })
    .from(transactions)
    .where(inArray(transactions.source, ['master', 'amex']))

  const perCard = (card: 'master' | 'amex'): number => {
    const cardRows = rows.filter((r) => r.source === card)
    const lastPayment = cardRows
      .filter((r) => r.isPayment)
      .reduce<string | null>((max, r) => (max === null || r.txnDate > max ? r.txnDate : max), null)
    const unpaid = cardRows
      .filter((r) => !r.isPayment && (lastPayment === null || r.txnDate > lastPayment))
      .reduce((s, r) => s + Number(r.amount), 0)
    return Math.max(0, Math.round(unpaid * 100) / 100)
  }
  return { master: perCard('master'), amex: perCard('amex') }
}

export async function loadOutstandingCardBalance(): Promise<number> {
  const { master, amex } = await loadOutstandingByCard()
  return Math.round((master + amex) * 100) / 100
}

export type EmergencyFundData = {
  hasData: boolean
  total: number
  accounts: AccountBalance[]
  series: { ym: string; total: number }[]
  asOfYm: string
}

export async function loadEmergencyFund(): Promise<EmergencyFundData> {
  if (await isDemoSession()) {
    const { demoEmergencyFund } = await import('@/app/lib/demo-data')
    return demoEmergencyFund()
  }
  const [snaps, flows] = await Promise.all([loadSnapshots(), loadBankFlows()])
  const dates = [...flows.map((f) => f.txnDate), ...snaps.map((s) => s.occurredAt), todayIso()]
  const asOfYm = dates.reduce((max, d) => (d > max ? d : max), dates[0]).slice(0, 7)
  return {
    hasData: snaps.length > 0,
    total: fundTotal(snaps, flows),
    accounts: accountBalances(snaps, flows),
    series: historySeries(snaps, flows, asOfYm),
    asOfYm,
  }
}

export type RunwayPoint = { date: string; months: number | null }

/**
 * Record today's worst-case runway (if it changed) and return the full history
 * for the trend chart. Tracking starts the first time the dashboard is viewed —
 * we keep at most one point per day (the latest value that day) and only append a
 * new day when the value moved. Mirrors the write-during-load pattern used by
 * `ensureMortgageGoal` / `reconcileNetZeroGoals`. No-op (returns synthetic) in demo.
 */
export async function recordAndLoadRunwayHistory(currentMonths: number | null): Promise<RunwayPoint[]> {
  if (await isDemoSession()) {
    const { demoRunwayHistory } = await import('@/app/lib/demo-data')
    return demoRunwayHistory()
  }
  const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10)
  const cur = round1(currentMonths)
  const toCell = (n: number | null) => (n === null ? null : n.toFixed(2))

  const rows = await db.select().from(runwaySnapshots).orderBy(asc(runwaySnapshots.occurredAt))
  const last = rows[rows.length - 1]
  const lastVal = last ? round1(last.months === null ? null : Number(last.months)) : undefined
  const today = todayIso()

  if (last && last.occurredAt === today) {
    if (lastVal !== cur) {
      await db.update(runwaySnapshots).set({ months: toCell(cur) }).where(eq(runwaySnapshots.id, last.id))
    }
  } else if (lastVal === undefined || lastVal !== cur) {
    await db.insert(runwaySnapshots).values({ occurredAt: today, months: toCell(cur) })
  }

  const fresh = await db.select().from(runwaySnapshots).orderBy(asc(runwaySnapshots.occurredAt))
  return fresh.map((r) => ({ date: r.occurredAt, months: r.months === null ? null : Number(r.months) }))
}

const SOURCES: FundSource[] = ACCOUNT_SOURCES.map((s) => s.source)

/** Insert a balance snapshot (used for both the starting balance and manual
 *  corrections — a correction is just a newer absolute snapshot). */
export async function recordBalance(input: {
  source: FundSource
  balance: number
  occurredAt?: string
  note?: string
}): Promise<void> {
  await requireAuth()
  if (!SOURCES.includes(input.source)) return
  const balance = Math.round(input.balance * 100) / 100
  if (!Number.isFinite(balance) || balance < 0) return
  await db.insert(accountSnapshots).values({
    source: input.source,
    balance: balance.toFixed(2),
    occurredAt: input.occurredAt || todayIso(),
    note: input.note?.trim() || null,
  })
  revalidate()
}
