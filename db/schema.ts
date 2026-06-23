import {
  pgTable,
  serial,
  text,
  numeric,
  date,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
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
 * Consolidated transactions from both card sources.
 * Sign convention: positive = money out (expense), negative = money in
 * (refund/payment). isPayment rows (card payments) are excluded from analytics.
 */
export const transactions = pgTable(
  'transactions',
  {
    id: serial('id').primaryKey(),
    source: text('source', { enum: ['master', 'amex', 'tangerine', 'scotia'] }).notNull(),
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
    kind: text('kind', { enum: ['contribution', 'adjustment', 'balance'] })
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

export const goalsRelations = relations(goals, ({ many }) => ({
  entries: many(goalEntries),
}))

export const goalEntriesRelations = relations(goalEntries, ({ one }) => ({
  goal: one(goals, {
    fields: [goalEntries.goalId],
    references: [goals.id],
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
export type TransferReview = typeof transferReviews.$inferSelect
export type AccountSnapshot = typeof accountSnapshots.$inferSelect
export type RunwaySnapshot = typeof runwaySnapshots.$inferSelect
