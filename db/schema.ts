import {
  pgTable,
  serial,
  text,
  numeric,
  date,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

/**
 * Spending categories (Groceries, Dining, ...). Seeded by db/seed.ts but fully
 * user-editable. A merchant points at a category; a transaction can override.
 */
export const categories = pgTable('categories', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  color: text('color').notNull().default('#6366f1'),
  // 'expense' shows in spend analytics; 'income' powers the Income page;
  // 'neutral' is for transfer-like buckets excluded from both.
  kind: text('kind', { enum: ['expense', 'income', 'neutral'] })
    .notNull()
    .default('expense'),
  // 50/30/20 rule bucket (see app/lib/fifty-thirty-twenty.ts). 'needs'/'wants'/
  // 'savings' map a category into the rule; 'none' excludes it (income/neutral
  // categories, transfers, Goal Spend). User-editable on the Categories page.
  bucket: text('bucket', { enum: ['needs', 'wants', 'savings', 'none'] })
    .notNull()
    .default('none'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * A learned merchant group, e.g. "Costco" or "Amazon". Many raw descriptions
 * ("COSTCO WHOLESALE #1655", "COSTCO GAS W1655") map to one merchant via
 * merchant_rules. Defaults flow down to its transactions unless overridden.
 */
export const merchants = pgTable('merchants', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  categoryId: integer('category_id').references(() => categories.id, {
    onDelete: 'set null',
  }),
  defaultRecurring: boolean('default_recurring').notNull().default(false),
  // true = this subscription bills once a year. Monthly/quarterly cadence is
  // inferred from history; annual can't be reliably (one data point a year),
  // so the owner declares it and the watchdog keys its "active" and
  // price-stability windows off a 12-month gap (§18).
  recurringAnnual: boolean('recurring_annual').notNull().default(false),
  defaultSpecial: boolean('default_special').notNull().default(false),
  // true = the owner dismissed this merchant as a projected-bill suggestion, so
  // the Settings auto-detector stops proposing it (see projection_rules).
  projectionDismissed: boolean('projection_dismissed').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * The "learning" layer. On import, a transaction's normalized key is matched
 * against these rules to find its merchant:
 *  - exact_key: pattern === normalizeKey(raw). Auto-created on first sighting.
 *  - contains:  normalizeKey(raw) includes pattern. Created when the user
 *               teaches a grouping ("anything with AMAZON is Amazon").
 * Higher priority wins; among equal priority, longer patterns win.
 */
export const merchantRules = pgTable(
  'merchant_rules',
  {
    id: serial('id').primaryKey(),
    pattern: text('pattern').notNull(),
    matchType: text('match_type', { enum: ['exact_key', 'contains'] })
      .notNull()
      .default('exact_key'),
    merchantId: integer('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('merchant_rules_pattern_idx').on(t.pattern)]
)

/**
 * One upload = one batch. Lets us trace where rows came from and undo an import.
 */
export const importBatches = pgTable('import_batches', {
  id: serial('id').primaryKey(),
  source: text('source', { enum: ['master', 'amex', 'tangerine', 'scotia'] }).notNull(),
  filename: text('filename').notNull(),
  periodLabel: text('period_label').notNull(),
  rowCount: integer('row_count').notNull().default(0),
  insertedCount: integer('inserted_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * Per-source health of the automated daily sync (the Mac-side budget-sync
 * runner). One upserted row per source: the runner POSTs /api/sync-status with
 * 'ok' or 'fail' on every run, so the dashboard can show *which* bank failed and
 * when it last worked — without waiting for the 3-day staleness heuristic.
 *
 * `lastSuccessAt` is "the last time it actually worked" (login → export → post
 * all succeeded), preserved across failures. `error` holds the most recent
 * failure message; `failureCount` is consecutive failures (reset to 0 on ok).
 * A successful sync that imports 0 new rows still counts as working.
 */
export const syncRuns = pgTable('sync_runs', {
  id: serial('id').primaryKey(),
  source: text('source', { enum: ['master', 'amex', 'tangerine', 'scotia'] })
    .notNull()
    .unique(),
  status: text('status', { enum: ['ok', 'fail'] }).notNull(),
  lastRunAt: timestamp('last_run_at').defaultNow().notNull(),
  lastSuccessAt: timestamp('last_success_at'),
  error: text('error'),
  failureCount: integer('failure_count').notNull().default(0),
})

/**
 * One row per database backup attempt (weekly launchd job + manual `npm run
 * backup`). Written by sync/backup → POST /api/backup-status. Unlike sync_runs
 * this is append-only history (no per-source unique row): the dashboard reads
 * the most recent successful row to decide if backups have gone stale (>2 weeks
 * → BackupStatusBanner). See sync/backup/README.md.
 */
export const backupRuns = pgTable('backup_runs', {
  id: serial('id').primaryKey(),
  status: text('status', { enum: ['ok', 'fail'] }).notNull(),
  lastRunAt: timestamp('last_run_at').defaultNow().notNull(),
  lastSuccessAt: timestamp('last_success_at'),
  filename: text('filename'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  error: text('error'),
})

/**
 * Consolidated transactions from both card sources.
 * Sign convention: positive = money out (expense), negative = money in
 * (refund/payment). isPayment rows (card payments) are excluded from analytics.
 */
export const transactions = pgTable(
  'transactions',
  {
    id: serial('id').primaryKey(),
    // The four import sources, plus 'manual' for app-generated synthetic rows
    // (goal funding/withdrawal ledger offsets, externalId 'goal:…'). 'manual'
    // rows belong to no bank account, so every source-whitelisted consumer
    // (bank balance, cashflow schedule, per-account filters) drops them
    // structurally instead of via per-query goal:% exclusions.
    source: text('source', { enum: ['master', 'amex', 'tangerine', 'scotia', 'manual'] }).notNull(),
    // 'expense' = spending, 'income' = money in (salary, etc.), 'transfer' =
    // inter-account / ignored card payments (excluded from both analytics).
    flow: text('flow', { enum: ['expense', 'income', 'transfer'] })
      .notNull()
      .default('expense'),
    // Stable identity for idempotent re-imports.
    externalId: text('external_id').notNull().unique(),
    txnDate: date('txn_date').notNull(),
    postedDate: date('posted_date'),
    rawDescription: text('raw_description').notNull(),
    merchantId: integer('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    // null = inherit the merchant's category.
    categoryId: integer('category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    rawCategory: text('raw_category'),
    cardLast4: text('card_last4'),
    country: text('country'),
    isPayment: boolean('is_payment').notNull().default(false),
    // null = inherit the merchant default.
    isRecurring: boolean('is_recurring'),
    isSpecial: boolean('is_special'),
    batchId: integer('batch_id').references(() => importBatches.id, {
      onDelete: 'set null',
    }),
    // Manual split: a peeled-off portion of another transaction (e.g. the $50 of
    // kids' clothes inside a Walmart grocery run). null = a normal/parent row.
    // Reducing the parent's amount + summing children keeps totals exact, so
    // analytics never double-count. Cascade so undoing a batch drops children too.
    splitParentId: integer('split_parent_id').references(
      (): AnyPgColumn => transactions.id,
      { onDelete: 'cascade' }
    ),
    // Free-text reminder set by the owner — e.g. "pizza at friend's house" on an
    // E-Transfer Out. Display-only; never affects analytics or business rules.
    note: text('note'),
    // true = the owner dismissed this row from the dashboard "needs categorizing"
    // banner (an Other/Uncategorized txn they're fine leaving as-is). Stored here
    // instead of localStorage so the dismissal syncs across devices.
    categorizeDismissed: boolean('categorize_dismissed').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('transactions_txn_date_idx').on(t.txnDate),
    index('transactions_merchant_idx').on(t.merchantId),
    index('transactions_split_parent_idx').on(t.splitParentId),
  ]
)

/**
 * A user-built custom report on the Custom page: an ordered list of "lines"
 * (series), each summing any mix of categories and/or merchants per month. A
 * transaction belongs to a line if its effective category OR its merchant is
 * listed (counted at most once per line). Series store IDs so renames/merges
 * follow automatically. `range` is the saved period selector for the chart.
 */
export type ReportSeries = {
  name: string
  color: string
  categoryIds: number[]
  merchantIds: number[]
}

export const customReports = pgTable('custom_reports', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  pinned: boolean('pinned').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  // '1' | '2' | '3' | '6' | '12' | 'ytd' | 'all'
  range: text('range').notNull().default('6'),
  series: jsonb('series').$type<ReportSeries[]>().notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

/**
 * Budget feature (the /budget page). A single settings row holds the year-end
 * net target and the average reference window; per-category goal overrides live
 * in `budget_goals`. Anything without a saved goal falls back to the AI-computed
 * suggestion (see app/lib/budget.ts). See BUSINESS_RULES.md §Budget.
 */
export const budgetSettings = pgTable('budget_settings', {
  id: serial('id').primaryKey(),
  // Desired year-end net (income − spend). Default 0 = break even.
  targetNet: numeric('target_net', { precision: 10, scale: 2 }).notNull().default('0'),
  // Which window drives the per-category averages shown across the page.
  periodMode: text('period_mode', { enum: ['year', '12mo'] })
    .notNull()
    .default('year'),
  // Latest anchor month (YYYY-MM) the seasonal proposal was auto-adopted for.
  // When the anchor advances past this, the budget auto-proposes the new month.
  budgetedMonth: text('budgeted_month'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const budgetGoals = pgTable('budget_goals', {
  id: serial('id').primaryKey(),
  categoryId: integer('category_id')
    .notNull()
    .unique()
    .references(() => categories.id, { onDelete: 'cascade' }),
  goalAmount: numeric('goal_amount', { precision: 10, scale: 2 }).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

/**
 * Uncontrolled recurring bills the owner can't avoid but that don't hit every
 * month (Belair insurance, Scholars, Koodo). One row per merchant.
 * The budget projects each bill's amount per month from history and replaces it
 * with the actual once the real transaction posts (see app/lib/projection.ts).
 * The "Home" category (Mortgage, Property Tax, Hydro, Water) is the always-fixed
 * category, so its members are NOT projection rules here (would double-count).
 */
export const projectionRules = pgTable('projection_rules', {
  id: serial('id').primaryKey(),
  merchantId: integer('merchant_id')
    .notNull()
    .unique()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  // Display label; defaults to the merchant name.
  label: text('label').notNull(),
  // How often the bill is due. 'periodic' = irregular gaps inferred from history.
  cadence: text('cadence', { enum: ['monthly', 'quarterly', 'annual', 'periodic'] })
    .notNull()
    .default('monthly'),
  // How to project the amount in a due month with no actual yet.
  //  seasonal = mean of that calendar month across years (Hydro winter≠summer)
  //  average  = mean of recent occurrences
  //  last     = most recent amount
  //  fixed    = the explicit fixedAmount below
  amountMode: text('amount_mode', { enum: ['seasonal', 'average', 'last', 'fixed'] })
    .notNull()
    .default('average'),
  fixedAmount: numeric('fixed_amount', { precision: 10, scale: 2 }),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * Goals feature (the /goals page). A goal is something the owner saves toward by
 * moving money to an investment/savings account. Two kinds:
 *  - 'savings'  — kitchen reno, debt-recovery, generic invest. Its current value
 *    is Σ goal_entries.amount and can be reconciled to a market value (stocks).
 *  - 'mortgage' — the special payoff card: balance counts DOWN to $0 by a target
 *    date (the owner's 50th birthday). annualRate is back-solved from overrides.
 * See BUSINESS_RULES.md §10. Personal figures (start balance, birth date) come
 * from .env.local, never committed code.
 */
export const goals = pgTable('goals', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  emoji: text('emoji').notNull().default('🎯'),
  color: text('color').notNull().default('#6366f1'),
  // 'savings' = generic/market-valued goal; 'mortgage' = payoff projection;
  // 'netzero' = the year-net recovery tracker (carries a deficit across years
  // until clawed back, then auto-archives). See BUSINESS_RULES.md §10.
  kind: text('kind', { enum: ['savings', 'mortgage', 'netzero'] })
    .notNull()
    .default('savings'),
  // Optional target. For mortgage this is 0 (payoff); targetDate is the deadline.
  targetAmount: numeric('target_amount', { precision: 12, scale: 2 }),
  targetDate: date('target_date'),
  // Mortgage only: current interest estimate, refined when the owner overrides
  // the real balance (see app/lib/mortgage.ts → inferRate).
  annualRate: numeric('annual_rate', { precision: 6, scale: 4 }),
  // Savings only: a fixed monthly auto-contribute amount. When set, the monthly
  // surplus-allocation prompt (§10b) pre-fills exactly this much for the goal (in
  // goal priority order, capped at the surplus left). null/0 = no rule.
  autoContribute: numeric('auto_contribute', { precision: 12, scale: 2 }),
  // Include this goal in immediate push notifications when its value changes.
  notify: boolean('notify').notNull().default(false),
  archived: boolean('archived').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * The ledger behind a goal's value and its sparkline. kind:
 *  - 'contribution' — money added (signed amount). From a transfer allocation
 *    (transactionId set) or a manual "extra" deposit (no txn, no budget impact).
 *  - 'adjustment'   — savings market reconcile; amount = signed delta
 *    (new value − old value), so the running Σ equals the reconciled value.
 *  - 'balance'      — mortgage only; amount = the ABSOLUTE balance observed or
 *    overridden on occurredAt.
 *  - 'transfer'     — a rebalance between goals (signed amount, no transactionId).
 *    Counts toward the goal's value but is NOT new savings/contribution — excluded
 *    from totalContributed, the 50/30/20 manual-savings count, and "invested this
 *    month". The matching ledger row lives on the other goal; see goal_transfers.
 * A 3k transfer split across goals is several 'contribution' rows that share one
 * transactionId.
 */
export const goalEntries = pgTable(
  'goal_entries',
  {
    id: serial('id').primaryKey(),
    goalId: integer('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['contribution', 'adjustment', 'balance', 'transfer'] })
      .notNull()
      .default('contribution'),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    transactionId: integer('transaction_id').references(() => transactions.id, {
      onDelete: 'set null',
    }),
    occurredAt: date('occurred_at').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('goal_entries_goal_idx').on(t.goalId)]
)

/**
 * Money moved between two savings goals (a rebalance), recorded so the "owed back"
 * figure on a lender goal can be computed. Each row is mirrored by two
 * goal_entries (kind 'transfer'): −amount on `fromGoalId`, +amount on `toGoalId`.
 * No transaction is created (the money already left net when first contributed),
 * so transfers never touch the budget/analytics and never notify. kind:
 *  - 'transfer' — a permanent rebalance, no debt.
 *  - 'borrow'   — `fromGoalId` lends to `toGoalId`; the lender is owed it back.
 *  - 'repay'    — settles a borrow: `fromGoalId` (the borrower) pays `toGoalId`
 *    (the lender) back, reducing the outstanding owed amount.
 * Owed back to a lender L = Σ borrow[from=L] − Σ repay[to=L]. See BUSINESS_RULES §10.
 */
export const goalTransfers = pgTable(
  'goal_transfers',
  {
    id: serial('id').primaryKey(),
    fromGoalId: integer('from_goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    toGoalId: integer('to_goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    kind: text('kind', { enum: ['transfer', 'borrow', 'repay'] })
      .notNull()
      .default('transfer'),
    occurredAt: date('occurred_at').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('goal_transfers_from_idx').on(t.fromGoalId),
    index('goal_transfers_to_idx').on(t.toGoalId),
  ]
)

/**
 * Monthly surplus allocation (the dashboard "give every dollar a job" prompt).
 * One row per completed month once the owner has actioned it. `percents` holds
 * only the SAVINGS-goal shares ({ "<goalId>": pct }); the Net-Zero goal is the
 * implicit remainder (100 − Σ), so it never appears here and is never written —
 * the surplus already counts toward it via cumulative net. A 'dismissed' row
 * with empty percents means "all to Net-Zero" (auto when the prompt is ignored).
 * See BUSINESS_RULES.md §10b.
 */
export const monthAllocations = pgTable('month_allocations', {
  id: serial('id').primaryKey(),
  // The completed (source) month the surplus came from, YYYY-MM.
  month: text('month').notNull().unique(),
  status: text('status', { enum: ['allocated', 'dismissed'] })
    .notNull()
    .default('allocated'),
  // { "<savingsGoalId>": percent }. Net-Zero is the remainder, not stored.
  percents: jsonb('percents').$type<Record<string, number>>().notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * Emergency Fund tracking (the Goals page card). One row per observed/overridden
 * ABSOLUTE balance of an account, like the mortgage's balance snapshots. The
 * first snapshot per source is the owner-entered starting balance; a manual
 * correction is just a newer snapshot (it re-anchors and absorbs any drift).
 *
 * `tangerine`/`scotia` are chequing accounts auto-tracked from imported bank
 * flows: current balance = latest snapshot + net real flows since (see
 * app/lib/emergency.ts). `investment` is a low-risk holding the system can't see
 * in any CSV, so it has NO flows and stays at its last manually-entered snapshot.
 * The fund total = Σ over all sources. Synthetic goal moves (externalId LIKE
 * 'goal:%') are excluded from the bank flows. See BUSINESS_RULES.md §12.
 */
export const accountSnapshots = pgTable(
  'account_snapshots',
  {
    id: serial('id').primaryKey(),
    source: text('source', { enum: ['tangerine', 'scotia', 'investment'] }).notNull(),
    // Absolute balance of the account at occurredAt.
    balance: numeric('balance', { precision: 12, scale: 2 }).notNull(),
    occurredAt: date('occurred_at').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('account_snapshots_source_idx').on(t.source)]
)

/**
 * History of the Emergency-runway widget (dashboard). One point per day the
 * worst-case runway (the higher earner losing their job, trips included) changes,
 * starting the first day it's viewed. Lets the chart show whether the runway is
 * trending up. `months` is null when the runway is effectively infinite (income
 * covers the burn). See BUSINESS_RULES.md §13.
 */
export const runwaySnapshots = pgTable('runway_snapshots', {
  id: serial('id').primaryKey(),
  occurredAt: date('occurred_at').notNull(),
  months: numeric('months', { precision: 6, scale: 2 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * Singleton holding the owner's edits to the "safe to move" cash-flow tool
 * (app/lib/cashflow.ts). The schedule (income/bill/CC days & amounts) is INFERRED
 * from history each load; this row only stores the owner's corrections so the
 * inference stays the default. See BUSINESS_RULES.md §14.
 *  - buffers           — fixed $ cushion to keep per account { tangerine, scotia }
 *  - cardAccounts      — which bank pays each card { master, amex }
 *  - ccPaymentDay      — the day of month BOTH cards are paid (owner pays ~the 11th)
 *  - ccPendingBuffer   — combined $ added to the card payment for pending charges
 *    that haven't exported to CSV yet (a safety margin, default $400)
 *  - overrides         — array of per-event edits { key, account?, dayOfMonth?, amount?, enabled? }
 *  - unplannedExpense  — the manual "big expense before next CC payment", PER account
 *    { tangerine, scotia }
 */
export const cashflowConfig = pgTable('cashflow_config', {
  id: serial('id').primaryKey(),
  buffers: jsonb('buffers').notNull().default({ tangerine: 0, scotia: 0 }),
  cardAccounts: jsonb('card_accounts').notNull().default({ master: 'tangerine', amex: 'tangerine' }),
  ccPaymentDay: integer('cc_payment_day').notNull().default(11),
  ccPendingBuffer: numeric('cc_pending_buffer', { precision: 10, scale: 2 }).notNull().default('400'),
  overrides: jsonb('overrides').notNull().default([]),
  unplannedExpense: jsonb('unplanned_expense').notNull().default({ tangerine: 0, scotia: 0 }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

/**
 * The dashboard "needs a decision" queue. Two directions (see app/actions/import.ts):
 *  - 'out' — outbound investment transfers (the $900 kitchen transfer and any
 *    non-$1,100 customer transfer) the owner attributes to a goal (money in).
 *  - 'in'  — inbound money landing in chequing from the investment account (an
 *    unknown deposit). Tag it to a goal → it counts as income offsetting a real
 *    purchase ("spend from a goal"); otherwise keep it as Other Income or ignore.
 */
export const transferReviews = pgTable('transfer_reviews', {
  id: serial('id').primaryKey(),
  transactionId: integer('transaction_id')
    .notNull()
    .unique()
    .references(() => transactions.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['pending', 'resolved', 'dismissed'] })
    .notNull()
    .default('pending'),
  // 'out' = money leaving to investments (grows a goal); 'in' = money returning
  // from investments (a goal "spend", counted as income).
  direction: text('direction', { enum: ['out', 'in'] })
    .notNull()
    .default('out'),
  // Auto-suggested goal, learned from prior transfers of the same amount.
  suggestedGoalId: integer('suggested_goal_id').references(() => goals.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at'),
})

/**
 * Web Push subscriptions for the daily digest notification. One row per
 * browser/device that opted in (Settings → Notifications). The digest runner
 * triggers POST /api/digest, which sends the notification to every row here.
 * Expired endpoints (404/410 from the push service) are pruned on send.
 */
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: serial('id').primaryKey(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * One row per daily-digest run attempt (the 11:15 launchd job POSTing
 * /api/digest, or a manual retry from the dashboard's DigestStatusBanner).
 * Append-only history, like backup_runs: the dashboard reads the most recent
 * row to show the failure banner, and the digest route itself reads it to
 * decide whether to force tonight's push through even with no new spend (see
 * "previous run failed" in app/lib/digest.ts) — a silent gap is worse than an
 * uneventful notification.
 */
export const digestRuns = pgTable('digest_runs', {
  id: serial('id').primaryKey(),
  status: text('status', { enum: ['ok', 'fail'] }).notNull(),
  lastRunAt: timestamp('last_run_at').defaultNow().notNull(),
  error: text('error'),
})

/**
 * Idempotency guard for the monthly-report push. One row per reported month
 * (YYYY-MM); the digest endpoint inserts-if-absent before pushing so the daily job
 * firing repeatedly through the post-settle window can't double-send the recap.
 * Also guards the Year-in-Review push with a bare-YYYY key (app/lib/digest.ts) —
 * a year key can never collide with a month key, so the two share the table.
 */
export const monthReportPushes = pgTable('month_report_pushes', {
  ym: text('ym').primaryKey(),
  sentAt: timestamp('sent_at').defaultNow().notNull(),
})

/**
 * Idempotency guard for the daily digest push. One row per UTC calendar date
 * (YYYY-MM-DD). The digest endpoint insert-if-absents before pushing so that
 * per-sync triggers and the scheduled 11:15 job can't double-send on the same day.
 */
export const dailyDigestPushes = pgTable('daily_digest_pushes', {
  date: text('date').primaryKey(),
  sentAt: timestamp('sent_at').defaultNow().notNull(),
})

/**
 * Hysteresis state for mid-month category pace alerts (§B5). One row per
 * (month, category) that has been pushed as "running hot". A category is
 * re-alerted only when its month-to-date spend has grown past `spentAtPush` —
 * so "Groceries +30%" doesn't nag every day, but a new grocery run that moves
 * it to +31% alerts again. Rows for past months are inert (keyed by ym).
 */
export const paceAlertPushes = pgTable(
  'pace_alert_pushes',
  {
    ym: text('ym').notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    /** Month-to-date net spend at the moment the alert was pushed. */
    spentAtPush: numeric('spent_at_push', { precision: 10, scale: 2 }).notNull(),
    /** Projected overshoot % at push time (for reference/debugging). */
    overPct: integer('over_pct').notNull(),
    sentAt: timestamp('sent_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('pace_alert_pushes_ym_cat').on(t.ym, t.categoryId)]
)

/**
 * Brute-force throttle for the single shared login password. One row per client
 * IP: `failures` counts wrong passwords within a rolling window (windowStart),
 * and once the threshold is crossed `lockedUntil` blocks further attempts until
 * it elapses (see app/lib/rate-limit.ts). A successful login deletes the row.
 */
export const loginAttempts = pgTable('login_attempts', {
  ip: text('ip').primaryKey(),
  failures: integer('failures').notNull().default(0),
  windowStart: timestamp('window_start').defaultNow().notNull(),
  lockedUntil: timestamp('locked_until'),
})

/**
 * Projects (the /projects page). A "project" groups arbitrary transactions so
 * the owner can total and compare a real-world thing — a trip ("UK 2026"), a
 * renovation, a wedding — independent of categories. It is a pure OVERLAY: a
 * transaction's membership never recategorizes it or changes its flow, so all
 * spend analytics, the budget and the Income page are untouched. Membership is
 * many-to-many (a txn can sit in more than one project) via project_transactions.
 * See BUSINESS_RULES.md §15.
 */
export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  emoji: text('emoji').notNull().default('🧳'),
  color: text('color').notNull().default('#6366f1'),
  // Cover photo, stored in Vercel Blob (the URL only). Null = show emoji/color.
  coverImageUrl: text('cover_image_url'),
  // Optional real-world span of the project (e.g. the trip dates). Drives the
  // detail page's date range and the auto-population window.
  startDate: date('start_date'),
  endDate: date('end_date'),
  notes: text('notes'),
  sortOrder: integer('sort_order').notNull().default(0),
  archived: boolean('archived').notNull().default(false),
  // Dashboard reminder: a project with dates surfaces on the Overview when its
  // window is near/current (from ~3 weeks before start through end + 10 days).
  // Set true when the owner clicks "Dismiss" on that banner so it stops showing.
  dashboardDismissed: boolean('dashboard_dismissed').notNull().default(false),
  // Auto-fill: when set, all credit-card (master/amex) transactions in the
  // date window for the chosen cardholder(s) are auto-added on project creation
  // and when "Refresh auto-fill" is triggered. Recurring transactions go to
  // "needs review" instead of being auto-added. null = manual-only project.
  autoFill: text('auto_fill', { enum: ['self', 'partner', 'both'] }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * Membership join: which transactions belong to which project. Many-to-many,
 * unique per (project, transaction). Cascades on either side's delete so
 * removing a project — or undoing the import batch that owns a transaction —
 * never leaves dangling rows. Deleting a membership never touches the txn.
 *
 * `dismissed = true` is a tombstone: the owner reviewed a SUGGESTED candidate
 * (in-window, unknown-country row) and said "not part of this project". It is
 * NOT a member (excluded from totals, the member list and Activity badges) but
 * still suppresses that txn from the "Suggested — review" list so it never
 * reappears. Adding the txn later flips it back to a real member (dismissed=false).
 */
export const projectTransactions = pgTable(
  'project_transactions',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    dismissed: boolean('dismissed').notNull().default(false),
    // true = auto-filled but pending owner review (recurring/bill-like txns).
    // Not counted in project totals or member list until approved (needsReview→false).
    // dismissed wins: a dismissed row is always suppressed regardless of needsReview.
    needsReview: boolean('needs_review').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('project_txn_unique_idx').on(t.projectId, t.transactionId),
    index('project_txn_project_idx').on(t.projectId),
    index('project_txn_txn_idx').on(t.transactionId),
  ]
)

/**
 * Investments feature (the /investments page). Registered brokerage accounts the
 * owner holds at iTrade — a TFSA, a RESP, later a second TFSA (the partner's).
 * This is a deterministic OVERLAY on the existing transfer/goal machinery, not a
 * trading tracker: contribution room & RESP grant are DERIVED from a ledger of
 * contributions (the Scotia→iTrade transfers the owner tags) plus a CRA baseline;
 * holdings are periodic CSV snapshots valued in CAD (USD positions converted by a
 * Bank-of-Canada rate stored on the snapshot). No live prices, no AI. See
 * BUSINESS_RULES.md §16. `owner` defaults to 'self' so a future partner account
 * is distinct.
 */
export const registeredAccounts = pgTable('registered_accounts', {
  id: serial('id').primaryKey(),
  // Plan type — drives which rule engine applies (TFSA room vs RESP grant).
  kind: text('kind', { enum: ['tfsa', 'resp', 'rrsp', 'fhsa', 'nonreg'] }).notNull(),
  name: text('name').notNull(),
  // Whose account it is — 'self' (default) or 'partner', so a second TFSA later
  // is tracked separately. Never a real name (privacy; display name from env).
  owner: text('owner', { enum: ['self', 'partner'] }).notNull().default('self'),
  // The iTrade account number from the holdings-CSV filename, to match an upload
  // to its account. Null for a manually-created account with no CSV yet.
  brokerageAccountNo: text('brokerage_account_no'),
  currency: text('currency').notNull().default('CAD'),
  // TFSA: the CRA-confirmed contribution room as of roomBaselineDate (a Jan 1).
  // Room is then DERIVED = baseline + future annual limits − net contributions
  // since the baseline (see app/lib/tfsa.ts), so tagging a transfer recalcs it.
  roomBaselineAmount: numeric('room_baseline_amount', { precision: 12, scale: 2 }),
  roomBaselineDate: date('room_baseline_date'),
  // RESP: beneficiary birth year (grant deadline = end of year they turn 17),
  // lifetime CESG grant already received before tracking, lifetime contributions
  // before tracking (for the $50k cap), and unused CESG carry-forward room now.
  beneficiaryBirthYear: integer('beneficiary_birth_year'),
  grantBaselineReceived: numeric('grant_baseline_received', { precision: 10, scale: 2 }),
  contributionBaseline: numeric('contribution_baseline', { precision: 12, scale: 2 }),
  grantCarryForward: numeric('grant_carry_forward', { precision: 10, scale: 2 }),
  sortOrder: integer('sort_order').notNull().default(0),
  archived: boolean('archived').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * One holdings snapshot = one CSV import for an account at a point in time. The
 * positions live in holding_positions; this header stores the FX rate used and a
 * denormalized CAD total (for the value-over-time trend). fxUsdCad = 1 for an
 * all-CAD account. The rate is fetched from the Bank of Canada on import and
 * stored here so the snapshot's CAD total stays reproducible forever.
 */
export const holdingSnapshots = pgTable(
  'holding_snapshots',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => registeredAccounts.id, { onDelete: 'cascade' }),
    occurredAt: date('occurred_at').notNull(),
    fxUsdCad: numeric('fx_usd_cad', { precision: 10, scale: 5 }).notNull().default('1'),
    totalValueCad: numeric('total_value_cad', { precision: 14, scale: 2 }).notNull().default('0'),
    note: text('note'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('holding_snapshots_account_idx').on(t.accountId)]
)

/** One position within a holdings snapshot (a row of the iTrade portfolio CSV). */
export const holdingPositions = pgTable(
  'holding_positions',
  {
    id: serial('id').primaryKey(),
    snapshotId: integer('snapshot_id')
      .notNull()
      .references(() => holdingSnapshots.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    name: text('name'),
    assetClass: text('asset_class'),
    currency: text('currency').notNull().default('CAD'),
    quantity: numeric('quantity', { precision: 16, scale: 4 }),
    avgCost: numeric('avg_cost', { precision: 14, scale: 4 }),
    marketPrice: numeric('market_price', { precision: 14, scale: 4 }),
    bookValue: numeric('book_value', { precision: 14, scale: 2 }),
    // Market value in the position's own currency, and converted to CAD.
    marketValue: numeric('market_value', { precision: 14, scale: 2 }),
    marketValueCad: numeric('market_value_cad', { precision: 14, scale: 2 }),
    changePct: numeric('change_pct', { precision: 10, scale: 2 }),
    changeAmount: numeric('change_amount', { precision: 14, scale: 2 }),
  },
  (t) => [index('holding_positions_snapshot_idx').on(t.snapshotId)]
)

/**
 * The contribution ledger behind an account's TFSA room / RESP grant. A
 * 'contribution' is money in (counts against TFSA room, earns RESP grant); a
 * 'withdrawal' is money out (TFSA: the room returns on Jan 1 of the NEXT year).
 * `transactionId` is set when the row came from tagging an imported Scotia→iTrade
 * transfer (unique, so a transfer is counted once); null for a manual entry.
 * `amount` is always stored positive; `kind` carries the direction.
 */
export const registeredContributions = pgTable(
  'registered_contributions',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => registeredAccounts.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['contribution', 'withdrawal'] })
      .notNull()
      .default('contribution'),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    occurredAt: date('occurred_at').notNull(),
    transactionId: integer('transaction_id').references(() => transactions.id, {
      onDelete: 'set null',
    }),
    note: text('note'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('registered_contributions_account_idx').on(t.accountId),
    // A given transfer can back at most one contribution row (multiple NULLs are
    // allowed by Postgres, so manual entries are unconstrained).
    uniqueIndex('registered_contributions_txn_idx').on(t.transactionId),
  ]
)

/**
 * Singleton config for the Emergency Fund's TFSA line (§12/§16). `tfsaMode`
 * chooses how much of the TFSA counts as emergency-accessible cash:
 *  - 'crash_adjusted' (default) — the whole TFSA discounted by `tfsaHaircutPct`,
 *    so the emergency figure reflects what it'd realistically be worth mid-crash
 *    (lets the TFSA hold pure growth ETFs and still be a sane emergency backstop).
 *  - 'cash_equivalent' — only the cash-equivalent holdings (money-market ETFs), a
 *    stable reserve that doesn't swing with the equity markets. Requires such a
 *    holding to exist; the option is disabled in the UI when none does.
 *  - 'whole' — the full TFSA market value, undiscounted.
 * `tfsaHaircutPct` is the assumed crash drawdown for 'crash_adjusted' mode (counted
 * value = whole × (1 − pct/100)); 30 ≈ an 80/20 ETF's worst realistic drawdown.
 */
export const emergencyConfig = pgTable('emergency_config', {
  id: serial('id').primaryKey(),
  tfsaMode: text('tfsa_mode', { enum: ['cash_equivalent', 'whole', 'crash_adjusted'] })
    .notNull()
    .default('crash_adjusted'),
  tfsaHaircutPct: integer('tfsa_haircut_pct').notNull().default(30),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

/**
 * Per-merchant, per-amount auto-fill rules. When a future import produces a
 * transaction with the same merchant and exact amount, it automatically inherits
 * the saved category and note — useful for recurring fixed-amount payments like
 * monthly garage transfers that always use a generic merchant (E-Transfer Out).
 * Unique on (merchant_id, amount) so one rule per price point.
 */
export const merchantAmountRules = pgTable(
  'merchant_amount_rules',
  {
    id: serial('id').primaryKey(),
    merchantId: integer('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    note: text('note'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('merchant_amount_rules_unique_idx').on(t.merchantId, t.amount)]
)

/**
 * The Manage → Feedback tracker: a personal todo list of bugs to fix and ideas
 * to build. Marking an item complete just flags it `completed` — it stays in
 * the table so it can be filtered into view or reactivated.
 */
export const feedbackItems = pgTable('feedback_items', {
  id: serial('id').primaryKey(),
  kind: text('kind', { enum: ['bug', 'idea'] }).notNull(),
  label: text('label').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  completed: boolean('completed').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * Owner-dismissed subscription price-change alerts (§18). The watchdog fires when
 * a stable price changes on the latest charge, but a change can be spurious — e.g.
 * a merchant billed several times in one month because of a payment-schedule quirk,
 * which inflates that month's total and looks like a price hike. One row per
 * merchant records the exact change the owner marked "not a real increase":
 * `sinceYm` (the month the flagged price posted) + `amount` (that flagged total,
 * cents-exact). The alert is suppressed only while it still matches this signature,
 * so a genuine LATER price change (different month or amount) alerts again.
 */
export const subscriptionAlertDismissals = pgTable('subscription_alert_dismissals', {
  id: serial('id').primaryKey(),
  merchantId: integer('merchant_id')
    .notNull()
    .unique()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  sinceYm: text('since_ym').notNull(),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * Owner-dismissed "annual subscription renews soon" warnings (§18b). The renewal
 * watchdog surfaces a dashboard banner ~1 month before a declared-annual
 * subscription's yearly charge is due (renewal = last charge date + 12 months),
 * so the owner can cancel before being billed again. The banner persists in the
 * DB (not device-local) so it shows across devices until acknowledged. One row
 * per merchant records the exact renewal cycle dismissed — `renewalYm` (the
 * YYYY-MM the renewal falls in). Next year's renewal is a different `renewalYm`,
 * so it warns again; the dismissal is not a permanent mute.
 */
export const subscriptionRenewalDismissals = pgTable('subscription_renewal_dismissals', {
  id: serial('id').primaryKey(),
  merchantId: integer('merchant_id')
    .notNull()
    .unique()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  renewalYm: text('renewal_ym').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * Owner-dismissed "bill due soon" reminders (§19). The bills calendar warns at
 * the top of the dashboard 2 days before each projected bill's expected day; the
 * warning clears on its own when the payment posts, or the owner can dismiss it.
 * One row per bill: `billKey` identifies the bill ('m:<merchantId>' for merchant
 * bills, 'cc' for the credit-card payment pseudo-bill) and `dueYm` records the
 * exact cycle dismissed — next month's due date is a new cycle, so it warns again.
 */
export const billReminderDismissals = pgTable('bill_reminder_dismissals', {
  id: serial('id').primaryKey(),
  billKey: text('bill_key').notNull().unique(),
  dueYm: text('due_ym').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const categoriesRelations = relations(categories, ({ many }) => ({
  merchants: many(merchants),
  transactions: many(transactions),
}))

export const merchantsRelations = relations(merchants, ({ one, many }) => ({
  category: one(categories, {
    fields: [merchants.categoryId],
    references: [categories.id],
  }),
  rules: many(merchantRules),
  transactions: many(transactions),
}))

export const merchantRulesRelations = relations(merchantRules, ({ one }) => ({
  merchant: one(merchants, {
    fields: [merchantRules.merchantId],
    references: [merchants.id],
  }),
}))

export const transactionsRelations = relations(transactions, ({ one }) => ({
  merchant: one(merchants, {
    fields: [transactions.merchantId],
    references: [merchants.id],
  }),
  category: one(categories, {
    fields: [transactions.categoryId],
    references: [categories.id],
  }),
  batch: one(importBatches, {
    fields: [transactions.batchId],
    references: [importBatches.id],
  }),
}))

export const projectsRelations = relations(projects, ({ many }) => ({
  members: many(projectTransactions),
}))

export const projectTransactionsRelations = relations(projectTransactions, ({ one }) => ({
  project: one(projects, {
    fields: [projectTransactions.projectId],
    references: [projects.id],
  }),
  transaction: one(transactions, {
    fields: [projectTransactions.transactionId],
    references: [transactions.id],
  }),
}))

export const goalsRelations = relations(goals, ({ many }) => ({
  entries: many(goalEntries),
}))

export const goalEntriesRelations = relations(goalEntries, ({ one }) => ({
  goal: one(goals, {
    fields: [goalEntries.goalId],
    references: [goals.id],
  }),
}))

export const registeredAccountsRelations = relations(registeredAccounts, ({ many }) => ({
  snapshots: many(holdingSnapshots),
  contributions: many(registeredContributions),
}))

export const holdingSnapshotsRelations = relations(holdingSnapshots, ({ one, many }) => ({
  account: one(registeredAccounts, {
    fields: [holdingSnapshots.accountId],
    references: [registeredAccounts.id],
  }),
  positions: many(holdingPositions),
}))

export const holdingPositionsRelations = relations(holdingPositions, ({ one }) => ({
  snapshot: one(holdingSnapshots, {
    fields: [holdingPositions.snapshotId],
    references: [holdingSnapshots.id],
  }),
}))

export const registeredContributionsRelations = relations(registeredContributions, ({ one }) => ({
  account: one(registeredAccounts, {
    fields: [registeredContributions.accountId],
    references: [registeredAccounts.id],
  }),
}))

export type Category = typeof categories.$inferSelect
export type Merchant = typeof merchants.$inferSelect
export type MerchantRule = typeof merchantRules.$inferSelect
export type ImportBatch = typeof importBatches.$inferSelect
export type SyncRun = typeof syncRuns.$inferSelect
export type Transaction = typeof transactions.$inferSelect
export type CustomReport = typeof customReports.$inferSelect
export type BudgetSettings = typeof budgetSettings.$inferSelect
export type BudgetGoal = typeof budgetGoals.$inferSelect
export type ProjectionRule = typeof projectionRules.$inferSelect
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect
export type LoginAttempt = typeof loginAttempts.$inferSelect
export type Goal = typeof goals.$inferSelect
export type GoalEntry = typeof goalEntries.$inferSelect
export type GoalTransfer = typeof goalTransfers.$inferSelect
export type TransferReview = typeof transferReviews.$inferSelect
export type AccountSnapshot = typeof accountSnapshots.$inferSelect
export type RunwaySnapshot = typeof runwaySnapshots.$inferSelect
export type Project = typeof projects.$inferSelect
export type ProjectTransaction = typeof projectTransactions.$inferSelect
export type AutoFill = 'self' | 'partner' | 'both'
export type RegisteredAccount = typeof registeredAccounts.$inferSelect
export type HoldingSnapshot = typeof holdingSnapshots.$inferSelect
export type HoldingPosition = typeof holdingPositions.$inferSelect
export type RegisteredContribution = typeof registeredContributions.$inferSelect
export type RegisteredKind = 'tfsa' | 'resp' | 'rrsp' | 'fhsa' | 'nonreg'
export type EmergencyConfig = typeof emergencyConfig.$inferSelect
export type TfsaEmergencyMode = 'cash_equivalent' | 'whole' | 'crash_adjusted'
export type FeedbackItem = typeof feedbackItems.$inferSelect
export type FeedbackKind = 'bug' | 'idea'
export type SubscriptionAlertDismissal = typeof subscriptionAlertDismissals.$inferSelect
export type SubscriptionRenewalDismissal = typeof subscriptionRenewalDismissals.$inferSelect
