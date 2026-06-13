import { pgTable, serial, text, numeric, date, timestamp } from 'drizzle-orm/pg-core'

export const transactions = pgTable('transactions', {
  id: serial('id').primaryKey(),
  date: date('date').notNull(),
  description: text('description').notNull(),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  category: text('category'),
  card: text('card'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
