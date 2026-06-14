/**
 * Seed data for categories and well-known merchant brands. Brand patterns are
 * lowercase substrings matched against normalizeKey() output to create
 * `contains` merchant_rules, so common variants group out-of-the-box. Everything
 * here is user-editable after seeding; the seed only creates what's missing.
 */

export type CategorySeed = { name: string; color: string }

export const CATEGORY_SEED: CategorySeed[] = [
  { name: 'Groceries', color: '#16a34a' },
  { name: 'Dining', color: '#f97316' },
  { name: 'Transport', color: '#0ea5e9' },
  { name: 'Fuel', color: '#eab308' },
  { name: 'Shopping', color: '#8b5cf6' },
  { name: 'Health', color: '#ef4444' },
  { name: 'Subscriptions', color: '#6366f1' },
  { name: 'Home', color: '#14b8a6' },
  { name: 'Utilities', color: '#64748b' },
  { name: 'Kids', color: '#ec4899' },
  { name: 'Travel', color: '#06b6d4' },
  { name: 'Entertainment', color: '#a855f7' },
  { name: 'Other', color: '#94a3b8' },
]

export type BrandSeed = {
  name: string
  category: string
  /** Longer / more specific patterns should be listed; resolver prefers longest. */
  patterns: string[]
  recurring?: boolean
}

export const BRAND_SEED: BrandSeed[] = [
  { name: 'Amazon', category: 'Shopping', patterns: ['amazon', 'amzn'] },
  // Costco gas is fuel; the warehouse is groceries. Longer pattern wins.
  { name: 'Costco Gas', category: 'Fuel', patterns: ['costco gas'] },
  { name: 'Costco', category: 'Groceries', patterns: ['costco wholesale'] },
  { name: 'Walmart', category: 'Groceries', patterns: ['wal mart', 'walmart'] },
  { name: 'Fortinos', category: 'Groceries', patterns: ['fortinos'] },
  { name: 'No Frills', category: 'Groceries', patterns: ['nofrills', 'no frills'] },
  { name: 'FreshCo', category: 'Groceries', patterns: ['freshco'] },
  { name: 'PC Express', category: 'Groceries', patterns: ['pc express'] },
  { name: 'Rexall', category: 'Health', patterns: ['rexall'] },
  { name: 'Dollarama', category: 'Shopping', patterns: ['dollarama'] },
  { name: 'Presto', category: 'Transport', patterns: ['presto mobi', 'presto'] },
  { name: 'Tim Hortons', category: 'Dining', patterns: ['tim hortons'] },
  { name: 'McDonalds', category: 'Dining', patterns: ['mcdonald'] },
  { name: 'Pizza Pizza', category: 'Dining', patterns: ['pizza pizza'] },
  { name: 'Petro-Canada', category: 'Fuel', patterns: ['petro canada'] },
  // Canadian Tire gas vs hardware store.
  { name: 'Canadian Tire Gas', category: 'Fuel', patterns: ['canadian tire gas'] },
  { name: 'Canadian Tire', category: 'Home', patterns: ['canadian tire'] },
  { name: 'IKEA', category: 'Home', patterns: ['ikea'] },
  { name: 'LCBO', category: 'Shopping', patterns: ['lcbo'] },
  { name: 'Netflix', category: 'Subscriptions', patterns: ['netflix'], recurring: true },
  { name: 'Spotify', category: 'Subscriptions', patterns: ['spotify'], recurring: true },
  { name: 'Anthropic', category: 'Subscriptions', patterns: ['anthropic'], recurring: true },
  { name: 'YouTube', category: 'Subscriptions', patterns: ['youtube'], recurring: true },
  { name: 'Oddbunch', category: 'Groceries', patterns: ['oddbunch'], recurring: true },
  { name: 'Distributel', category: 'Utilities', patterns: ['distributel'], recurring: true },
]
