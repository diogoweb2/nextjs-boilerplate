/**
 * Synthetic dataset for the read-only DEMO session (started via the login page's
 * "Explore the demo" button). Everything here is fabricated — safe to commit to a
 * public repo — and is generated deterministically so the demo looks identical on
 * every load. Loaders branch to these builders when isDemoSession() is true
 * (see app/lib/demo.ts); writes are blocked by requireAuth, so it is read-only.
 *
 * Numbers are modelled to look like a real Toronto family budget across ~2 years
 * so every feature (analytics, trends, income, budget, goals, projections, custom
 * reports, activity) has believable data to render.
 */
import type { EnrichedTxn, ImportSource, Flow } from '@/app/lib/analytics'
import type { ProjectionRule } from '@/app/lib/projection'
import type { GoalView, PendingReview } from '@/app/actions/goals'
import type { SurplusPrompt } from '@/app/actions/surplus'
import type { InvestmentsData, AccountView } from '@/app/actions/investments'
import type { NetWorthData } from '@/app/actions/networth'
import { computeTfsaRoom, type RegisteredEntry } from '@/app/lib/tfsa'
import { computeRespGrant } from '@/app/lib/resp'
import type { EmergencyFundData } from '@/app/actions/emergency'
import type { CashflowPlan } from '@/app/actions/cashflow'
import type { ScheduledEvent } from '@/app/lib/cashflow'
import type { MortgageProjection } from '@/app/lib/mortgage'
import type { ReportSeries } from '@/db/schema'
import { CATEGORY_SEED } from '@/app/lib/seed-data'

// ---------------------------------------------------------------------------
// Deterministic PRNG (so the demo is stable across reloads)
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20260621)
const rand = (min: number, max: number) => min + (max - min) * rnd()
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1))
const money = (min: number, max: number) => Math.round(rand(min, max) * 100) / 100
const chance = (p: number) => rnd() < p
const pick = <T,>(arr: T[]): T => arr[randInt(0, arr.length - 1)]

// ---------------------------------------------------------------------------
// Anchor / month helpers — anchor is the in-progress current month so "Current"
// period features have a partial month to show.
// ---------------------------------------------------------------------------
const ANCHOR_YM = '2026-06'
const ANCHOR_DAY = 20 // data fills June up to the 20th
const HISTORY_MONTHS = 23 // plus the anchor = 24 months total

function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}
function monthList(): string[] {
  const out: string[] = []
  for (let i = HISTORY_MONTHS; i >= 0; i--) out.push(addMonths(ANCHOR_YM, -i))
  return out
}
function day(ym: string, d: number): string {
  return `${ym}-${String(d).padStart(2, '0')}`
}
function maxDay(ym: string): number {
  if (ym === ANCHOR_YM) return ANCHOR_DAY
  return new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate()
}
function someDay(ym: string): string {
  return day(ym, randInt(1, maxDay(ym)))
}

// ---------------------------------------------------------------------------
// Categories — reuse the real seed so colors/kinds match the app exactly.
// ---------------------------------------------------------------------------
export type DemoCategory = {
  id: number
  name: string
  color: string
  kind: 'expense' | 'income' | 'neutral'
  bucket: 'needs' | 'wants' | 'savings' | 'none'
}
export const DEMO_CATEGORIES: DemoCategory[] = CATEGORY_SEED.map((c, i) => ({
  id: i + 1,
  name: c.name,
  color: c.color,
  kind: c.kind ?? 'expense',
  bucket: c.bucket ?? 'none',
}))
const catId = (name: string): number => DEMO_CATEGORIES.find((c) => c.name === name)!.id

// ---------------------------------------------------------------------------
// Merchants
// ---------------------------------------------------------------------------
type MerchantDef = {
  name: string
  category: string | null
  recurring?: boolean
  /** Owner-declared yearly billing (recurring subscriptions only). */
  annual?: boolean
  special?: boolean
}
const MERCHANT_DEFS: MerchantDef[] = [
  // Groceries
  { name: 'Costco Wholesale', category: 'Groceries' },
  { name: 'Fortinos', category: 'Groceries' },
  { name: 'No Frills', category: 'Groceries' },
  { name: 'Metro', category: 'Groceries' },
  // Dining
  { name: 'Tim Hortons', category: 'Dining' },
  { name: 'McDonalds', category: 'Dining' },
  { name: 'Pizza Pizza', category: 'Dining' },
  { name: 'Cactus Club', category: 'Dining' },
  // Cars
  { name: 'Petro-Canada', category: 'Cars' },
  { name: 'Costco Gas', category: 'Cars' },
  // Transport
  { name: 'Presto', category: 'Transport' },
  { name: 'Uber', category: 'Transport' },
  // Shopping
  { name: 'Amazon', category: 'Shopping' },
  { name: 'Canadian Tire', category: 'Shopping' },
  { name: 'Dollarama', category: 'Shopping' },
  { name: 'IKEA', category: 'Shopping' },
  // Health
  { name: 'Shoppers Drug Mart', category: 'Health' },
  { name: 'Rexall', category: 'Health' },
  // Dental (special by default)
  { name: 'Lawrence Park Dental', category: 'Dental', special: true },
  // Subscriptions (recurring)
  { name: 'Netflix', category: 'Subscriptions', recurring: true },
  { name: 'Spotify', category: 'Subscriptions', recurring: true },
  { name: 'Anthropic', category: 'Subscriptions', recurring: true },
  { name: 'Distributel', category: 'Subscriptions', recurring: true },
  // Home (the always-fixed category)
  { name: 'Mortgage', category: 'Home', recurring: true },
  { name: 'Toronto Hydro', category: 'Home' },
  { name: 'Toronto Water', category: 'Home' },
  // Kids
  { name: 'Kumon', category: 'Kids', recurring: true },
  { name: 'Mastermind Toys', category: 'Kids' },
  // Entertainment
  { name: 'Cineplex', category: 'Entertainment' },
  // Travel (special by default — big one-offs)
  { name: 'British Airways', category: 'Travel', special: true },
  // Investment (an expense per the app's rules)
  { name: 'Investment (iTrade)', category: 'Investment' },
  // Income payees
  { name: 'Payroll Deposit', category: 'Salary' },
  { name: 'UHN Payroll', category: 'Salary' },
  { name: 'Family Support', category: 'Family Support' },
  { name: 'Canada Child Benefit', category: 'Benefits' },
  { name: 'Sun Life', category: 'Insurance' },
  { name: 'Interest Paid', category: 'Interest' },
  // Card payment (no category; rows are isPayment and excluded from analytics)
  { name: 'Card Payment', category: null },
]

export type DemoMerchant = {
  id: number
  name: string
  categoryId: number | null
  defaultRecurring: boolean
  recurringAnnual: boolean
  defaultSpecial: boolean
  projectionDismissed: boolean
}
export const DEMO_MERCHANTS: DemoMerchant[] = MERCHANT_DEFS.map((m, i) => ({
  id: i + 1,
  name: m.name,
  categoryId: m.category ? catId(m.category) : null,
  defaultRecurring: m.recurring ?? false,
  recurringAnnual: m.annual ?? false,
  defaultSpecial: m.special ?? false,
  projectionDismissed: false,
}))
const merchant = (name: string): DemoMerchant => DEMO_MERCHANTS.find((m) => m.name === name)!

// ---------------------------------------------------------------------------
// Raw transactions (the single source of truth; every page shape derives here)
// ---------------------------------------------------------------------------
export type DemoRawTxn = {
  id: number
  source: ImportSource
  flow: Flow
  txnDate: string
  rawDescription: string
  amount: number
  cardLast4: string | null
  isPayment: boolean
  txnCategoryId: number | null
  txnRecurring: boolean | null
  txnSpecial: boolean | null
  splitParentId: number | null
  batchId: number | null
  merchantId: number
}

let _seq = 0
function buildTxns(): DemoRawTxn[] {
  const txns: DemoRawTxn[] = []
  const add = (
    m: DemoMerchant,
    opts: {
      date: string
      amount: number
      flow?: Flow
      source: ImportSource
      desc?: string
      isPayment?: boolean
      cardLast4?: string | null
    }
  ) => {
    txns.push({
      id: ++_seq,
      source: opts.source,
      flow: opts.flow ?? 'expense',
      txnDate: opts.date,
      rawDescription: opts.desc ?? m.name.toUpperCase(),
      amount: opts.amount,
      cardLast4: opts.cardLast4 ?? null,
      isPayment: opts.isPayment ?? false,
      txnCategoryId: null,
      txnRecurring: null,
      txnSpecial: null,
      splitParentId: null,
      batchId: null,
      merchantId: m.id,
    })
  }

  const CARD: ImportSource[] = ['master', 'amex']
  const cardLast4 = (s: ImportSource) => (s === 'master' ? '4021' : '1007')
  const onCard = () => {
    const s = pick(CARD)
    return { source: s, cardLast4: cardLast4(s) }
  }

  const months = monthList()
  months.forEach((ym, idx) => {
    const isAnchor = ym === ANCHOR_YM
    const cap = maxDay(ym)
    const upto = (frac: number) => Math.max(1, Math.round(cap * frac))

    // --- Groceries: weekly-ish big shops + top-ups (family of 4)
    const groceryStores = ['Costco Wholesale', 'Fortinos', 'No Frills', 'Metro']
    for (let i = 0; i < randInt(7, 11); i++) {
      const c = onCard()
      add(merchant(pick(groceryStores)), { date: someDay(ym), amount: money(38, 260), ...c })
    }
    // --- Dining
    for (let i = 0; i < randInt(5, 9); i++) {
      const c = onCard()
      add(merchant(pick(['Tim Hortons', 'McDonalds', 'Pizza Pizza', 'Cactus Club'])), {
        date: someDay(ym),
        amount: money(12, 90),
        ...c,
      })
    }
    // --- Fuel
    for (let i = 0; i < randInt(3, 5); i++) {
      const c = onCard()
      add(merchant(pick(['Petro-Canada', 'Costco Gas'])), { date: someDay(ym), amount: money(50, 105), ...c })
    }
    // --- Transit
    for (let i = 0; i < randInt(1, 4); i++) {
      const c = onCard()
      add(merchant(chance(0.6) ? 'Presto' : 'Uber'), { date: someDay(ym), amount: money(8, 34), ...c })
    }
    // --- Shopping
    for (let i = 0; i < randInt(2, 5); i++) {
      const c = onCard()
      add(merchant(pick(['Amazon', 'Canadian Tire', 'Dollarama'])), {
        date: someDay(ym),
        amount: money(12, 180),
        ...c,
      })
    }
    if (chance(0.25)) {
      const c = onCard()
      add(merchant('IKEA'), { date: someDay(ym), amount: money(120, 520), ...c })
    }
    // --- Health
    for (let i = 0; i < randInt(1, 3); i++) {
      const c = onCard()
      add(merchant(chance(0.5) ? 'Shoppers Drug Mart' : 'Rexall'), {
        date: someDay(ym),
        amount: money(9, 80),
        ...c,
      })
    }
    // --- Kids (two kids: Kumon for both + occasional toys)
    add(merchant('Kumon'), { date: day(ym, Math.min(5, cap)), amount: 330, ...onCard() })
    if (chance(0.4)) add(merchant('Mastermind Toys'), { date: someDay(ym), amount: money(25, 110), ...onCard() })
    // --- Entertainment
    if (chance(0.4)) add(merchant('Cineplex'), { date: someDay(ym), amount: money(28, 96), ...onCard() })

    // --- Subscriptions (fixed monthly)
    const subs: [string, number, number][] = [
      ['Netflix', 20.99, 3],
      ['Spotify', 11.29, 8],
      ['Anthropic', 28.24, 14],
      ['Distributel', 64.97, 18],
    ]
    for (const [name, amt, d] of subs) {
      if (isAnchor && d > cap) continue
      add(merchant(name), { date: day(ym, Math.min(d, cap)), amount: amt, ...onCard() })
    }

    // --- Home (mortgage + utilities) — billed from the bank (Scotia)
    add(merchant('Mortgage'), {
      date: day(ym, Math.min(1, cap)),
      amount: 2150,
      source: 'scotia',
      desc: 'MORTGAGE PAYMENT',
    })
    // Voluntary extra prepayment some months
    if (chance(0.3))
      add(merchant('Mortgage'), {
        date: day(ym, Math.min(2, cap)),
        amount: 1100,
        source: 'scotia',
        desc: 'CUSTOMER TRANSFER DR.',
      })
    // Hydro every month (seasonal: winter heavier), Water quarterly
    const month = Number(ym.slice(5, 7))
    const winter = month <= 3 || month >= 11
    add(merchant('Toronto Hydro'), {
      date: day(ym, Math.min(12, cap)),
      amount: money(winter ? 150 : 80, winter ? 260 : 140),
      source: 'tangerine',
    })
    if (month % 3 === 0)
      add(merchant('Toronto Water'), { date: day(ym, Math.min(15, cap)), amount: money(110, 180), source: 'tangerine' })

    // --- Investment (an expense per the app's rules) — recurring Scotia transfer
    if (!isAnchor || cap >= 10)
      add(merchant('Investment (iTrade)'), {
        date: day(ym, Math.min(10, cap)),
        amount: 900,
        source: 'scotia',
        desc: 'CUSTOMER TRANSFER DR.',
      })

    // --- Income (flow: 'income'; stored negative per the app's sign convention)
    // Self salary, biweekly (Tangerine)
    add(merchant('Payroll Deposit'), { date: day(ym, Math.min(upto(0.15), cap)), amount: -2300, flow: 'income', source: 'tangerine', desc: 'PAYROLL DEP BGRS' })
    if (upto(0.55) <= cap)
      add(merchant('Payroll Deposit'), { date: day(ym, upto(0.55)), amount: -2300, flow: 'income', source: 'tangerine', desc: 'PAYROLL DEP BGRS' })
    // Partner salary, monthly (Scotia / UHN)
    add(merchant('UHN Payroll'), { date: day(ym, Math.min(upto(0.85), cap)), amount: -3650, flow: 'income', source: 'scotia', desc: 'UHN PAYROLL' })
    // Child benefit, monthly (Scotia) — two kids
    add(merchant('Canada Child Benefit'), { date: day(ym, Math.min(20, cap)), amount: -713, flow: 'income', source: 'scotia', desc: 'CANADA CCB' })
    // Bank interest, monthly (Tangerine)
    add(merchant('Interest Paid'), { date: day(ym, Math.min(28, cap)), amount: -money(4, 16), flow: 'income', source: 'tangerine', desc: 'INTEREST PAID' })
    // Family support, occasional (Tangerine)
    if (chance(0.3))
      add(merchant('Family Support'), { date: someDay(ym), amount: -money(500, 900), flow: 'income', source: 'tangerine', desc: 'TRANSFERWISE' })
    // Insurance payout, once a year (Scotia)
    if (month === 9)
      add(merchant('Sun Life'), { date: day(ym, 18), amount: -1840, flow: 'income', source: 'scotia', desc: 'SUN LIFE CLAIM' })

    // --- Card payment (excluded from analytics; visible on Activity)
    add(merchant('Card Payment'), {
      date: day(ym, Math.min(22, cap)),
      amount: -money(1200, 2400),
      source: 'master',
      desc: 'PAYMENT THANK YOU',
      isPayment: true,
      cardLast4: '4021',
    })

    // --- One-off big specials
    if (idx === 13) add(merchant('British Airways'), { date: day(ym, 9), amount: 2480, source: 'amex', desc: 'BRITISH AIRWAYS', cardLast4: '1007' })
    if (idx === 18 || idx === 6) add(merchant('Lawrence Park Dental'), { date: someDay(ym), amount: money(180, 320), ...onCard() })
  })

  return txns
}

// Generated once at module load — deterministic.
export const DEMO_RAW_TXNS: DemoRawTxn[] = buildTxns()

// ---------------------------------------------------------------------------
// Derived shapes (mirror what each loader / page expects)
// ---------------------------------------------------------------------------
const NO_CATEGORY = { name: 'Uncategorized', color: '#94a3b8' }
const catById = new Map(DEMO_CATEGORIES.map((c) => [c.id, c]))
const merchById = new Map(DEMO_MERCHANTS.map((m) => [m.id, m]))

/** Mirror of analytics.loadAllFlows(): non-payment rows, joined + effective cat. */
export function demoAllFlows(): EnrichedTxn[] {
  return DEMO_RAW_TXNS.filter((r) => !r.isPayment).map((r) => {
    const m = merchById.get(r.merchantId)!
    const effectiveCatId = r.txnCategoryId ?? m.categoryId ?? null
    const cat = effectiveCatId != null ? catById.get(effectiveCatId) : undefined
    return {
      id: r.id,
      source: r.source,
      flow: r.flow,
      txnDate: r.txnDate,
      rawDescription: r.rawDescription,
      amount: r.amount,
      merchantId: m.id,
      merchantName: m.name,
      categoryId: effectiveCatId,
      categoryName: cat?.name ?? NO_CATEGORY.name,
      categoryColor: cat?.color ?? NO_CATEGORY.color,
      categoryKind: cat?.kind ?? null,
      isRecurring: r.txnRecurring ?? m.defaultRecurring,
      recurringAnnual: m.recurringAnnual,
      isSpecial: r.txnSpecial ?? m.defaultSpecial,
      batchId: r.batchId,
    }
  })
}

/** categories table rows (id, name, color, kind, …). */
export function demoCategoryRows() {
  return DEMO_CATEGORIES.map((c) => ({ ...c }))
}

/** merchants table rows. */
export function demoMerchantRows() {
  return DEMO_MERCHANTS.map((m) => ({ ...m }))
}

/** budget_settings shape. */
export function demoBudgetSettings(): { targetNet: number; periodMode: 'year' | '12mo'; budgetedMonth: string | null } {
  return { targetNet: 0, periodMode: 'year', budgetedMonth: null }
}

/** budget_goals rows ({ categoryId, goalAmount } — a few overrides; rest use AI). */
export function demoBudgetGoalRows() {
  return [
    { categoryId: catId('Groceries'), goalAmount: '850' },
    { categoryId: catId('Dining'), goalAmount: '300' },
    { categoryId: catId('Shopping'), goalAmount: '250' },
  ]
}

/** Enabled projection rules (lib view). */
export function demoProjectionRules(): ProjectionRule[] {
  return [
    { merchantId: merchant('Distributel').id, merchantName: 'Distributel', label: 'Internet', cadence: 'monthly', amountMode: 'last', fixedAmount: null },
    { merchantId: merchant('Kumon').id, merchantName: 'Kumon', label: 'Kumon', cadence: 'monthly', amountMode: 'average', fixedAmount: null },
    { merchantId: merchant('Toronto Water').id, merchantName: 'Toronto Water', label: 'Water', cadence: 'quarterly', amountMode: 'average', fixedAmount: null },
  ]
}

/** import_batches rows for the dashboard "Recent imports" list. */
export function demoImportBatches() {
  const sources: ImportSource[] = ['master', 'amex', 'scotia', 'tangerine']
  return sources.map((source, i) => ({
    id: i + 1,
    source,
    filename: `${source}-2026-06.csv`,
    periodLabel: 'June 2026',
    insertedCount: randInt(40, 120),
    createdAt: new Date(`2026-06-${String(18 + i).padStart(2, '0')}T08:00:00Z`),
  }))
}

/** Recent successful sync times per SYNC_SOURCES order [amex, master, scotia, tangerine]. */
export function demoSyncTimes(): (string | null)[] {
  const recent = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
  return [recent(5), recent(5), recent(7), recent(7)]
}

// ---- Activity page ----
export function demoActivityRows() {
  return DEMO_RAW_TXNS.map((r) => {
    const m = merchById.get(r.merchantId)!
    return {
      id: r.id,
      txnDate: r.txnDate,
      rawDescription: r.rawDescription,
      note: null as string | null,
      amount: r.amount,
      source: r.source,
      flow: r.flow,
      cardLast4: r.cardLast4,
      isPayment: r.isPayment,
      txnCategoryId: r.txnCategoryId,
      txnRecurring: r.txnRecurring,
      txnSpecial: r.txnSpecial,
      splitParentId: r.splitParentId,
      merchantId: m.id,
      merchantName: m.name,
      merchantCategoryId: m.categoryId,
      merchantRecurring: m.defaultRecurring,
      merchantAnnual: m.recurringAnnual,
      merchantSpecial: m.defaultSpecial,
    }
  }).sort((a, b) => (a.txnDate < b.txnDate ? 1 : -1))
}
export function demoMonthRows() {
  return DEMO_RAW_TXNS.map((r) => ({ txnDate: r.txnDate }))
}

// ---- Merchants page aggregates (exclude payments) ----
export function demoMerchantTotals() {
  const totals = new Map<number, { total: number; count: number }>()
  const months = new Map<number, Set<string>>()
  for (const r of DEMO_RAW_TXNS) {
    if (r.isPayment) continue
    const t = totals.get(r.merchantId) ?? { total: 0, count: 0 }
    t.total += r.amount
    t.count += 1
    totals.set(r.merchantId, t)
    const s = months.get(r.merchantId) ?? new Set<string>()
    s.add(r.txnDate.slice(0, 7))
    months.set(r.merchantId, s)
  }
  return {
    totals: [...totals.entries()].map(([merchantId, v]) => ({ merchantId, total: v.total, count: v.count })),
    monthCounts: [...months.entries()].map(([merchantId, s]) => ({ merchantId, monthCount: s.size })),
  }
}

// ---- Categories page counts ----
export function demoCategoryCounts() {
  const counts = new Map<number, number>()
  for (const r of DEMO_RAW_TXNS) {
    const m = merchById.get(r.merchantId)!
    const eff = r.txnCategoryId ?? m.categoryId
    if (eff != null) counts.set(eff, (counts.get(eff) ?? 0) + 1)
  }
  return {
    txnCounts: [] as { categoryId: number | null; count: number }[],
    merchantCats: [...counts.entries()].map(([categoryId, count]) => ({ categoryId, count })),
  }
}

// ---- Custom reports ----
export function demoCustomReports(): { id: number; name: string; pinned: boolean; sortOrder: number; range: string; series: ReportSeries[] }[] {
  return [
    {
      id: 1,
      name: 'Eating out vs Groceries',
      pinned: true,
      sortOrder: 0,
      range: '6',
      series: [
        { name: 'Dining', color: '#f97316', categoryIds: [catId('Dining')], merchantIds: [] },
        { name: 'Groceries', color: '#16a34a', categoryIds: [catId('Groceries')], merchantIds: [] },
      ],
    },
    {
      id: 2,
      name: 'Discretionary',
      pinned: false,
      sortOrder: 1,
      range: '12',
      series: [
        { name: 'Fun', color: '#a855f7', categoryIds: [catId('Entertainment'), catId('Dining'), catId('Travel')], merchantIds: [] },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Goals (hand-built final views — avoids re-deriving the full goals math)
// ---------------------------------------------------------------------------
function savingsSeries(months: number, end: number): { ym: string; value: number }[] {
  const out: { ym: string; value: number }[] = []
  let v = Math.max(0, end - months * (end / (months + 2)))
  for (let i = months; i >= 0; i--) {
    const ym = addMonths(ANCHOR_YM, -i)
    out.push({ ym, value: Math.round(v) })
    v += (end - v) / Math.max(1, i)
  }
  out[out.length - 1] = { ym: ANCHOR_YM, value: end }
  return out
}

function demoMortgageProjection(): MortgageProjection {
  const startYm = addMonths(ANCHOR_YM, -23)
  const series: { ym: string; actual: number | null; projected: number; pace: number }[] = []
  const start = 318000
  const payoffMonths = 132 // ~11 years out
  let bal = start
  for (let i = 0; i <= 23; i++) {
    const ym = addMonths(startYm, i)
    bal = Math.max(0, bal - 1850 + bal * (0.052 / 12))
    series.push({
      ym,
      actual: Math.round(bal),
      projected: Math.round(bal),
      pace: Math.round(start - (start / payoffMonths) * i),
    })
  }
  return {
    targetYm: '2031-09',
    currentBalance: Math.round(bal),
    monthsToTarget: 63,
    regularPayment: 2150,
    extraPayment: 1100,
    recentPayment: 3250,
    requiredMonthly: 3980,
    recommendedExtra: 1830,
    prepay: 730,
    projectedPayoffYm: '2032-02',
    onTrack: false,
    series,
  }
}

export function demoGoalsData(): {
  goals: GoalView[]
  asOfYm: string
  suggestNetZero: boolean
  monthStats: { thisMonth: number; lastMonth: number }
} {
  const goals: GoalView[] = [
    {
      id: 1,
      name: 'Family Vacation',
      emoji: '🏖️',
      color: '#06b6d4',
      kind: 'savings',
      notify: true,
      archived: false,
      sortOrder: 0,
      targetAmount: 6000,
      targetDate: '2026-12-31',
      annualRate: null,
      autoContribute: 500,
      value: 3850,
      contributed: 3850,
      contributedThisMonth: 500,
      owedToThis: 200,
      owesOut: 0,
      owesTo: [],
      progressPct: 3850 / 6000,
      projectedCompletionYm: '2026-11',
      targetPace: { monthsLeft: 6, neededPerMonth: 358.33, currentPace: 385, onTrack: true },
      milestone: 'Over halfway there — keep it up! 🎯',
      series: savingsSeries(10, 3850),
      mortgage: null,
      netZero: null,
    },
    {
      id: 2,
      name: 'Emergency Fund',
      emoji: '🛟',
      color: '#16a34a',
      kind: 'savings',
      notify: false,
      archived: false,
      sortOrder: 1,
      targetAmount: 20000,
      targetDate: null,
      annualRate: null,
      autoContribute: null,
      value: 12400,
      contributed: 12400,
      contributedThisMonth: 300,
      owedToThis: 0,
      owesOut: 200,
      owesTo: [{ goalId: 1, amount: 200 }],
      progressPct: 12400 / 20000,
      projectedCompletionYm: '2027-08',
      targetPace: null,
      milestone: 'Solid cushion building. 💪',
      series: savingsSeries(18, 12400),
      mortgage: null,
      netZero: null,
    },
    {
      id: 3,
      name: 'Mortgage Freedom',
      emoji: '🏠',
      color: '#10b981',
      kind: 'mortgage',
      notify: true,
      archived: false,
      sortOrder: 1000,
      targetAmount: 0,
      targetDate: '2031-09-05',
      annualRate: 0.052,
      autoContribute: null,
      value: demoMortgageProjection().currentBalance,
      contributed: 0,
      contributedThisMonth: 0,
      owedToThis: 0,
      owesOut: 0,
      owesTo: [],
      progressPct: null,
      projectedCompletionYm: null,
      targetPace: null,
      milestone: 'Behind pace — add $730/mo extra to catch up. 🔴',
      series: [],
      mortgage: demoMortgageProjection(),
      netZero: null,
    },
  ]
  return {
    goals,
    asOfYm: ANCHOR_YM,
    suggestNetZero: false,
    monthStats: { thisMonth: 350, lastMonth: 500 },
  }
}

/** Surplus-allocation prompt for the dashboard "give every dollar a job" box. */
export function demoSurplusPrompts(): SurplusPrompt[] {
  return [
    {
      month: addMonths(ANCHOR_YM, -1),
      net: 1840,
      hasNetZero: false,
      netZeroLabel: null,
      minNetZero: null,
      goals: [
        { id: 1, name: 'Family Vacation', emoji: '🏖️', color: '#06b6d4', autoContribute: 500 },
        { id: 2, name: 'Emergency Fund', emoji: '🛟', color: '#16a34a', autoContribute: null },
      ],
      // 500 auto to Vacation; the rest of last month's split scaled across the rest.
      preselect: { '1': (500 / 1840) * 100, '2': (1340 / 1840) * 100 },
    },
  ]
}

/** Manual savings-goal deposits with no backing transaction (for 50/30/20). */
export function demoManualSavingsContributions(): { occurredAt: string; amount: number }[] {
  return [
    { occurredAt: day(addMonths(ANCHOR_YM, -1), 12), amount: 500 },
    { occurredAt: day(ANCHOR_YM, 8), amount: 350 },
  ]
}

/** Unpaid credit-card balance the runway nets out of available cash. */
export function demoOutstandingByCard(): { master: number; amex: number } {
  return { master: 3200, amex: 1600 }
}

export function demoOutstandingCardBalance(): number {
  const { master, amex } = demoOutstandingByCard()
  return master + amex
}

/** Synthetic "safe to move" plan: two chequing accounts with a believable
 *  income/bill/CC schedule so the dashboard widget renders in the demo. */
export function demoCashflowPlan(): CashflowPlan {
  const today = `${ANCHOR_YM}-${String(ANCHOR_DAY).padStart(2, '0')}` // 2026-06-20
  const fund = demoEmergencyFund()
  const balanceOf = (s: 'tangerine' | 'scotia') => fund.accounts.find((a) => a.source === s)?.balance ?? 0
  const { master, amex } = demoOutstandingByCard()

  const ev = (
    e: Omit<ScheduledEvent, 'nextDue'> & { nextDue: string },
  ): ScheduledEvent => e

  // Both cards are paid from Tangerine on the 11th, plus a $400 pending cushion.
  const tangerine: ScheduledEvent[] = [
    ev({ key: 'income:tangerine|Salary', account: 'tangerine', kind: 'income', label: 'Salary', dayOfMonth: 26, amount: 5200, cadenceMonths: 1, nextDue: `${ANCHOR_YM}-26` }),
    ev({ key: 'bill:901', account: 'tangerine', kind: 'bill', label: 'Koodo', dayOfMonth: 12, amount: 75, cadenceMonths: 1, nextDue: '2026-07-12' }),
    ev({ key: 'bill:902', account: 'tangerine', kind: 'bill', label: 'Distributel', dayOfMonth: 5, amount: 60, cadenceMonths: 1, nextDue: '2026-07-05' }),
    ev({ key: 'cc:master', account: 'tangerine', kind: 'cc', label: 'Mastercard payment', dayOfMonth: 11, amount: master, cadenceMonths: 1, nextDue: '2026-07-11' }),
    ev({ key: 'cc:amex', account: 'tangerine', kind: 'cc', label: 'Amex payment', dayOfMonth: 11, amount: amex, cadenceMonths: 1, nextDue: '2026-07-11' }),
    ev({ key: 'cc:pending:tangerine', account: 'tangerine', kind: 'cc', label: 'Pending card charges (not imported)', dayOfMonth: 11, amount: 400, cadenceMonths: 1, nextDue: '2026-07-11' }),
  ]
  const scotia: ScheduledEvent[] = [
    ev({ key: 'income:scotia|Salary', account: 'scotia', kind: 'income', label: 'Salary', dayOfMonth: 28, amount: 4100, cadenceMonths: 1, nextDue: `${ANCHOR_YM}-28` }),
    ev({ key: 'bill:903', account: 'scotia', kind: 'bill', label: 'Mortgage', dayOfMonth: 15, amount: 2400, cadenceMonths: 1, nextDue: '2026-07-15' }),
    ev({ key: 'bill:904', account: 'scotia', kind: 'bill', label: 'Toronto Hydro', dayOfMonth: 8, amount: 180, cadenceMonths: 1, nextDue: '2026-07-08' }),
    ev({ key: 'bill:905', account: 'scotia', kind: 'bill', label: 'Toronto Water', dayOfMonth: 18, amount: 240, cadenceMonths: 3, nextDue: '2026-07-18' }),
  ]

  return {
    hasData: true,
    today,
    accounts: [
      { account: 'tangerine', label: 'Tangerine', balance: balanceOf('tangerine'), buffer: 500, events: tangerine },
      { account: 'scotia', label: 'Scotia', balance: balanceOf('scotia'), buffer: 500, events: scotia },
    ],
    cardAccounts: { master: 'tangerine', amex: 'tangerine' },
    ccPaymentDay: 11,
    ccPendingBuffer: 400,
    outstandingByCard: { master, amex },
    unplannedExpense: { tangerine: 0, scotia: 0 },
    overrides: [],
  }
}

/** Worst-case runway history — a believable climb through red → amber → green. */
export function demoRunwayHistory(): { date: string; months: number | null }[] {
  const dates = ['2026-03-15', '2026-04-01', '2026-04-20', '2026-05-05', '2026-05-20', '2026-06-05', '2026-06-15', '2026-06-23']
  const months = [3.2, 3.0, 4.4, 5.3, 6.1, 6.9, 8.0, 8.7]
  return dates.map((date, i) => ({ date, months: months[i] }))
}

/** Emergency Fund card (Tangerine + Scotia) with a believable climbing history. */
export function demoEmergencyFund(): EmergencyFundData {
  const months = 12
  const series: { ym: string; total: number }[] = []
  let bal = 9000
  for (let i = months; i >= 0; i--) {
    bal += randInt(-400, 900)
    series.push({ ym: addMonths(ANCHOR_YM, -i), total: Math.round(bal) })
  }
  const since = `${addMonths(ANCHOR_YM, -months)}-01`
  const investment = 8000 // manual low-risk holding, flat across the history
  const chequing = series[series.length - 1].total
  const scotia = Math.round(chequing * 0.55)
  // Fold the (flat) investment into the history total too.
  const seriesWithInv = series.map((p) => ({ ym: p.ym, total: p.total + investment }))
  return {
    hasData: true,
    total: chequing + investment,
    accounts: [
      { source: 'tangerine', label: 'Tangerine', balance: chequing - scotia, since },
      { source: 'scotia', label: 'Scotia', balance: scotia, since },
      { source: 'investment', label: 'TFSA (iTrade)', balance: investment, since },
    ],
    series: seriesWithInv,
    asOfYm: ANCHOR_YM,
    tfsaMode: 'crash_adjusted' as const,
    effectiveTfsaMode: 'crash_adjusted' as const,
    tfsaHaircutPct: 30,
    cashReserveAvailable: true,
    tfsaModeReason: null,
  }
}

export function demoNetWorth(months: string[]): NetWorthData {
  const investments = demoInvestmentsData().totalValueCad
  const chequing = 24000
  const mortgage = 150000
  const netWorth = Math.round((chequing + investments - mortgage) * 100) / 100
  const n = Math.max(1, months.length)
  // A gently rising trend (mortgage paid down, investments grow).
  const series = months.map((ym, i) => {
    const value = Math.round(netWorth * (0.82 + (0.18 * (i + 1)) / n))
    return { ym, value, chequing, investments, mortgage }
  })
  return {
    hasData: true,
    netWorth,
    assets: { chequing, investments },
    liabilities: { mortgage },
    series,
  }
}

export function demoPendingReviews(): PendingReview[] {
  // The most recent $900 Scotia investment transfer, awaiting allocation.
  const inv = DEMO_RAW_TXNS.filter((r) => r.merchantId === merchant('Investment (iTrade)').id)
    .sort((a, b) => (a.txnDate < b.txnDate ? 1 : -1))[0]
  if (!inv) return []
  return [
    {
      id: 1,
      transactionId: inv.id,
      direction: 'out',
      date: inv.txnDate,
      amount: inv.amount,
      merchant: 'Investment (iTrade)',
      suggestedGoalId: 2,
      goals: [
        { id: 1, name: 'Family Vacation', emoji: '🏖️' },
        { id: 2, name: 'Emergency Fund', emoji: '🛟' },
      ],
      registeredAccounts: [
        { id: 1, name: 'My TFSA', kind: 'tfsa', ownerName: 'Me' },
        { id: 2, name: 'Kids RESP', kind: 'resp', ownerName: 'Me' },
      ],
    },
  ]
}

// --- Projects (the /projects page) ----------------------------------------
// A single believable synthetic project so the demo renders the feature.
function demoProjectMembers() {
  const cats = new Map(demoCategoryRows().map((c) => [c.id, c]))
  return demoActivityRows()
    .filter((r) => r.flow === 'expense' && !r.isPayment)
    .slice(0, 9)
    .map((r) => {
      const effCatId = r.txnCategoryId ?? r.merchantCategoryId ?? null
      const cat = effCatId != null ? cats.get(effCatId) : undefined
      return {
        id: r.id,
        txnDate: r.txnDate,
        merchantName: r.merchantName,
        rawDescription: r.rawDescription,
        amount: r.amount,
        categoryName: cat?.name ?? 'Uncategorized',
        categoryColor: cat?.color ?? '#94a3b8',
        source: r.source,
        country: null as string | null,
        person: r.cardLast4 === '8616' ? 'Partner' : 'Me',
      }
    })
}

export function demoProjects() {
  const members = demoProjectMembers()
  const total = members.reduce((s, m) => s + m.amount, 0)
  return [
    {
      id: 9001,
      name: 'Italy 2025',
      emoji: '🇮🇹',
      color: '#0ea5e9',
      coverImageUrl: null as string | null,
      startDate: '2025-09-06',
      endDate: '2025-09-16',
      total,
      count: members.length,
    },
  ]
}

export function demoProjectDetail(id: number) {
  const card = demoProjects().find((p) => p.id === id) ?? demoProjects()[0]
  const members = demoProjectMembers()
  const total = members.reduce((s, m) => s + m.amount, 0)

  const catAgg = new Map<string, { name: string; color: string; total: number; count: number }>()
  for (const m of members) {
    const cur = catAgg.get(m.categoryName) ?? { name: m.categoryName, color: m.categoryColor, total: 0, count: 0 }
    cur.total += m.amount
    cur.count += 1
    catAgg.set(m.categoryName, cur)
  }
  const personAgg = new Map<string, number>()
  for (const m of members) personAgg.set(m.person, (personAgg.get(m.person) ?? 0) + m.amount)

  return {
    id: card.id,
    name: card.name,
    emoji: card.emoji,
    color: card.color,
    coverImageUrl: null as string | null,
    startDate: card.startDate,
    endDate: card.endDate,
    notes: 'Ten days in Italy — flights, lodging, trains and a lot of pasta.',
    autoFill: null as null,
    total,
    members,
    byCategory: [...catAgg.values()].sort((a, b) => b.total - a.total),
    byPerson: [...personAgg.entries()].map(([person, total]) => ({ person, total })).sort((a, b) => b.total - a.total),
  }
}

// --- Investments (the /investments page) ----------------------------------
// A synthetic TFSA + RESP so the feature renders for demo visitors. Holdings and
// contributions are fabricated; the room/grant numbers run through the same pure
// engines (app/lib/tfsa.ts, app/lib/resp.ts) as the real path.
export function demoInvestmentsData(): InvestmentsData {
  const asOf = '2026-06-24'
  const fx = 1.37

  const tfsaContribs: RegisteredEntry[] = [
    { kind: 'contribution', amount: 900, occurredAt: '2026-01-12' },
    { kind: 'contribution', amount: 900, occurredAt: '2026-02-12' },
    { kind: 'contribution', amount: 900, occurredAt: '2026-03-13' },
    { kind: 'contribution', amount: 8600, occurredAt: '2026-06-23' },
  ]
  const respContribs: RegisteredEntry[] = [
    { kind: 'contribution', amount: 1500, occurredAt: '2026-02-01' },
  ]

  const tfsaPositions = [
    { symbol: 'ZMMK', name: 'BMO Money Market ETF', assetClass: 'Cash Equivalent', currency: 'CAD', qty: 1060, mv: 52904.6, pct: 0.07 },
    { symbol: 'XEQT', name: 'iShares Core Equity ETF', assetClass: 'Equity', currency: 'CAD', qty: 507, mv: 22754.16, pct: 73.88 },
    { symbol: 'QQQ', name: 'Invesco QQQ Trust', assetClass: 'Equity', currency: 'USD', qty: 71, mv: 50452.6, pct: 133.06 },
    { symbol: 'KWEB', name: 'KraneShares CSI China Internet', assetClass: 'Equity', currency: 'USD', qty: 299, mv: 7267.2, pct: -65.76 },
  ].map((p) => ({
    symbol: p.symbol, name: p.name, assetClass: p.assetClass, currency: p.currency,
    quantity: p.qty, marketValue: p.mv,
    marketValueCad: Math.round(p.mv * (p.currency === 'USD' ? fx : 1) * 100) / 100,
    changePct: p.pct, changeAmount: 0,
  }))
  const respPositions = [
    { symbol: 'QQC.F', name: 'Invesco NASDAQ 100 Index ETF', assetClass: 'Equity', currency: 'CAD', qty: 55, mv: 12364.55, pct: 246.97 },
    { symbol: 'VEE', name: 'Vanguard FTSE Emerging Markets', assetClass: 'Equity', currency: 'CAD', qty: 68, mv: 3429.24, pct: 49.13 },
  ].map((p) => ({
    symbol: p.symbol, name: p.name, assetClass: p.assetClass, currency: p.currency,
    quantity: p.qty, marketValue: p.mv, marketValueCad: p.mv, changePct: p.pct, changeAmount: 0,
  }))

  const tfsaTotal = Math.round(tfsaPositions.reduce((s, p) => s + p.marketValueCad, 0) * 100) / 100
  const respTotal = Math.round(respPositions.reduce((s, p) => s + p.marketValueCad, 0) * 100) / 100

  const accounts: AccountView[] = [
    {
      id: 1, kind: 'tfsa', name: 'My TFSA', owner: 'self', ownerName: 'Me', currency: 'CAD',
      brokerageAccountNo: '54528607',
      latest: { occurredAt: asOf, fxUsdCad: fx, totalValueCad: tfsaTotal, bookValueCad: Math.round(tfsaTotal * 0.7) },
      positions: tfsaPositions,
      valueSeries: [
        { ym: '2026-03-31', value: tfsaTotal * 0.92 }, { ym: '2026-05-31', value: tfsaTotal * 0.97 }, { ym: asOf, value: tfsaTotal },
      ],
      contributions: tfsaContribs.map((c, i) => ({ id: i + 1, kind: c.kind, amount: c.amount, occurredAt: c.occurredAt, note: 'From transfer', fromTransfer: true })),
      contributionsTotal: 11300,
      tfsa: computeTfsaRoom(23756, '2026-01-01', tfsaContribs, asOf),
      resp: null,
      roomBaselineAmount: 23756, roomBaselineDate: '2026-01-01',
      beneficiaryBirthYear: null, grantBaselineReceived: null, contributionBaseline: null, grantCarryForward: null,
    },
    {
      id: 2, kind: 'resp', name: 'Kids RESP', owner: 'self', ownerName: 'Me', currency: 'CAD',
      brokerageAccountNo: '59201813',
      latest: { occurredAt: asOf, fxUsdCad: 1, totalValueCad: respTotal, bookValueCad: Math.round(respTotal * 0.4) },
      positions: respPositions,
      valueSeries: [{ ym: '2026-03-31', value: respTotal * 0.95 }, { ym: asOf, value: respTotal }],
      contributions: respContribs.map((c, i) => ({ id: 10 + i, kind: c.kind, amount: c.amount, occurredAt: c.occurredAt, note: 'From transfer', fromTransfer: true })),
      contributionsTotal: 1500,
      tfsa: null,
      resp: computeRespGrant(respContribs, { contributionBaseline: 18000, grantBaselineReceived: 3600, grantCarryForward: 0, beneficiaryBirthYear: 2016 }, asOf),
      roomBaselineAmount: null, roomBaselineDate: null,
      beneficiaryBirthYear: 2016, grantBaselineReceived: 3600, contributionBaseline: 18000, grantCarryForward: 0,
    },
  ]

  return {
    accounts,
    totalValueCad: Math.round((tfsaTotal + respTotal) * 100) / 100,
    selfName: 'Me',
    partnerName: 'Partner',
  }
}
