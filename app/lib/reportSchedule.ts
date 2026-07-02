/**
 * When is a month "done"? Shared by the recap push (app/api/digest/route.ts) and
 * the in-app reminder (app/components/ReportReminder.tsx).
 *
 * Statement CSVs lag reality — a charge takes a few days to post — so we can't
 * trust a month the instant the calendar flips. But we don't need to *guess* a
 * settling window: the moment a transaction dated in a **newer** month shows up,
 * every pending charge from the prior month has necessarily already posted (a
 * pending charge can't be newer than one that's already on the statement). That
 * "newer month has data" signal is exactly the app's `anchorMonth` (the latest
 * month with transactions), so a month is final once it's strictly before the
 * anchor — see `completedNetPositiveMonths` in app/lib/surplus.ts.
 *
 * Pure & dependency-free on purpose so a client component can import it without
 * dragging in the db layer; callers pass the anchor (computed server-side).
 */

/** localStorage key holding the YYYY-MM the owner has already seen/dismissed. Device-local. */
export const REPORT_SEEN_KEY = 'reportReminderSeen'

/** localStorage key holding the YYYY Year-in-Review the owner has seen/dismissed. Device-local. */
export const YEAR_REPORT_SEEN_KEY = 'yearReportReminderSeen'

/** The month immediately before `ym` (YYYY-MM), handling year rollover. Pure. */
export function monthBefore(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  // m is 1-based; `m - 2` as a 0-based index is the previous month (Date normalizes <0).
  const d = new Date(y, m - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * The most-recently-completed month given the in-progress `anchor` (the latest
 * month with transactions): simply the month before it, since the anchor itself
 * is what proves the prior month is final. Null when there's no anchor yet.
 */
export function completedReportMonth(anchor: string | null | undefined): string | null {
  return anchor ? monthBefore(anchor) : null
}

/**
 * The Year-in-Review launched mid-2026, so 2025 was only ever partially tracked
 * and isn't worth a rewind. The first year we recap is 2026 (surfaced once
 * 2027 data lands). Older completed years are suppressed everywhere.
 */
export const FIRST_YEAR_REPORT_YEAR = 2026

/**
 * The most-recently-completed YEAR given the anchor: the year before the
 * anchor's, complete by the same argument as months — a transaction dated in the
 * new year proves every prior-year charge has posted. Null when no anchor yet,
 * or when the completed year predates {@link FIRST_YEAR_REPORT_YEAR}.
 */
export function completedYearReportYear(anchor: string | null | undefined): string | null {
  if (!anchor) return null
  const year = Number(anchor.slice(0, 4)) - 1
  return year >= FIRST_YEAR_REPORT_YEAR ? String(year) : null
}
