/**
 * "Safe to move" cash-flow projection — how much cash can leave a chequing
 * account for investment today without dipping below a comfort buffer before
 * income replenishes it. Pure & db-free (operates on `loadAllFlows` rows +
 * projection rules), like runway.ts / projection.ts, so it can be unit-tested and
 * its `projectAccount` reused by the client widget for live recompute as the
 * owner types an "unplanned expense". See BUSINESS_RULES.md §14.
 *
 * Model: build a forward calendar of scheduled events per account (income in,
 * bills + the current credit-card payment out), walk a ~45-day window day-by-day,
 * and take the LOWEST running balance (the trough). Everything above
 * `trough − buffer` is safe to move. Income amounts are positive inflows; bill/cc
 * amounts are positive magnitudes turned into outflows by `kind`.
 *
 * Inference is best-effort (typical day-of-month + recent-average amount from
 * history); the widget's editor lets the owner correct any of it, persisted as
 * overrides — so the schedule is "infer + edit".
 */
import type { EnrichedTxn } from '@/app/lib/analytics'
import { projectedAmountForMonth, type ProjectionRule } from '@/app/lib/projection'

/** The two chequing accounts cash can be moved out of (the manual investment
 *  source isn't a chequing account). */
export type Account = 'tangerine' | 'scotia'
export type CardSource = 'master' | 'amex'
export type EventKind = 'income' | 'bill' | 'cc'

/** One recurring money event on an account, with an inferred next occurrence. */
export type ScheduledEvent = {
  /** Stable id used to attach owner overrides (e.g. 'bill:42', 'cc:master'). */
  key: string
  account: Account
  kind: EventKind
  label: string
  /** Typical day of month it lands (1..31), kept for the editor & re-projection. */
  dayOfMonth: number
  /** Positive magnitude; the projection signs it by `kind`. */
  amount: number
  /** 1 = monthly, 3 = quarterly, 12 = annual (income/cc are always monthly). */
  cadenceMonths: number
  /** First occurrence on/after `today`, ISO date — drives the projection walk. */
  nextDue: string
}

/** Per-account override the owner saved in the editor (all fields optional). */
export type EventOverride = {
  key: string
  account?: Account
  dayOfMonth?: number
  amount?: number
  /** false = ignore this event entirely. */
  enabled?: boolean
}

export type CardAccounts = Record<CardSource, Account>

export const ACCOUNT_LABELS: Record<Account, string> = { tangerine: 'Tangerine', scotia: 'Scotia' }

/** Default which bank pays each card until the owner sets it in the editor.
 *  The owner pays BOTH cards from Tangerine. */
export const DEFAULT_CARD_ACCOUNTS: CardAccounts = { master: 'tangerine', amex: 'tangerine' }

/** Owner pays both cards around the 11th; this is the most important date to be
 *  covered for. Overridable in the editor / config. */
export const DEFAULT_CC_PAYMENT_DAY = 11

/** Combined $ added to the card payment for charges still "pending" on the card
 *  that haven't exported to CSV yet — a safety margin so we don't under-count. */
export const DEFAULT_CC_PENDING_BUFFER = 400

const HORIZON_DAYS = 45

// ---------- tiny date/stat helpers (db-free, like projection.ts) ----------
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function monthKey(d: string): string {
  return d.slice(0, 7)
}
function dayOf(d: string): number {
  return Number(d.slice(8, 10))
}
function daysInYm(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m, 0).getDate()
}
function addMonthsYm(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}
function monthDiffYm(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number)
  const [yb, mb] = b.split('-').map(Number)
  return yb * 12 + mb - (ya * 12 + ma)
}
/** A date in `ym` on `day`, clamped to the month's length (e.g. 31 → Feb 28). */
function dateInMonth(ym: string, day: number): string {
  const d = Math.min(Math.max(1, day), daysInYm(ym))
  return `${ym}-${String(d).padStart(2, '0')}`
}
function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}
function median(ns: number[]): number {
  if (!ns.length) return 0
  const s = [...ns].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
function mean(ns: number[]): number {
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0
}
function mode<T>(xs: T[]): T | null {
  const counts = new Map<T, number>()
  let best: T | null = null
  let bestN = 0
  for (const x of xs) {
    const n = (counts.get(x) ?? 0) + 1
    counts.set(x, n)
    if (n > bestN) {
      bestN = n
      best = x
    }
  }
  return best
}

/** The first occurrence on/after `today` for a day-of-month + cadence, anchored
 *  on the most recent past occurrence month so quarterly/annual bills land right. */
function nextDueDate(today: string, dayOfMonth: number, cadenceMonths: number, lastMonth: string | null): string {
  const todayYm = monthKey(today)
  if (cadenceMonths <= 1 || !lastMonth) {
    const thisMonth = dateInMonth(todayYm, dayOfMonth)
    return thisMonth >= today ? thisMonth : dateInMonth(addMonthsYm(todayYm, 1), dayOfMonth)
  }
  // Step from the last seen month by the cadence until we reach/pass today.
  let ym = lastMonth
  let guard = 0
  while (guard++ < 240) {
    const cand = dateInMonth(ym, dayOfMonth)
    if (cand >= today) return cand
    ym = addMonthsYm(ym, cadenceMonths)
  }
  return dateInMonth(todayYm, dayOfMonth)
}

/** Median month-gap between consecutive occurrence months → a cadence in months. */
function inferCadenceMonths(occMonths: string[]): number {
  if (occMonths.length < 2) return 1
  const sorted = [...new Set(occMonths)].sort()
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const [ya, ma] = sorted[i - 1].split('-').map(Number)
    const [yb, mb] = sorted[i].split('-').map(Number)
    gaps.push(yb * 12 + mb - (ya * 12 + ma))
  }
  return Math.max(1, median(gaps))
}

// ---------- inference ----------

type Occurrence = { date: string; amount: number; source: string }

/** Group a merchant/category's bank-sourced expense occurrences by month. */
function bankExpenseOccurrences(rows: Occurrence[]): {
  account: Account | null
  dayOfMonth: number
  monthlyAmounts: Map<string, number>
  occMonths: string[]
} {
  const bankRows = rows.filter((r) => r.source === 'tangerine' || r.source === 'scotia')
  const account = mode(bankRows.map((r) => r.source as Account))
  const monthlyAmounts = new Map<string, number>()
  for (const r of bankRows) monthlyAmounts.set(monthKey(r.date), (monthlyAmounts.get(monthKey(r.date)) ?? 0) + r.amount)
  return {
    account,
    dayOfMonth: Math.round(median(bankRows.map((r) => dayOf(r.date)))) || 1,
    monthlyAmounts,
    occMonths: [...monthlyAmounts.keys()].sort(),
  }
}

/** Average of the up-to-4 most recent monthly totals (recent bills, not ancient). */
function recentMonthlyAverage(monthlyAmounts: Map<string, number>): number {
  const recent = [...monthlyAmounts.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 4).map(([, v]) => v)
  return mean(recent)
}

/**
 * Infer the full per-account schedule from history. Income from salary/other
 * income deposits (split by the bank they land in); bills from bank-paid
 * recurring merchants (the curated Home category + projection rules, plus any
 * recurring bank-sourced merchant); CC payment from the current outstanding
 * balance routed to whichever bank pays each card. Card-paid bills are NOT added
 * here — they're already inside the CC balance.
 */
export function inferSchedule(
  all: EnrichedTxn[],
  cats: { name: string; kind: string }[],
  rules: ProjectionRule[],
  outstandingByCard: Record<CardSource, number>,
  cardAccounts: CardAccounts,
  fixedCats: string[],
  today: string,
  ccPaymentDay: number = DEFAULT_CC_PAYMENT_DAY,
  ccPendingBuffer: number = DEFAULT_CC_PENDING_BUFFER,
): ScheduledEvent[] {
  const kindByName = new Map(cats.map((c) => [c.name, c.kind]))
  const fixedSet = new Set(fixedCats)
  const ruleIds = new Set(rules.map((r) => r.merchantId))
  // Only look at roughly the last ~8 months so stale patterns fade out.
  const months = [...new Set(all.map((t) => monthKey(t.txnDate)))].sort()
  const recentCutoff = months.length > 8 ? months[months.length - 8] : (months[0] ?? '0000-00')
  const recent = all.filter((t) => monthKey(t.txnDate) >= recentCutoff)

  const events: ScheduledEvent[] = []

  // --- Income (split by the bank account it lands in) ---
  type IncomeAgg = { amounts: Map<string, number>; days: number[] }
  const incomeBy = new Map<string, IncomeAgg>() // key = `${account}|${label}`
  for (const t of recent) {
    if (t.flow !== 'income' || t.amount >= 0) continue
    if (kindByName.get(t.categoryName) !== 'income') continue // skip reimbursements
    if (t.categoryName === 'Goal Spend') continue
    if (t.source !== 'tangerine' && t.source !== 'scotia') continue
    const label = t.categoryName === 'Salary' ? 'Salary' : t.categoryName
    const key = `${t.source}|${label}`
    let agg = incomeBy.get(key)
    if (!agg) incomeBy.set(key, (agg = { amounts: new Map(), days: [] }))
    agg.amounts.set(monthKey(t.txnDate), (agg.amounts.get(monthKey(t.txnDate)) ?? 0) + -t.amount)
    agg.days.push(dayOf(t.txnDate))
  }
  for (const [key, agg] of incomeBy) {
    if (agg.amounts.size < 2) continue // need a repeating signal
    // Drop an income stream that stopped (e.g. an old salary after a job change).
    const lastIncomeMonth = [...agg.amounts.keys()].sort().pop()!
    if (monthDiffYm(lastIncomeMonth, monthKey(today)) > 2) continue
    const [account, label] = key.split('|') as [Account, string]
    const dayOfMonth = Math.round(median(agg.days)) || 1
    events.push({
      key: `income:${key}`,
      account,
      kind: 'income',
      label,
      dayOfMonth,
      amount: round2(recentMonthlyAverage(agg.amounts)),
      cadenceMonths: 1,
      nextDue: nextDueDate(today, dayOfMonth, 1, null),
    })
  }

  // --- Bills (bank-paid recurring merchants) ---
  const byMerchant = new Map<number, { name: string; cat: string; recurring: boolean; rows: Occurrence[] }>()
  for (const t of recent) {
    if (t.flow !== 'expense' || t.amount <= 0) continue
    let m = byMerchant.get(t.merchantId)
    if (!m) byMerchant.set(t.merchantId, (m = { name: t.merchantName, cat: t.categoryName, recurring: false, rows: [] }))
    m.recurring = m.recurring || t.isRecurring
    m.rows.push({ date: t.txnDate, amount: t.amount, source: t.source })
  }
  for (const [merchantId, m] of byMerchant) {
    const isBill = fixedSet.has(m.cat) || ruleIds.has(merchantId) || m.recurring
    if (!isBill) continue
    const { account, dayOfMonth, monthlyAmounts, occMonths } = bankExpenseOccurrences(m.rows)
    if (!account || occMonths.length === 0) continue // card-paid or no bank history → skip
    const cadenceMonths = inferCadenceMonths(occMonths)
    const lastMonth = occMonths[occMonths.length - 1]
    // Skip a bill that's gone silent for more than a full cycle (plus a month of
    // slack) — it's almost certainly cancelled (e.g. a gym you stopped going to),
    // so projecting it would wrongly keep cash pinned in the account. We err on
    // dropping only clearly-stale bills, since dropping a still-active bill is the
    // riskier mistake (it would inflate "safe to move").
    if (monthDiffYm(lastMonth, monthKey(today)) > cadenceMonths + 1) continue
    // Prefer the projection rule's amount logic when a rule exists for this merchant.
    const rule = rules.find((r) => r.merchantId === merchantId)
    const dueMonth = monthKey(nextDueDate(today, dayOfMonth, cadenceMonths, lastMonth))
    const amount = rule
      ? projectedAmountForMonth(rule, all, dueMonth).amount || recentMonthlyAverage(monthlyAmounts)
      : recentMonthlyAverage(monthlyAmounts)
    if (amount <= 0) continue
    events.push({
      key: `bill:${merchantId}`,
      account,
      kind: 'bill',
      label: m.name,
      dayOfMonth,
      amount: round2(amount),
      cadenceMonths,
      nextDue: nextDueDate(today, dayOfMonth, cadenceMonths, lastMonth),
    })
  }

  // --- Credit-card payment of the current outstanding balance ---
  // The owner pays every card on the same day (`ccPaymentDay`, ~the 11th) from the
  // mapped account — the most important date to be covered for.
  const ccAccounts = new Set<Account>()
  for (const card of ['master', 'amex'] as CardSource[]) {
    const amount = outstandingByCard[card] ?? 0
    if (amount <= 0.005) continue
    const account = cardAccounts[card]
    ccAccounts.add(account)
    events.push({
      key: `cc:${card}`,
      account,
      kind: 'cc',
      label: `${card === 'master' ? 'Mastercard' : 'Amex'} payment`,
      dayOfMonth: ccPaymentDay,
      amount: round2(amount),
      cadenceMonths: 1,
      nextDue: nextDueDate(today, ccPaymentDay, 1, null),
    })
  }

  // Pending-charge cushion: charges still pending on the card haven't exported to
  // CSV yet, so the outstanding figure understates what we'll actually pay. Add a
  // combined safety margin on the payment day, split across the paying accounts.
  if (ccPendingBuffer > 0.005 && ccAccounts.size > 0) {
    const per = round2(ccPendingBuffer / ccAccounts.size)
    for (const account of ccAccounts) {
      events.push({
        key: `cc:pending:${account}`,
        account,
        kind: 'cc',
        label: 'Pending card charges (not imported)',
        dayOfMonth: ccPaymentDay,
        amount: per,
        cadenceMonths: 1,
        nextDue: nextDueDate(today, ccPaymentDay, 1, null),
      })
    }
  }

  return events.sort((a, b) => (a.nextDue < b.nextDue ? -1 : 1))
}

/** Apply the owner's saved overrides (and drop disabled events). cc account also
 *  comes from the card→account mapping, applied by the caller before this. */
export function applyOverrides(events: ScheduledEvent[], overrides: EventOverride[], today: string): ScheduledEvent[] {
  const byKey = new Map(overrides.map((o) => [o.key, o]))
  const out: ScheduledEvent[] = []
  for (const e of events) {
    const o = byKey.get(e.key)
    if (!o) {
      out.push(e)
      continue
    }
    if (o.enabled === false) continue
    const account = o.account ?? e.account
    const dayOfMonth = o.dayOfMonth ?? e.dayOfMonth
    const amount = o.amount ?? e.amount
    const lastMonth = e.cadenceMonths > 1 ? monthKey(e.nextDue) : null
    out.push({
      ...e,
      account,
      dayOfMonth,
      amount,
      nextDue: nextDueDate(today, dayOfMonth, e.cadenceMonths, lastMonth),
    })
  }
  return out
}

// ---------- projection ----------

export type ProjectionInput = {
  account: Account
  startBalance: number
  events: ScheduledEvent[]
  today: string
  buffer: number
  /** Owner's manual "unplanned expense before next CC payment" on this account. */
  unplannedExpense: number
}

export type ProjectionResult = {
  /** Lowest running balance over the window (what must stay in the account). */
  trough: number
  troughDate: string
  /** First income date for this account in the window (context), null if none. */
  nextPayday: string | null
  /** What lands on the trough date, for the one-line reason. */
  troughCause: string | null
  /** max(0, trough − buffer): cash safe to move to investment today. */
  safeToMove: number
  /** Daily running balance for the sparkline. */
  timeline: { date: string; balance: number }[]
}

/** Occurrence dates of an event within (today, horizonEnd]; cc fires once. */
function occurrencesInWindow(e: ScheduledEvent, today: string, horizonEnd: string): string[] {
  if (e.kind === 'cc') return e.nextDue >= today && e.nextDue <= horizonEnd ? [e.nextDue] : []
  const out: string[] = []
  let ym = monthKey(e.nextDue)
  let guard = 0
  while (guard++ < 24) {
    const d = dateInMonth(ym, e.dayOfMonth)
    if (d > horizonEnd) break
    if (d >= today) out.push(d)
    ym = addMonthsYm(ym, e.cadenceMonths)
  }
  return out
}

/**
 * Walk the account's balance forward over a ~45-day window and return the trough.
 * Pure, so the client recomputes it live as the unplanned-expense/buffer change.
 */
export function projectAccount(input: ProjectionInput): ProjectionResult {
  const { account, startBalance, events, today, buffer, unplannedExpense } = input
  const horizonEnd = isoAddDays(today, HORIZON_DAYS)
  const accEvents = events.filter((e) => e.account === account)

  type Delta = { date: string; amount: number; label: string }
  const deltas: Delta[] = []
  for (const e of accEvents) {
    for (const d of occurrencesInWindow(e, today, horizonEnd)) {
      deltas.push({ date: d, amount: e.kind === 'income' ? e.amount : -e.amount, label: e.label })
    }
  }
  if (unplannedExpense > 0.005) {
    deltas.push({ date: isoAddDays(today, 1), amount: -round2(unplannedExpense), label: 'Unplanned expense' })
  }
  deltas.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  let bal = round2(startBalance)
  let trough = bal
  let troughDate = today
  let troughCause: string | null = null
  const timeline: { date: string; balance: number }[] = [{ date: today, balance: bal }]
  for (const d of deltas) {
    bal = round2(bal + d.amount)
    timeline.push({ date: d.date, balance: bal })
    if (bal < trough) {
      trough = bal
      troughDate = d.date
      troughCause = d.amount < 0 ? d.label : troughCause
    }
  }

  const nextPayday =
    accEvents
      .filter((e) => e.kind === 'income')
      .flatMap((e) => occurrencesInWindow(e, today, horizonEnd))
      .sort()[0] ?? null

  return { trough, troughDate, nextPayday, troughCause, safeToMove: Math.max(0, round2(trough - buffer)), timeline }
}
