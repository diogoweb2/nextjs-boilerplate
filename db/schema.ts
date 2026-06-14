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
  source: text('source', { enum: ['master', 'amex'] }).notNull(),
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
    source: text('source', { enum: ['master', 'amex'] }).notNull(),
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
