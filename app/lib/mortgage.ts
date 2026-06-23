/**
 * Mortgage payoff projection — pure & deterministic so it is easy to test.
 *
 * The owner wants the mortgage gone by their 50th birthday. Interest is variable,
 * so rather than tracking it exactly we PROJECT the balance from the real monthly
 * payments at an estimated `annualRate`, and let the owner periodically override
 * the real balance from a statement. Each override back-solves the implied rate
 * (`inferRate`) so the next projection is sharper. See BUSINESS_RULES.md §10.
 *
 * Sign: balances and payments are positive magnitudes. A month applies interest
 * then subtracts the payment: b = b·(1 + r/12) − payment.
 */

export type Snapshot = { ym: string; balance: number }
/**
 * A month's mortgage outflow, split by kind: `regular` is the contractual
 * mortgage payment ("mortgage payment"); `extra` is voluntary prepayment toward
 * principal (the "customer transfer" top-ups). Both reduce the balance, but the
 * projection only asks the owner to change the `extra`.
 */
export type Payment = { ym: string; regular: number; extra: number }

/** "2026-06" → next month "2026-07". */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}`
}

/**
 * True when a row is a voluntary EXTRA mortgage prepayment (the "customer
 * transfer" top-ups) rather than the contractual "mortgage payment". Shared by
 * the goals projection (`mortgagePayments`) and the 50/30/20 rule, which excludes
 * extra principal from Needs (the extra payment isn't a living cost). Operates on
 * any txn-like row so it stays pure/db-free.
 */
export function isExtraMortgagePayment(t: {
  merchantName: string
  flow: string
  rawDescription: string
}): boolean {
  return (
    t.merchantName === 'Mortgage' &&
    t.flow === 'expense' &&
    !t.rawDescription.toLowerCase().includes('mortgage payment')
  )
}

/** Whole months from `a` to `b` (b − a). Negative if b precedes a. */
export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number)
  const [by, bm] = b.split('-').map(Number)
  return by * 12 + (bm - 1) - (ay * 12 + (am - 1))
}

/** The calendar month in which the owner turns `age` (the payoff deadline). */
export function payoffMonth(birthDate: string, age: number): string {
  const [y, m] = birthDate.split('-').map(Number)
  return `${y + age}-${String(m).padStart(2, '0')}`
}

/** Simulate forward from `start`, applying interest then each payment in order. */
function simulate(start: number, monthlyRate: number, payments: number[]): number {
  let b = start
  for (const p of payments) {
    b = b * (1 + monthlyRate) - p
    if (b < 0) b = 0
  }
  return b
}

/**
 * Back-solve the annual rate that turns `prevBalance` into `newBalance` after the
 * given monthly payments. Monotonic in r (more interest ⇒ higher ending balance),
 * so bisection converges. Returns null when payments alone explain it (no signal).
 */
export function inferRate(
  prevBalance: number,
  newBalance: number,
  paymentsBetween: number[],
): number | null {
  if (paymentsBetween.length === 0) return null
  let lo = 0
  let hi = 0.3 // 30% annual — generous upper bound
  // 0% interest is the floor (balance falls only by the payments). If the new
  // balance is below that floor, it fell faster than the payments — an extra
  // lump or error — so no non-negative rate explains it. Keep the old estimate.
  if (simulate(prevBalance, 0, paymentsBetween) > newBalance) return null
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    const end = simulate(prevBalance, mid / 12, paymentsBetween)
    if (end > newBalance) hi = mid
    else lo = mid
  }
  return Math.round(((lo + hi) / 2) * 10000) / 10000
}

/** Amortization payment to clear `balance` in `months` at `annualRate`. */
export function requiredMonthly(balance: number, annualRate: number, months: number): number {
  if (months <= 0) return balance
  const r = annualRate / 12
  if (r < 1e-9) return balance / months
  const factor = Math.pow(1 + r, -months)
  return (balance * r) / (1 - factor)
}

export type MortgageProjection = {
  targetYm: string
  currentBalance: number
  monthsToTarget: number
  /** Recent contractual mortgage payment ("mortgage payment"), avg of last 3. */
  regularPayment: number
  /** Recent voluntary prepayment ("customer transfer"), avg of last 3. */
  extraPayment: number
  /** Total recent outflow = regularPayment + extraPayment. */
  recentPayment: number
  /** Total monthly outflow needed to hit $0 by the deadline. */
  requiredMonthly: number
  /** What the EXTRA payment should be (on top of the regular payment) to finish
   *  on time — the headline "pay this much extra" number. */
  recommendedExtra: number
  /** Additional extra still needed beyond what's already paid extra (the bump). */
  prepay: number
  projectedPayoffYm: string | null
  onTrack: boolean
  series: { ym: string; actual: number | null; projected: number; pace: number }[]
}

export type MortgageInput = {
  birthDate: string
  payoffAge: number
  annualRate: number
  snapshots: Snapshot[] // ascending by ym, ≥ 1
  payments: Payment[]
  asOfYm: string
}

/**
 * Build the full projection + chart series for a mortgage goal. `actual` traces
 * known balances (snapshots, projected between them) up to today; `projected`
 * traces the balance going forward at the recent payment; `pace` is the straight
 * line from today's balance to $0 at the deadline.
 */
export function projectMortgage(input: MortgageInput): MortgageProjection {
  const { birthDate, payoffAge, annualRate, snapshots, payments, asOfYm } = input
  const r = annualRate / 12
  const payByYm = new Map(payments.map((p) => [p.ym, p.regular + p.extra]))
  const targetYm = payoffMonth(birthDate, payoffAge)

  const sorted = [...snapshots].sort((a, b) => (a.ym < b.ym ? -1 : 1))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]

  // Current balance: latest snapshot projected forward to asOf using payments.
  let currentBalance = last.balance
  for (let ym = addMonths(last.ym, 1); monthsBetween(ym, asOfYm) >= 0; ym = addMonths(ym, 1)) {
    currentBalance = Math.max(0, currentBalance * (1 + r) - (payByYm.get(ym) ?? 0))
  }

  // Average the monthly outflow over COMPLETE months only (exclude the
  // in-progress anchor month) across a 6-month window — so a partial current
  // month and weekly/biweekly cadence (4 vs 5 payments land in a month) don't
  // distort the per-month figure. Fall back to all rows if nothing is complete.
  const complete = payments.filter((p) => p.ym < asOfYm)
  const window = (complete.length ? complete : payments).slice(-6)
  const denom = window.length || 1
  const avg = (sel: (p: Payment) => number) => window.reduce((s, p) => s + sel(p), 0) / denom
  const regularPayment = avg((p) => p.regular)
  const extraPayment = avg((p) => p.extra)
  const recentPayment = regularPayment + extraPayment
  const monthsToTarget = Math.max(0, monthsBetween(asOfYm, targetYm))
  const need = requiredMonthly(currentBalance, annualRate, monthsToTarget)
  // The extra payment that, on top of the regular payment, clears it on time;
  // and the additional bump beyond what's already paid extra.
  const recommendedExtra = Math.max(0, need - regularPayment)
  const prepay = Math.max(0, recommendedExtra - extraPayment)

  // Forward simulation at the recent payment → projected payoff month.
  let projectedPayoffYm: string | null = null
  {
    let b = currentBalance
    let ym = asOfYm
    for (let i = 0; i < 720 && b > 0; i++) {
      b = b * (1 + r) - recentPayment
      ym = addMonths(ym, 1)
      if (b <= 0) {
        projectedPayoffYm = ym
        break
      }
    }
  }
  const onTrack = projectedPayoffYm !== null && monthsBetween(projectedPayoffYm, targetYm) >= 0

  // ----- chart series: from the first snapshot through the deadline -----
  const series: MortgageProjection['series'] = []
  const endYm = targetYm
  // actual path: walk known snapshots, projecting between them.
  const actualByYm = new Map<string, number>()
  {
    let b = first.balance
    actualByYm.set(first.ym, b)
    for (let ym = addMonths(first.ym, 1); monthsBetween(ym, asOfYm) >= 0; ym = addMonths(ym, 1)) {
      const snap = sorted.find((s) => s.ym === ym)
      b = snap ? snap.balance : Math.max(0, b * (1 + r) - (payByYm.get(ym) ?? 0))
      actualByYm.set(ym, b)
    }
  }
  // projected path forward from asOf at recent payment.
  const projByYm = new Map<string, number>()
  {
    let b = currentBalance
    projByYm.set(asOfYm, b)
    for (let ym = addMonths(asOfYm, 1); monthsBetween(ym, endYm) >= 0; ym = addMonths(ym, 1)) {
      b = Math.max(0, b * (1 + r) - recentPayment)
      projByYm.set(ym, b)
    }
  }
  const totalPaceMonths = Math.max(1, monthsToTarget)
  for (let ym = first.ym; monthsBetween(ym, endYm) >= 0; ym = addMonths(ym, 1)) {
    const sinceAsOf = monthsBetween(asOfYm, ym)
    const pace =
      sinceAsOf < 0 ? currentBalance : Math.max(0, currentBalance * (1 - sinceAsOf / totalPaceMonths))
    series.push({
      ym,
      actual: actualByYm.has(ym) ? actualByYm.get(ym)! : null,
      projected: projByYm.get(ym) ?? (sinceAsOf < 0 ? (actualByYm.get(ym) ?? currentBalance) : currentBalance),
      pace,
    })
  }

  return {
    targetYm,
    currentBalance,
    monthsToTarget,
    regularPayment,
    extraPayment,
    recentPayment,
    requiredMonthly: need,
    recommendedExtra,
    prepay,
    projectedPayoffYm,
    onTrack,
    series,
  }
}
