/**
 * When is the monthly INVESTMENT report "ready"? (§16b)
 *
 * Unlike the spend recap (which keys off the transaction anchor month), the
 * investment report keys off the **holdings snapshots**: a report is ready once
 * the latest snapshot is at least ~a month newer than the one before it, so
 * there's a real month-over-month change to show. Re-importing manually just
 * adds a fresh snapshot, so the report regenerates whenever a new snapshot lands
 * a month past the previous — exactly the "if I manually import, regenerate if
 * it's a month of difference" behaviour the owner asked for.
 *
 * Pure & db-free so the client reminder can import it; the loader passes the two
 * most recent snapshot dates (computed server-side).
 */

/** localStorage key: the YYYY-MM-DD of the latest snapshot the owner has seen. Device-local. */
export const INVESTMENT_REPORT_SEEN_KEY = 'investmentReportSeen'

/** Minimum gap (days) between the two snapshots for a report to be "a month of difference". */
const MIN_GAP_DAYS = 25

function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`).getTime()
  const db = new Date(`${b}T00:00:00`).getTime()
  return Math.abs(db - da) / 86_400_000
}

/**
 * The snapshot date to nag about — the latest snapshot — but only when it's at
 * least ~a month newer than the snapshot before it (so there's a real change to
 * report). Null when there's nothing new enough to compare. Callers pass the two
 * most-recent snapshot dates across all accounts (latest first).
 */
export function dueInvestmentReport(
  latestSnapshot: string | null | undefined,
  previousSnapshot: string | null | undefined,
): string | null {
  if (!latestSnapshot || !previousSnapshot) return null
  return daysBetween(latestSnapshot, previousSnapshot) >= MIN_GAP_DAYS ? latestSnapshot : null
}
