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
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('transactions_txn_date_idx').on(t.txnDate),
    index('transactions_merchant_idx').on(t.merchantId),
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

export type Category = typeof categories.$inferSelect
export type Merchant = typeof merchants.$inferSelect
export type MerchantRule = typeof merchantRules.$inferSelect
export type ImportBatch = typeof importBatches.$inferSelect
export type Transaction = typeof transactions.$inferSelect
export type CustomReport = typeof customReports.$inferSelect
export type BudgetSettings = typeof budgetSettings.$inferSelect
export type BudgetGoal = typeof budgetGoals.$inferSelect
export type ProjectionRule = typeof projectionRules.$inferSelect
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect
