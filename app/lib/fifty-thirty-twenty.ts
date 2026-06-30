/**
 * The 50/30/20 rule view (dashboard card). Pure & db-free — operates on the rows
 * from `loadAllFlows` (all flows, no card payments) plus the per-category bucket
 * mapping — so it can be unit-tested and reused. See BUSINESS_RULES.md §8d.
 *
 * The rule splits after-tax income into Needs (50%), Wants (30%) and Savings
 * (20%). Each expense category carries a `bucket` (needs/wants/savings/none); we
 * sum the *net* spend per category within the selected period and compare the
 * resulting split to the targets, surfacing the difference for each bucket.
 *
 * Two owner-confirmed wrinkles (see the BUSINESS_RULES section):
 *  - Income-flow rows whose category is an EXPENSE-kind category (e.g. dental
 *    insurance reimbursements filed under "Dental") are reimbursements: they net
 *    against that category, NOT counted as income. Only income-flow rows in
 *    income-kind categories are true income.
 *  - The voluntary EXTRA mortgage payment is moved out of Needs and counted as
 *    Savings (paying down principal builds equity); the contractual payment
 *    stays in Needs. See `isExtraMortgagePayment`.
 */
import type { EnrichedTxn } from '@/app/lib/analytics'
import { isExtraMortgagePayment } from '@/app/lib/mortgage'

export type Bucket = 'needs' | 'wants' | 'savings' | 'none'

export const RULE_TARGETS: Record<'needs' | 'wants' | 'savings', number> = {
  needs: 0.5,
  wants: 0.3,
  savings: 0.2,
}

/** Colors for the three buckets (echo the classic 50/30/20 infographic). */
export const BUCKET_COLORS: Record<'needs' | 'wants' | 'savings', string> = {
  needs: '#f59e0b', // amber
  wants: '#9f1239', // dark red
  savings: '#0ea5e9', // sky blue
}

export const BUCKET_LABELS: Record<'needs' | 'wants' | 'savings', string> = {
  needs: 'Needs',
  wants: 'Wants',
  savings: 'Savings',
}

export type BucketResult = {
  key: 'needs' | 'wants' | 'savings'
  label: string
  color: string
  amount: number
  /** Share of income (0..1+); 0 when income ≤ 0. */
  actualPct: number
  targetPct: number
  /** actualPct − targetPct (signed fraction of income). */
  diffPct: number
  /** amount − target$ (target$ = targetPct × income). Positive = over target. */
  diffAmount: number
}

export type DentalCoverage = {
  expense: number
  reimbursed: number
  /** reimbursed / expense, or null when there was no dental expense. */
  coverage: number | null
  /** True when coverage ≥ 80% (or there was nothing to cover). */
  ok: boolean
}

export type BudgetRuleData = {
  hasData: boolean
  income: number
  needs: number
  wants: number
  savings: number
  buckets: BucketResult[]
  dental: DentalCoverage | null
}

export type BucketMeta = { name: string; kind: string; bucket: Bucket }
export type ManualContribution = { occurredAt: string; amount: number }

/**
 * Which 50/30/20 bucket a *single* transaction is attributed to — the per-row
 * mirror of the aggregation in `computeBudgetRule`. Returns null when the row is
 * not part of any consumption/savings bucket (true income, transfers, or an
 * expense in a `none`-bucket category). Used to drill into a bucket from the
 * dashboard card (`/transactions?bucket=…`), so the two MUST agree — see
 * BUSINESS_RULES.md §8d. The two wrinkles it must honour:
 *  - The voluntary extra mortgage prepayment is reattributed from Needs (its
 *    `Home` category) to **Savings** (`isExtraMortgagePayment`).
 *  - A reimbursement (income-flow row under an expense-kind category) stays with
 *    that category's bucket as a credit; true income (income-kind) is excluded.
 *
 * Note: the card clamps each category's net to `max(0, net)` and adds manual
 * (txn-less) contributions, so in rare over-reimbursed months or when manual
 * savings exist the filtered rows won't sum to the headline figure exactly.
 */
export function bucketForTxn(
  t: { merchantName: string; flow: string; rawDescription: string },
  cat: { kind: string; bucket: Bucket } | undefined,
): 'needs' | 'wants' | 'savings' | null {
  const ofBucket = (b: Bucket | undefined) =>
    b === 'needs' || b === 'wants' || b === 'savings' ? b : null

  if (t.flow === 'income') {
    // True income (income-kind category) is not in any bucket; a reimbursement
    // filed under an expense category nets against that category's bucket.
    if (!cat || cat.kind === 'income') return null
    return ofBucket(cat.bucket)
  }
  if (t.flow !== 'expense') return null // ignore transfers
  // Voluntary extra mortgage principal counts as Savings, not Needs.
  if (isExtraMortgagePayment(t)) return 'savings'
  return ofBucket(cat?.bucket)
}

function monthKey(d: string): string {
  return d.slice(0, 7)
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Compute the 50/30/20 split for the given month window [start, end] inclusive.
 * `cats` is every category's name/kind/bucket; `manualContributions` are savings
 * deposits with no backing transaction (see loadManualSavingsContributions).
 */
export function computeBudgetRule(
  all: EnrichedTxn[],
  cats: BucketMeta[],
  opts: { start: string; end: string; manualContributions?: ManualContribution[] },
): BudgetRuleData {
  const { start, end, manualContributions = [] } = opts
  const inWindow = (d: string) => {
    const ym = monthKey(d)
    return ym >= start && ym <= end
  }

  const bucketByName = new Map(cats.map((c) => [c.name, c.bucket]))
  const kindByName = new Map(cats.map((c) => [c.name, c.kind]))

  // Net spend per category = expense-flow amounts + income-flow amounts
  // (reimbursements are stored negative, so they subtract).
  const netByCat = new Map<string, number>()
  let income = 0
  let extraMortgage = 0
  // Dental specifics for the coverage flag.
  let dentalExpense = 0
  let dentalReimbursed = 0

  for (const t of all) {
    if (!inWindow(t.txnDate)) continue

    if (t.flow === 'income') {
      const kind = kindByName.get(t.categoryName)
      if (kind === 'income') {
        income += -t.amount // stored negative → inflow
      } else {
        // Reimbursement filed under an expense category → nets against it.
        netByCat.set(t.categoryName, (netByCat.get(t.categoryName) ?? 0) + t.amount)
        if (t.categoryName === 'Dental') dentalReimbursed += -t.amount
      }
      continue
    }

    if (t.flow !== 'expense') continue // ignore transfers

    netByCat.set(t.categoryName, (netByCat.get(t.categoryName) ?? 0) + t.amount)
    if (isExtraMortgagePayment(t)) extraMortgage += t.amount
    if (t.categoryName === 'Dental' && t.amount > 0) dentalExpense += t.amount
  }

  // Roll category nets into buckets. Each category contributes max(0, net) so an
  // over-reimbursed category (net < 0) doesn't subtract from its bucket.
  let needs = 0
  let wants = 0
  let savings = 0
  for (const [name, rawNet] of netByCat) {
    const bucket = bucketByName.get(name)
    if (bucket !== 'needs' && bucket !== 'wants' && bucket !== 'savings') continue
    let net = rawNet
    // Move the voluntary extra mortgage prepayment out of Needs — it's counted
    // as Savings below (paying down principal builds equity).
    if (name === 'Home') net -= extraMortgage
    net = Math.max(0, net)
    if (bucket === 'needs') needs += net
    else if (bucket === 'wants') wants += net
    else savings += net
  }

  // Extra mortgage principal counts as Savings.
  savings += extraMortgage

  // Manual savings deposits (no transaction → not in any flow) count as savings.
  for (const c of manualContributions) {
    if (inWindow(c.occurredAt) && c.amount > 0) savings += c.amount
  }

  income = round2(income)
  needs = round2(needs)
  wants = round2(wants)
  savings = round2(savings)

  const buildBucket = (key: 'needs' | 'wants' | 'savings', amount: number): BucketResult => {
    const targetPct = RULE_TARGETS[key]
    const actualPct = income > 0 ? amount / income : 0
    return {
      key,
      label: BUCKET_LABELS[key],
      color: BUCKET_COLORS[key],
      amount,
      actualPct,
      targetPct,
      diffPct: actualPct - targetPct,
      diffAmount: round2(amount - targetPct * income),
    }
  }

  const dental: DentalCoverage | null =
    dentalExpense > 0 || dentalReimbursed > 0
      ? {
          expense: round2(dentalExpense),
          reimbursed: round2(dentalReimbursed),
          coverage: dentalExpense > 0 ? dentalReimbursed / dentalExpense : null,
          ok: dentalExpense === 0 || dentalReimbursed / dentalExpense >= 0.8,
        }
      : null

  return {
    hasData: income > 0 || needs + wants + savings > 0,
    income,
    needs,
    wants,
    savings,
    buckets: [buildBucket('needs', needs), buildBucket('wants', wants), buildBucket('savings', savings)],
    dental,
  }
}
