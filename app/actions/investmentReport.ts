'use server'

import { and, asc, desc, eq, gt } from 'drizzle-orm'
import { db } from '@/db'
import {
  registeredAccounts,
  holdingSnapshots,
  holdingPositions,
  registeredContributions,
} from '@/db/schema'
import { isDemoSession } from '@/app/lib/demo'
import { toCad } from '@/app/lib/holdings'
import {
  buildInvestmentReport,
  type InvestmentReport,
  type ReportAccountInput,
  type ReportSnapshot,
} from '@/app/lib/investmentReport'
import { dueInvestmentReport } from '@/app/lib/investmentReportSchedule'

const SELF_NAME = process.env.SELF_NAME || 'Me'
const PARTNER_NAME = process.env.PARTNER_NAME || 'Partner'
const MIN_BASELINE_GAP_DAYS = 25

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime()) / 86_400_000
}

/** Load the positions of a snapshot as CAD-valued ReportPositions. */
async function snapshotWithPositions(snap: {
  id: number
  occurredAt: string
  fxUsdCad: string
  totalValueCad: string
}): Promise<ReportSnapshot> {
  const fx = Number(snap.fxUsdCad)
  const rows = await db.select().from(holdingPositions).where(eq(holdingPositions.snapshotId, snap.id))
  return {
    occurredAt: snap.occurredAt,
    fxUsdCad: fx,
    totalValueCad: Number(snap.totalValueCad),
    positions: rows.map((p) => ({
      symbol: p.symbol,
      name: p.name ?? '',
      assetClass: p.assetClass ?? '',
      currency: p.currency,
      quantity: Number(p.quantity ?? 0),
      marketValueCad: Number(p.marketValueCad ?? 0),
      bookValueCad: toCad(Number(p.bookValue ?? 0), p.currency, fx),
    })),
  }
}

/**
 * Assemble the inputs and build the monthly investment report (§16b). For each
 * registered account it pairs the latest holdings snapshot with the newest one
 * at least ~a month older, plus the net contributions in that window (so market
 * change can be separated from new deposits). Pure math lives in
 * app/lib/investmentReport.ts.
 */
export async function loadInvestmentReport(): Promise<InvestmentReport> {
  if (await isDemoSession()) {
    const { demoInvestmentReport } = await import('@/app/lib/demo-data')
    return demoInvestmentReport()
  }

  const accounts = await db
    .select()
    .from(registeredAccounts)
    .where(eq(registeredAccounts.archived, false))
    .orderBy(asc(registeredAccounts.sortOrder), asc(registeredAccounts.createdAt))

  const inputs: ReportAccountInput[] = []
  for (const a of accounts) {
    const snaps = await db
      .select()
      .from(holdingSnapshots)
      .where(eq(holdingSnapshots.accountId, a.id))
      .orderBy(asc(holdingSnapshots.occurredAt))
    if (snaps.length === 0) continue

    const latestSnap = snaps[snaps.length - 1]
    // The newest snapshot at least ~a month older than the latest.
    const baselineSnap =
      [...snaps]
        .slice(0, -1)
        .reverse()
        .find((s) => daysBetween(latestSnap.occurredAt, s.occurredAt) >= MIN_BASELINE_GAP_DAYS) ?? null

    const current = await snapshotWithPositions(latestSnap)
    const previous = baselineSnap ? await snapshotWithPositions(baselineSnap) : null

    // Net contributions (in − out) strictly after the baseline date.
    let contributionsInWindow = 0
    if (baselineSnap) {
      const contribs = await db
        .select()
        .from(registeredContributions)
        .where(
          and(
            eq(registeredContributions.accountId, a.id),
            gt(registeredContributions.occurredAt, baselineSnap.occurredAt),
          ),
        )
      contributionsInWindow = contribs.reduce(
        (s, c) => s + (c.kind === 'withdrawal' ? -Number(c.amount) : Number(c.amount)),
        0,
      )
    }

    inputs.push({
      id: a.id,
      name: a.name,
      kind: a.kind,
      ownerName: a.owner === 'partner' ? PARTNER_NAME : SELF_NAME,
      current,
      previous,
      valueSeries: snaps.map((s) => ({ occurredAt: s.occurredAt, value: Number(s.totalValueCad) })),
      contributionsInWindow: Math.round(contributionsInWindow * 100) / 100,
    })
  }

  return buildInvestmentReport(inputs)
}

/**
 * The latest snapshot date to nag about on the dashboard — only when the latest
 * snapshot is ~a month newer than the one before it (a real month-over-month
 * change). Reads just the two most-recent snapshot dates across all accounts.
 */
export async function loadInvestmentReportDue(): Promise<string | null> {
  if (await isDemoSession()) return null
  const recent = await db
    .select({ occurredAt: holdingSnapshots.occurredAt })
    .from(holdingSnapshots)
    .orderBy(desc(holdingSnapshots.occurredAt))
    .limit(2)
  if (recent.length < 2) return null
  return dueInvestmentReport(recent[0].occurredAt, recent[1].occurredAt)
}
