/**
 * Emergency Fund math — pure & db-free (mirrors app/lib/mortgage.ts). The fund is
 * the cash sitting in the two chequing accounts (Tangerine + Scotia). We track it
 * from owner-entered ABSOLUTE balance snapshots, projecting forward with the net
 * of real imported bank flows. A manual correction is just a newer snapshot, so
 * it re-anchors and absorbs any drift. See BUSINESS_RULES.md §12.
 *
 * Sign: bank CSV amounts are stored NEGATED (positive = money out), so a row's
 * real cash delta on the account is `-amount` (a salary deposit raises the
 * balance; a card payment / investment transfer lowers it).
 *
 * Same-day boundary (causality, not just date): a snapshot reflects everything
 * the system knew when it was RECORDED, so a flow dated on the snapshot's own day
 * counts only if it was imported AFTER the snapshot (`flow.createdAt >
 * snapshot.createdAt`). This lets a transfer imported the same day you seeded the
 * starting balance still lower the fund, while a manual correction you type AFTER
 * a transfer is already imported doesn't double-subtract it. See BUSINESS_RULES §12.
 */

/** Emergency-fund account sources. `tangerine`/`scotia` auto-track from imported
 *  bank flows (and accept manual corrections). `investment` is now DERIVED from
 *  the TFSA holdings snapshots (a TFSA is fully withdrawable, so it's emergency-
 *  accessible cash) — `derived` sources have no manual control. The RESP is
 *  intentionally excluded (locked for the kids' education). See BUSINESS_RULES §12. */
export type FundSource = 'tangerine' | 'scotia' | 'investment'

export const ACCOUNT_SOURCES: { source: FundSource; label: string; autoTracked: boolean; derived?: boolean }[] = [
  { source: 'tangerine', label: 'Tangerine', autoTracked: true },
  { source: 'scotia', label: 'Scotia', autoTracked: true },
  { source: 'investment', label: 'TFSA (iTrade)', autoTracked: true, derived: true },
]

// occurredAt is the balance date (YYYY-MM-DD); createdAt is the row's insert
// timestamp (ISO), used to order same-day flows vs snapshots (see header).
export type BalanceSnapshot = { source: FundSource; balance: number; occurredAt: string; createdAt: string }
export type BankFlow = { source: FundSource; txnDate: string; amount: number; createdAt: string } // amount = stored (negated)

export type AccountBalance = { source: FundSource; label: string; balance: number; since: string }

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m, 0).getDate()
  return `${ym}-${String(d).padStart(2, '0')}`
}

/** Latest snapshot for `source` at or before `dateStr` (null if none yet). Ties on
 *  the same day are broken by createdAt, so the most recently recorded wins. */
function baseSnapshot(source: FundSource, snaps: BalanceSnapshot[], dateStr: string): BalanceSnapshot | null {
  const prior = snaps
    .filter((s) => s.source === source && s.occurredAt <= dateStr)
    .sort((a, b) => (a.occurredAt !== b.occurredAt ? (a.occurredAt < b.occurredAt ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
  return prior.length ? prior[prior.length - 1] : null
}

/**
 * Balance of one account as of `dateStr`: the latest snapshot ≤ dateStr plus the
 * net of bank flows that belong after it, up to dateStr. A flow belongs after the
 * base snapshot when it is dated after the snapshot's day, OR dated on the same
 * day but imported after the snapshot was recorded (createdAt) — so a transfer
 * imported the same day you seeded the balance still moves the fund, without a
 * later manual correction double-counting it. Null until the account has its
 * first (starting-balance) snapshot.
 */
export function balanceAsOf(
  source: FundSource,
  snaps: BalanceSnapshot[],
  flows: BankFlow[],
  dateStr: string,
): number | null {
  const base = baseSnapshot(source, snaps, dateStr)
  if (!base) return null
  let bal = base.balance
  for (const f of flows) {
    if (f.source !== source || f.txnDate > dateStr) continue
    const afterBase =
      f.txnDate > base.occurredAt || (f.txnDate === base.occurredAt && f.createdAt > base.createdAt)
    if (afterBase) bal += -f.amount
  }
  return round2(bal)
}

/** Current balance per account (only sources that have a starting snapshot). */
export function accountBalances(snaps: BalanceSnapshot[], flows: BankFlow[]): AccountBalance[] {
  const asOf = '9999-12-31'
  return ACCOUNT_SOURCES.flatMap(({ source, label }) => {
    const base = baseSnapshot(source, snaps, asOf)
    if (!base) return []
    return [{ source, label, balance: balanceAsOf(source, snaps, flows, asOf) ?? 0, since: base.occurredAt }]
  })
}

/** Total emergency fund = Σ current account balances. */
export function fundTotal(snaps: BalanceSnapshot[], flows: BankFlow[]): number {
  return round2(accountBalances(snaps, flows).reduce((s, a) => s + a.balance, 0))
}

/**
 * Month-end fund total from the earliest snapshot month through `asOfYm`, for the
 * history line chart. Sources with no snapshot yet contribute 0 that month.
 */
export function historySeries(
  snaps: BalanceSnapshot[],
  flows: BankFlow[],
  asOfYm: string,
): { ym: string; total: number }[] {
  if (snaps.length === 0) return []
  const startYm = snaps
    .map((s) => s.occurredAt.slice(0, 7))
    .reduce((min, ym) => (ym < min ? ym : min), snaps[0].occurredAt.slice(0, 7))
  const endYm = asOfYm >= startYm ? asOfYm : startYm

  const out: { ym: string; total: number }[] = []
  for (let ym = startYm; ym <= endYm; ym = addMonths(ym, 1)) {
    const eom = lastDayOfMonth(ym)
    const total = ACCOUNT_SOURCES.reduce((s, { source }) => s + (balanceAsOf(source, snaps, flows, eom) ?? 0), 0)
    out.push({ ym, total: round2(total) })
  }
  return out
}
