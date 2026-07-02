/**
 * Annual-subscription renewal watchdog (BUSINESS_RULES §18b). Pure & db-free like
 * subscription-watch.ts — operates on `loadAllFlows` rows plus the real "today".
 *
 * Purpose: an owner-declared yearly subscription (`merchants.recurring_annual`)
 * charges once a year, and it's easy to forget to cancel before the renewal hits.
 * This surfaces a dashboard warning ~1 month before the yearly charge is due so
 * the owner can decide whether to keep or cancel it.
 *
 * Rule (deterministic):
 *  - candidates are recurring-flagged annual merchants (declared `recurringAnnual`);
 *  - the renewal date = the merchant's latest charge date + 12 months;
 *  - a warning fires when that renewal is within the next `WINDOW_DAYS` (~1 month),
 *    with a small grace on the past side so a just-lapsed renewal (charge not yet
 *    posted) still shows rather than vanishing exactly on the due date;
 *  - once the yearly charge posts, the latest charge date advances, the renewal
 *    jumps ~12 months out, and the warning clears on its own.
 *
 * The owner can dismiss a warning; the dismissal is keyed to the renewal cycle
 * (merchant + renewal month), so next year's renewal warns again. It persists in
 * the DB (subscription_renewal_dismissals), so it's honoured across devices.
 */
import type { EnrichedTxn } from '@/app/lib/analytics'

/** Days before the renewal date the warning starts showing. */
export const WINDOW_DAYS = 31
/** Grace after the renewal date (charge may not have posted yet) before it drops. */
const GRACE_DAYS = 7

/** An owner dismissal of a specific renewal cycle (a DB row). */
export type RenewalDismissal = { merchantId: number; renewalYm: string }

export type RenewalWarning = {
  merchantId: number
  name: string
  /** Last time the yearly charge posted (YYYY-MM-DD). */
  lastChargeDate: string
  /** Projected next renewal date (YYYY-MM-DD) = lastChargeDate + 12 months. */
  renewalDate: string
  /** YYYY-MM the renewal falls in — the dismissal signature. */
  renewalYm: string
  /** The last yearly amount charged (what they'll pay again). */
  amount: number
  /** Whole days from today until the renewal (negative = already due). */
  daysUntil: number
}

const MS_PER_DAY = 86_400_000

/** Parse a YYYY-MM-DD string as a UTC midnight timestamp (TZ-stable). */
function parseUtc(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** Add whole calendar months to a YYYY-MM-DD date, clamping the day of month. */
function addMonthsToDate(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  const total = (y * 12 + (m - 1)) + months
  const ny = Math.floor(total / 12)
  const nm = total % 12
  // Clamp for shorter months (e.g. Jan 31 + 12mo is fine; guards leap-day edge).
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate()
  const nd = Math.min(d, lastDay)
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`
}

export function buildRenewalWarnings(
  all: EnrichedTxn[],
  todayIso: string,
  dismissals: RenewalDismissal[] = []
): RenewalWarning[] {
  const dismissedYm = new Map<number, string>()
  for (const d of dismissals) dismissedYm.set(d.merchantId, d.renewalYm)

  // Latest charge date (and that day's total) per declared-annual recurring merchant.
  type Agg = { name: string; lastDate: string; amountOnLast: number }
  const byMerchant = new Map<number, Agg>()
  for (const t of all) {
    if (t.flow !== 'expense' || t.amount <= 0) continue
    if (!t.isRecurring || !t.recurringAnnual) continue
    const date = t.txnDate.slice(0, 10)
    const a = byMerchant.get(t.merchantId)
    if (!a) {
      byMerchant.set(t.merchantId, { name: t.merchantName, lastDate: date, amountOnLast: t.amount })
    } else if (date > a.lastDate) {
      a.lastDate = date
      a.amountOnLast = t.amount
    } else if (date === a.lastDate) {
      // Same-day split rows: sum them into the yearly charge.
      a.amountOnLast += t.amount
    }
  }

  const today = parseUtc(todayIso)
  const warnings: RenewalWarning[] = []
  for (const [merchantId, a] of byMerchant) {
    const renewalDate = addMonthsToDate(a.lastDate, 12)
    const daysUntil = Math.round((parseUtc(renewalDate) - today) / MS_PER_DAY)
    if (daysUntil > WINDOW_DAYS || daysUntil < -GRACE_DAYS) continue
    const renewalYm = renewalDate.slice(0, 7)
    if (dismissedYm.get(merchantId) === renewalYm) continue
    warnings.push({
      merchantId,
      name: a.name,
      lastChargeDate: a.lastDate,
      renewalDate,
      renewalYm,
      amount: Math.round(a.amountOnLast * 100) / 100,
      daysUntil,
    })
  }

  // Soonest renewal first.
  warnings.sort((x, y) => x.daysUntil - y.daysUntil)
  return warnings
}
