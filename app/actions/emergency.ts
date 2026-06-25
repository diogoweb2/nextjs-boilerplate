'use server'

import { revalidatePath } from 'next/cache'
import { and, asc, eq, inArray, notLike } from 'drizzle-orm'
import { db } from '@/db'
import {
  accountSnapshots,
  runwaySnapshots,
  transactions,
  holdingSnapshots,
  holdingPositions,
  registeredAccounts,
  emergencyConfig,
  type TfsaEmergencyMode,
} from '@/db/schema'
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
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.source, ['tangerine', 'scotia']),
        notLike(transactions.externalId, 'goal:%'),
      ),
    )
  return rows.map((r) => ({
    source: r.source as FundSource,
    txnDate: r.txnDate,
    amount: Number(r.amount),
    createdAt: r.createdAt.toISOString(),
  }))
}

async function loadSnapshots(): Promise<BalanceSnapshot[]> {
  // Only the chequing accounts come from manual snapshots now; the `investment`
  // line is DERIVED from TFSA holdings (loadTfsaInvestmentSnapshots), so any old
  // manual `investment` rows are ignored here.
  const rows = await db
    .select({
      source: accountSnapshots.source,
      balance: accountSnapshots.balance,
      occurredAt: accountSnapshots.occurredAt,
      createdAt: accountSnapshots.createdAt,
    })
    .from(accountSnapshots)
    .where(inArray(accountSnapshots.source, ['tangerine', 'scotia']))
    .orderBy(asc(accountSnapshots.occurredAt))
  return rows.map((r) => ({
    source: r.source as FundSource,
    balance: Number(r.balance),
    occurredAt: r.occurredAt,
    createdAt: r.createdAt.toISOString(),
  }))
}

/** A holding counts as a stable "cash-equivalent" reserve (money-market ETF, HISA
 *  ETF, etc.) when its asset class mentions cash. */
function isCashEquivalent(assetClass: string | null): boolean {
  return /cash/i.test(assetClass ?? '')
}

/**
 * TFSA holdings, summed per snapshot date across all TFSA accounts, split into the
 * WHOLE value and the CASH-EQUIVALENT-only value. A TFSA is fully withdrawable, so
 * it's emergency-accessible; the RESP is excluded (locked for education). The
 * `investment` fund line is derived from one of these (per the chosen mode), and
 * `hasCashNow` tells the UI whether a stable cash sleeve exists at all.
 */
async function loadTfsaFundSnapshots(): Promise<{
  whole: BalanceSnapshot[]
  cash: BalanceSnapshot[]
  hasCashNow: boolean
}> {
  const rows = await db
    .select({
      occurredAt: holdingSnapshots.occurredAt,
      createdAt: holdingSnapshots.createdAt,
      snapshotId: holdingSnapshots.id,
      accountId: holdingSnapshots.accountId,
      assetClass: holdingPositions.assetClass,
      mvCad: holdingPositions.marketValueCad,
    })
    .from(holdingPositions)
    .innerJoin(holdingSnapshots, eq(holdingPositions.snapshotId, holdingSnapshots.id))
    .innerJoin(registeredAccounts, eq(holdingSnapshots.accountId, registeredAccounts.id))
    .where(and(eq(registeredAccounts.kind, 'tfsa'), eq(registeredAccounts.archived, false)))
    .orderBy(asc(holdingSnapshots.occurredAt))

  // Re-importing the same file creates a new snapshot row each time. Pick the latest
  // snapshot per account per date so duplicate imports don't double-count positions.
  const latestSnapPerAccountDate = new Map<string, { snapshotId: number; createdAt: Date }>()
  for (const r of rows) {
    const key = `${r.accountId}:${r.occurredAt}`
    const cur = latestSnapPerAccountDate.get(key)
    if (!cur || r.createdAt > cur.createdAt) {
      latestSnapPerAccountDate.set(key, { snapshotId: r.snapshotId, createdAt: r.createdAt })
    }
  }
  const latestSnapIds = new Set([...latestSnapPerAccountDate.values()].map((v) => v.snapshotId))

  const byDate = new Map<string, { whole: number; cash: number; createdAt: string }>()
  for (const r of rows) {
    if (!latestSnapIds.has(r.snapshotId)) continue
    const iso = r.createdAt.toISOString()
    const cur = byDate.get(r.occurredAt) ?? { whole: 0, cash: 0, createdAt: iso }
    const v = Number(r.mvCad ?? 0)
    cur.whole += v
    if (isCashEquivalent(r.assetClass)) cur.cash += v
    if (iso > cur.createdAt) cur.createdAt = iso
    byDate.set(r.occurredAt, cur)
  }
  const dates = [...byDate.keys()].sort()
  const latest = dates.at(-1)
  const hasCashNow = latest ? (byDate.get(latest)!.cash > 0.005) : false

  const toSnaps = (pick: (v: { whole: number; cash: number }) => number): BalanceSnapshot[] =>
    [...byDate.entries()].map(([occurredAt, v]) => ({
      source: 'investment' as FundSource,
      balance: Math.round(pick(v) * 100) / 100,
      occurredAt,
      createdAt: v.createdAt,
    }))
  return { whole: toSnaps((v) => v.whole), cash: toSnaps((v) => v.cash), hasCashNow }
}

/** Read (or lazily create) the singleton emergency config. */
export async function getEmergencyConfig(): Promise<{ tfsaMode: TfsaEmergencyMode; haircutPct: number }> {
  const [row] = await db.select().from(emergencyConfig).limit(1)
  return {
    tfsaMode: (row?.tfsaMode as TfsaEmergencyMode) ?? 'crash_adjusted',
    haircutPct: row?.tfsaHaircutPct ?? 30,
  }
}

/** Switch the TFSA emergency-fund mode (crash-adjusted / cash reserve / whole). */
export async function setEmergencyTfsaMode(mode: TfsaEmergencyMode): Promise<void> {
  await requireAuth()
  if (mode !== 'cash_equivalent' && mode !== 'whole' && mode !== 'crash_adjusted') return
  const [row] = await db.select({ id: emergencyConfig.id }).from(emergencyConfig).limit(1)
  if (row) await db.update(emergencyConfig).set({ tfsaMode: mode, updatedAt: new Date() }).where(eq(emergencyConfig.id, row.id))
  else await db.insert(emergencyConfig).values({ tfsaMode: mode })
  revalidate()
}

/** Set the assumed crash drawdown (%) used by 'crash_adjusted' mode. Clamped 0–90. */
export async function setEmergencyTfsaHaircut(pct: number): Promise<void> {
  await requireAuth()
  if (!Number.isFinite(pct)) return
  const clamped = Math.round(Math.max(0, Math.min(90, pct)))
  const [row] = await db.select({ id: emergencyConfig.id }).from(emergencyConfig).limit(1)
  if (row) await db.update(emergencyConfig).set({ tfsaHaircutPct: clamped, updatedAt: new Date() }).where(eq(emergencyConfig.id, row.id))
  else await db.insert(emergencyConfig).values({ tfsaHaircutPct: clamped })
  revalidate()
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
  /** The owner's chosen TFSA mode (may be overridden when its sleeve is missing). */
  tfsaMode: TfsaEmergencyMode
  /** The mode actually applied (cash reserve falls back to crash-adjusted when no
   *  cash sleeve exists). */
  effectiveTfsaMode: TfsaEmergencyMode
  /** Assumed crash drawdown (%) applied in crash-adjusted mode. */
  tfsaHaircutPct: number
  /** True when a cash-equivalent holding exists, so the "Cash reserve" option works. */
  cashReserveAvailable: boolean
  /** Why the chosen mode was overridden (null when the choice was honoured). */
  tfsaModeReason: string | null
}

export async function loadEmergencyFund(): Promise<EmergencyFundData> {
  if (await isDemoSession()) {
    const { demoEmergencyFund } = await import('@/app/lib/demo-data')
    return demoEmergencyFund()
  }
  const [bankSnaps, tfsa, flows, config] = await Promise.all([
    loadSnapshots(),
    loadTfsaFundSnapshots(),
    loadBankFlows(),
    getEmergencyConfig(),
  ])
  // "Cash reserve" needs an actual cash-equivalent holding; if chosen but none
  // exists, fall back to the crash-adjusted whole TFSA (the safe default).
  const effectiveTfsaMode: TfsaEmergencyMode =
    config.tfsaMode === 'cash_equivalent' && !tfsa.hasCashNow ? 'crash_adjusted' : config.tfsaMode
  const factor = Math.max(0, 1 - config.haircutPct / 100)
  const tfsaSnaps =
    effectiveTfsaMode === 'cash_equivalent'
      ? tfsa.cash
      : effectiveTfsaMode === 'crash_adjusted'
        ? tfsa.whole.map((s) => ({ ...s, balance: Math.round(s.balance * factor * 100) / 100 }))
        : tfsa.whole
  const snaps = [...bankSnaps, ...tfsaSnaps]
  const dates = [...flows.map((f) => f.txnDate), ...snaps.map((s) => s.occurredAt), todayIso()]
  const asOfYm = dates.reduce((max, d) => (d > max ? d : max), dates[0]).slice(0, 7)
  return {
    hasData: snaps.length > 0,
    total: fundTotal(snaps, flows),
    accounts: accountBalances(snaps, flows),
    series: historySeries(snaps, flows, asOfYm),
    asOfYm,
    tfsaMode: config.tfsaMode,
    effectiveTfsaMode,
    tfsaHaircutPct: config.haircutPct,
    cashReserveAvailable: tfsa.hasCashNow,
    tfsaModeReason:
      config.tfsaMode === 'cash_equivalent' && !tfsa.hasCashNow
        ? 'Your TFSA holds no cash-equivalent position (e.g. a money-market ETF) right now, so there’s no stable reserve to isolate — using the crash-adjusted whole TFSA instead.'
        : null,
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
  // The `investment` line is derived from TFSA holdings now — not manually set.
  if (input.source === 'investment') return
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
