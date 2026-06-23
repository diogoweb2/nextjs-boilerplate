/**
 * Emergency-fund runway — "how many months could we survive on the emergency
 * fund?" Pure & db-free (operates on `loadAllFlows` rows + the category buckets),
 * so it can be unit-tested and its types reused by the client widget.
 *
 * The classic rule of thumb is 3–6 months of expenses. We compute a stable
 * MONTHLY burn (recent complete months, independent of the dashboard period) and
 * the recent monthly salary of each earner, so the widget can answer runway under
 * job-loss scenarios. Salary is split self/partner exactly like the Income page
 * (`Salary` category: Tangerine = self, Scotia = partner). See BUSINESS_RULES §13.
 */
import type { EnrichedTxn } from '@/app/lib/analytics'
import { isExtraMortgagePayment } from '@/app/lib/mortgage'
import type { BucketMeta } from '@/app/lib/fifty-thirty-twenty'

export type RunwayInputs = {
  /** Monthly Needs + Wants spend, EXCLUDING Travel (the cuttable lever). */
  burnBase: number
  /** Monthly Travel spend (toggled in/out of the burn by the widget). */
  travel: number
  /** Monthly salary, self (Tangerine) and partner (Scotia). */
  selfSalary: number
  partnerSalary: number
  /** Monthly non-salary income assumed to continue (family support, benefits, …). */
  otherIncome: number
  /** Number of complete months the averages were taken over (transparency). */
  completeMonths: number
}

/** Emergency-runway target & warning thresholds (months) + status tiers. */
export const RUNWAY_TARGET = 9
export const RUNWAY_WARN = 6

export type RunwayStatus = 'green' | 'amber' | 'red'

/** null months = infinite runway (income covers the burn) → green. */
export function runwayStatus(months: number | null): RunwayStatus {
  if (months === null || months >= RUNWAY_TARGET) return 'green'
  if (months >= RUNWAY_WARN) return 'amber'
  return 'red'
}

function monthKey(d: string): string {
  return d.slice(0, 7)
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Monthly averages for the runway widget, over the most recent `months` COMPLETE
 * months (the in-progress anchor month is excluded so a partial month doesn't
 * drag the averages down). Falls back to the anchor month if no complete months.
 */
export function computeRunwayInputs(
  all: EnrichedTxn[],
  cats: BucketMeta[],
  opts: { months?: number } = {},
): RunwayInputs {
  const windowMonths = opts.months ?? 6
  const bucketByName = new Map(cats.map((c) => [c.name, c.bucket]))
  const kindByName = new Map(cats.map((c) => [c.name, c.kind]))

  const present = [...new Set(all.map((t) => monthKey(t.txnDate)))].sort()
  const empty: RunwayInputs = {
    burnBase: 0, travel: 0, selfSalary: 0, partnerSalary: 0, otherIncome: 0, completeMonths: 0,
  }
  if (present.length === 0) return empty
  const anchor = present[present.length - 1]
  const complete = present.filter((ym) => ym < anchor)
  const window = (complete.length ? complete : [anchor]).slice(-windowMonths)
  const inWindow = new Set(window)
  const denom = window.length || 1

  let burnBase = 0
  let travel = 0
  let selfSalary = 0
  let partnerSalary = 0
  let otherIncome = 0

  for (const t of all) {
    if (!inWindow.has(monthKey(t.txnDate))) continue

    if (t.flow === 'income') {
      if (kindByName.get(t.categoryName) !== 'income') continue // reimbursements aren't income
      const amt = -t.amount
      if (t.categoryName === 'Salary') {
        if (t.source === 'tangerine') selfSalary += amt
        else partnerSalary += amt
      } else if (t.categoryName !== 'Goal Spend') {
        otherIncome += amt
      }
      continue
    }

    if (t.flow !== 'expense' || t.amount <= 0) continue
    // In a real emergency you'd pause saving/investing and extra mortgage prepay.
    if (isExtraMortgagePayment(t)) continue
    const bucket = bucketByName.get(t.categoryName)
    if (bucket !== 'needs' && bucket !== 'wants') continue
    if (t.categoryName === 'Travel') travel += t.amount
    else burnBase += t.amount
  }

  return {
    burnBase: round2(burnBase / denom),
    travel: round2(travel / denom),
    selfSalary: round2(selfSalary / denom),
    partnerSalary: round2(partnerSalary / denom),
    otherIncome: round2(otherIncome / denom),
    completeMonths: window.length,
  }
}

export type RunwayScenario = {
  key: 'self' | 'partner'
  label: string
  /** Income still arriving each month in this scenario. */
  remainingIncome: number
  /** Net cash burned per month = burn − remainingIncome (0 if income covers it). */
  netBurn: number
  /** Months the fund lasts; null = infinite (income covers the burn). */
  months: number | null
}

/** Build the three job-loss scenarios from the inputs + a fund + exclude-trips. */
export function buildScenarios(
  inputs: RunwayInputs,
  fund: number,
  excludeTravel: boolean,
  names: { self: string; partner: string },
): { burn: number; scenarios: RunwayScenario[] } {
  const burn = round2(inputs.burnBase + (excludeTravel ? 0 : inputs.travel))
  const make = (key: RunwayScenario['key'], label: string, remainingIncome: number): RunwayScenario => {
    const netBurn = round2(Math.max(0, burn - remainingIncome))
    return { key, label, remainingIncome: round2(remainingIncome), netBurn, months: netBurn <= 0 ? null : fund / netBurn }
  }
  return {
    burn,
    scenarios: [
      make('self', `No salary — ${names.self}`, inputs.partnerSalary + inputs.otherIncome),
      make('partner', `No salary — ${names.partner}`, inputs.selfSalary + inputs.otherIncome),
    ],
  }
}

export type Headroom = {
  /** The earner whose job loss is the worst case (the higher earner). */
  worstEarner: 'self' | 'partner'
  worstEarnerName: string
  /** Worst-case monthly net burn (higher earner gone). */
  netBurn: number
  /** Cash needed to cover `targetMonths` in the worst case. */
  targetCash: number
  /** available − targetCash. ≥ 0 = surplus you can move; < 0 = shortfall to add. */
  headroom: number
  /** True when income alone covers the burn (any fund hits the target). */
  coversBurn: boolean
}

/**
 * How much cash you could move elsewhere (surplus) and still hit `targetMonths`,
 * or how much to add to reach it — evaluated for the WORST single-earner case
 * (the higher earner losing their job, the shortest runway). `available` is the
 * fund already net of committed card balance. Pure so the widget recomputes it
 * live as the exclude-trips toggle changes `burn`.
 */
export function headroomToTarget(
  inputs: RunwayInputs,
  available: number,
  excludeTravel: boolean,
  targetMonths: number,
  names: { self: string; partner: string },
): Headroom {
  const burn = inputs.burnBase + (excludeTravel ? 0 : inputs.travel)
  const worstEarner: 'self' | 'partner' = inputs.selfSalary >= inputs.partnerSalary ? 'self' : 'partner'
  const remaining = (worstEarner === 'self' ? inputs.partnerSalary : inputs.selfSalary) + inputs.otherIncome
  const netBurn = round2(Math.max(0, burn - remaining))
  const targetCash = round2(targetMonths * netBurn)
  return {
    worstEarner,
    worstEarnerName: worstEarner === 'self' ? names.self : names.partner,
    netBurn,
    targetCash,
    headroom: round2(available - targetCash),
    coversBurn: netBurn <= 0,
  }
}
