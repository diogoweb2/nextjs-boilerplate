/**
 * Bills & recurring calendar (BUSINESS_RULES §19). Pure & db-free like
 * projection.ts — operates on `loadAllFlows` rows, the confirmed projection
 * rules, and the real "today".
 *
 * A calendar for month `ym` lists every bill expected to hit that month, each
 * placed on its expected day:
 *  - merchants in the fixed categories (Home: Mortgage, Property Tax, Hydro…),
 *    each treated as its own bill with an inferred cadence;
 *  - every enabled projection rule (Belair, Koodo, subscriptions, E-Transfer
 *    bills like trailer storage — anything the owner confirmed as recurring);
 *  - a "Credit card payment" pseudo-bill built from the bank-side payment rows
 *    toward tracked cards (they're excluded from analytics, so they're passed
 *    in separately as `ccPayments`).
 *
 * The expected day is the bill's MOST COMMON posting day-of-month in history
 * (exact dates aren't knowable; per the owner, "most common day" is fine).
 * Amounts come from the projection engine and are replaced by the ACTUAL total
 * (and actual day) once the real transaction posts. Status per bill:
 *  paid = posted this month · due = expected day still ahead · missed =
 *  expected day passed with nothing posted (the per-bill "didn't appear" check).
 *
 * Paydays: actual income posts are marked on their real days; for days still
 * ahead, monthly income merchants are projected onto their most common day.
 */
import type { EnrichedTxn } from '@/app/lib/analytics'
import {
  type ProjectionRule,
  type Cadence,
  type AmountMode,
  projectedAmountForMonth,
  inferGap,
  daysInMonth,
  addMonths,
} from '@/app/lib/projection'

/** Days before a bill's expected date the dashboard warning starts showing. */
export const BILL_WARN_DAYS = 2

/**
 * Income categories that are never paydays: insurance claim payouts (Canada
 * Life under Insurance; Manulife/Sun Life under Dental) are reimbursements —
 * there's no knowing whether one will arrive in a month, so they don't belong
 * on the calendar at all (per the owner). Income credited against an
 * expense-kind category (a category credit, §analytics) is excluded for the
 * same reason regardless of name.
 */
const EXCLUDED_INCOME_CATEGORIES = new Set(['Insurance', 'Dental'])

export type BillStatus = 'paid' | 'due' | 'missed'

export type CalendarBill = {
  /** Dismissal/identity key: 'm:<merchantId>' or 'cc' for the card payment. */
  billKey: string
  merchantId: number | null
  label: string
  /** Actual posted total when paid, else the projected amount. */
  amount: number
  /** Actual posting day when paid, else the inferred most-common day. */
  day: number
  date: string
  status: BillStatus
  cadence: Cadence
}

export type Payday = { day: number; label: string; amount: number; actual: boolean }

export type BillCalendar = {
  ym: string
  bills: CalendarBill[]
  paydays: Payday[]
  totalPaid: number
  totalUpcoming: number
}

/** A bank-side payment toward a tracked credit card (excluded from allFlows). */
export type CcPayment = { date: string; amount: number }

/** An owner dismissal of one bill-reminder cycle (a bill_reminder_dismissals row). */
export type BillDismissal = { billKey: string; dueYm: string }

export type BillReminder = {
  billKey: string
  merchantId: number | null
  label: string
  amount: number
  dueDate: string
  /** YYYY-MM the due date falls in — the dismissal signature. */
  dueYm: string
  daysUntil: number
}

// --- tiny helpers (duplicated to stay db-free, as projection.ts does) ---
function monthKey(d: string): string {
  return d.slice(0, 7)
}
function dayOf(d: string): number {
  return Number(d.slice(8, 10))
}
function mean(ns: number[]): number {
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function isoFor(ym: string, day: number): string {
  return `${ym}-${String(Math.min(day, daysInMonth(ym))).padStart(2, '0')}`
}

const MS_PER_DAY = 86_400_000
function parseUtc(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/**
 * Most common posting day-of-month among dated occurrences (up to the 12 most
 * recent); ties go to the most recent occurrence's day. Defaults to 1.
 */
export function mostCommonDay(dates: string[]): number {
  const recent = [...dates].sort().slice(-12)
  const count = new Map<number, number>()
  let best = 1
  let bestCount = 0
  for (const d of recent) {
    const day = dayOf(d)
    const c = (count.get(day) ?? 0) + 1
    count.set(day, c)
    // ≥ so later (more recent) dates win ties.
    if (c >= bestCount) {
      best = day
      bestCount = c
    }
  }
  return best
}

function statusFor(date: string, actual: boolean, todayIso: string): BillStatus {
  if (actual) return 'paid'
  return date >= todayIso.slice(0, 10) ? 'due' : 'missed'
}

/** Per-merchant expense history: months → totals, plus every posting date. */
type MerchantHistory = {
  merchantId: number
  name: string
  months: Map<string, number>
  dates: string[]
}

function merchantHistories(all: EnrichedTxn[], include: (t: EnrichedTxn) => boolean): Map<number, MerchantHistory> {
  const out = new Map<number, MerchantHistory>()
  for (const t of all) {
    if (t.flow !== 'expense' || t.amount <= 0 || !include(t)) continue
    let h = out.get(t.merchantId)
    if (!h) {
      h = { merchantId: t.merchantId, name: t.merchantName, months: new Map(), dates: [] }
      out.set(t.merchantId, h)
    }
    const ym = monthKey(t.txnDate)
    h.months.set(ym, (h.months.get(ym) ?? 0) + t.amount)
    h.dates.push(t.txnDate)
  }
  return out
}

function cadenceFromGap(gap: number): Cadence {
  return gap === 1 ? 'monthly' : gap === 3 ? 'quarterly' : gap >= 11 ? 'annual' : 'periodic'
}

/** Synthetic rule for a fixed-category merchant (same heuristics as suggestions). */
function syntheticRule(h: MerchantHistory): ProjectionRule {
  const occ = [...h.months.keys()].sort()
  const cadence = cadenceFromGap(inferGap(occ))
  const vals = [...h.months.values()]
  const m = mean(vals)
  const cv = m > 0 ? Math.sqrt(mean(vals.map((v) => (v - m) ** 2))) / m : 0
  const amountMode: AmountMode = cadence === 'monthly' && cv > 0.25 ? 'seasonal' : 'average'
  return { merchantId: h.merchantId, merchantName: h.name, label: h.name, cadence, amountMode, fixedAmount: null }
}

function billFromRule(
  rule: ProjectionRule,
  all: EnrichedTxn[],
  dates: string[],
  ym: string,
  todayIso: string
): CalendarBill | null {
  const { amount, actual } = projectedAmountForMonth(rule, all, ym)
  if (amount <= 0) return null
  const inMonth = dates.filter((d) => monthKey(d) === ym).sort()
  const day = actual && inMonth.length ? dayOf(inMonth[inMonth.length - 1]) : mostCommonDay(dates)
  const date = isoFor(ym, day)
  return {
    billKey: `m:${rule.merchantId}`,
    merchantId: rule.merchantId,
    label: rule.label,
    amount,
    day: dayOf(date),
    date,
    status: statusFor(date, actual, todayIso),
    cadence: rule.cadence,
  }
}

/** The credit-card payment pseudo-bill (manual monthly payment to tracked cards). */
function ccBill(ccPayments: CcPayment[], ym: string, todayIso: string): CalendarBill | null {
  if (ccPayments.length === 0) return null
  const months = new Map<string, number>()
  for (const p of ccPayments) {
    const k = monthKey(p.date)
    months.set(k, (months.get(k) ?? 0) + p.amount)
  }
  const posted = ccPayments.filter((p) => monthKey(p.date) === ym).map((p) => p.date).sort()
  const paid = months.get(ym)
  const occ = [...months.keys()].filter((k) => k !== ym).sort()
  if (paid === undefined && occ.length < 2) return null

  const amount =
    paid !== undefined
      ? paid
      : mean(occ.slice(-3).map((k) => months.get(k) ?? 0))
  const day =
    paid !== undefined
      ? dayOf(posted[posted.length - 1])
      : mostCommonDay(ccPayments.filter((p) => monthKey(p.date) !== ym).map((p) => p.date))
  const date = isoFor(ym, day)
  return {
    billKey: 'cc',
    merchantId: null,
    label: 'Credit card payment',
    amount: round2(amount),
    day: dayOf(date),
    date,
    status: statusFor(date, paid !== undefined, todayIso),
    cadence: 'monthly',
  }
}

/** Actual + projected paydays for `ym` from income history (stored negative). */
function buildPaydays(all: EnrichedTxn[], ym: string, todayIso: string): Payday[] {
  type Inc = { name: string; months: Map<string, number>; dates: string[] }
  const byMerchant = new Map<number, Inc>()
  const paydays: Payday[] = []
  for (const t of all) {
    const amount = -t.amount // income stored negative
    if (t.flow !== 'income' || amount <= 0) continue
    if (EXCLUDED_INCOME_CATEGORIES.has(t.categoryName) || t.categoryKind === 'expense') continue
    let h = byMerchant.get(t.merchantId)
    if (!h) {
      h = { name: t.merchantName, months: new Map(), dates: [] }
      byMerchant.set(t.merchantId, h)
    }
    h.months.set(monthKey(t.txnDate), (h.months.get(monthKey(t.txnDate)) ?? 0) + amount)
    h.dates.push(t.txnDate)
    if (monthKey(t.txnDate) === ym) {
      paydays.push({ day: dayOf(t.txnDate), label: t.merchantName, amount, actual: true })
    }
  }
  // Project monthly income sources not yet posted this month (day still ahead).
  for (const h of byMerchant.values()) {
    if (h.months.has(ym)) continue
    const occ = [...h.months.keys()].sort()
    if (occ.length < 2 || inferGap(occ) !== 1) continue
    const day = mostCommonDay(h.dates)
    if (isoFor(ym, day) < todayIso.slice(0, 10)) continue
    paydays.push({
      day,
      label: h.name,
      amount: round2(mean(occ.slice(-3).map((k) => h.months.get(k) ?? 0))),
      actual: false,
    })
  }
  return paydays.sort((a, b) => a.day - b.day)
}

export function buildBillCalendar(
  all: EnrichedTxn[],
  rules: ProjectionRule[],
  ym: string,
  fixedCats: string[],
  ccPayments: CcPayment[],
  todayIso: string
): BillCalendar {
  const bills: CalendarBill[] = []
  const ruleIds = new Set(rules.map((r) => r.merchantId))

  // 1. Fixed-category merchants (Home), each on its own inferred cadence/day.
  //    Rule merchants are skipped here — the rule is the source of truth.
  const fixedSet = new Set(fixedCats)
  const fixed = merchantHistories(all, (t) => fixedSet.has(t.categoryName))
  for (const h of fixed.values()) {
    if (ruleIds.has(h.merchantId) || h.months.size < 2) continue
    const bill = billFromRule(syntheticRule(h), all, h.dates, ym, todayIso)
    if (bill) bills.push(bill)
  }

  // 2. Confirmed projection rules (bills, subscriptions, manual E-Transfers…).
  const ruleHist = merchantHistories(all, (t) => ruleIds.has(t.merchantId))
  for (const r of rules) {
    const bill = billFromRule(r, all, ruleHist.get(r.merchantId)?.dates ?? [], ym, todayIso)
    if (bill) bills.push(bill)
  }

  // 3. The manual credit-card payment.
  const cc = ccBill(ccPayments, ym, todayIso)
  if (cc) bills.push(cc)

  bills.sort((a, b) => a.day - b.day || b.amount - a.amount)
  // The CC payment stays on the grid but is EXCLUDED from the money totals — it
  // repays card spending (including the card-billed bills above), so summing it
  // would double-count and dwarf the real bills.
  const counted = bills.filter((b) => b.billKey !== 'cc')
  return {
    ym,
    bills,
    paydays: buildPaydays(all, ym, todayIso),
    totalPaid: round2(counted.filter((b) => b.status === 'paid').reduce((s, b) => s + b.amount, 0)),
    totalUpcoming: round2(counted.filter((b) => b.status !== 'paid').reduce((s, b) => s + b.amount, 0)),
  }
}

/**
 * Dashboard warnings: bills due within `BILL_WARN_DAYS` of today (spanning the
 * month boundary — a bill due on the 1st warns from the 29th/30th). A warning
 * disappears on its own once the payment posts (status flips to 'paid'), or
 * when the owner dismisses that cycle (billKey + dueYm).
 */
export function buildBillReminders(
  all: EnrichedTxn[],
  rules: ProjectionRule[],
  fixedCats: string[],
  ccPayments: CcPayment[],
  todayIso: string,
  dismissals: BillDismissal[] = []
): BillReminder[] {
  const today = todayIso.slice(0, 10)
  const todayYm = monthKey(today)
  const dismissed = new Map(dismissals.map((d) => [d.billKey, d.dueYm]))

  const reminders: BillReminder[] = []
  for (const ym of [todayYm, addMonths(todayYm, 1)]) {
    const cal = buildBillCalendar(all, rules, ym, fixedCats, ccPayments, todayIso)
    for (const b of cal.bills) {
      if (b.status !== 'due') continue
      const daysUntil = Math.round((parseUtc(b.date) - parseUtc(today)) / MS_PER_DAY)
      if (daysUntil < 0 || daysUntil > BILL_WARN_DAYS) continue
      if (dismissed.get(b.billKey) === ym) continue
      reminders.push({
        billKey: b.billKey,
        merchantId: b.merchantId,
        label: b.label,
        amount: b.amount,
        dueDate: b.date,
        dueYm: ym,
        daysUntil,
      })
    }
  }
  return reminders.sort((a, b) => a.daysUntil - b.daysUntil || b.amount - a.amount)
}
