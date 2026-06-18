/**
 * Seed data for categories and well-known merchant brands. Brand patterns are
 * lowercase substrings matched against normalizeKey() output to create
 * `contains` merchant_rules, so common variants group out-of-the-box. Everything
 * here is user-editable after seeding; the seed only creates what's missing.
 */

export type CategoryKind = 'expense' | 'income' | 'neutral'
export type CategorySeed = { name: string; color: string; kind?: CategoryKind }

export const CATEGORY_SEED: CategorySeed[] = [
  // Spending (kind defaults to 'expense').
  { name: 'Groceries', color: '#16a34a' },
  { name: 'Dining', color: '#f97316' },
  // Transport = public transit only; car costs (fuel, parking, maintenance,
  // insurance) all live in "Cars".
  { name: 'Transport', color: '#0ea5e9' },
  { name: 'Cars', color: '#eab308' },
  { name: 'Shopping', color: '#8b5cf6' },
  { name: 'Health', color: '#ef4444' },
  { name: 'Dental', color: '#22d3ee' },
  { name: 'Subscriptions', color: '#6366f1' },
  // Home = "cost to keep the house": Mortgage, Property Tax, Hydro, Water. It is
  // the single always-fixed/unavoidable category (see app/lib/budget.ts).
  { name: 'Home', color: '#14b8a6' },
  { name: 'Utilities', color: '#64748b' },
  { name: 'Kids', color: '#ec4899' },
  { name: 'Travel', color: '#06b6d4' },
  { name: 'Entertainment', color: '#a855f7' },
  { name: 'Other', color: '#94a3b8' },
  // Bank expenses.
  { name: 'Investment', color: '#0d9488', kind: 'expense' },
  { name: 'CC Payment', color: '#9ca3af', kind: 'expense' },
  { name: 'Bank Fees', color: '#71717a', kind: 'expense' },
  { name: 'Cash', color: '#a16207', kind: 'expense' },
  // Income.
  { name: 'Salary', color: '#22c55e', kind: 'income' },
  { name: 'Family Support', color: '#f59e0b', kind: 'income' },
  { name: 'Insurance', color: '#3b82f6', kind: 'income' },
  { name: 'Benefits', color: '#10b981', kind: 'income' },
  { name: 'Tax Refund', color: '#84cc16', kind: 'income' },
  { name: 'Interest', color: '#14b8a6', kind: 'income' },
  { name: 'Other Income', color: '#4ade80', kind: 'income' },
  // Neutral (inter-account / ignored transfers; excluded from analytics).
  { name: 'Transfer', color: '#cbd5e1', kind: 'neutral' },
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
  // Costco gas is a car cost; the warehouse is groceries. Longer pattern wins.
  { name: 'Costco Gas', category: 'Cars', patterns: ['costco gas'] },
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
  { name: 'Petro-Canada', category: 'Cars', patterns: ['petro canada'] },
  // Canadian Tire gas vs hardware store.
  { name: 'Canadian Tire Gas', category: 'Cars', patterns: ['canadian tire gas'] },
  { name: 'Canadian Tire', category: 'Shopping', patterns: ['canadian tire'] },
  { name: 'IKEA', category: 'Shopping', patterns: ['ikea'] },
  { name: 'LCBO', category: 'Shopping', patterns: ['lcbo'] },
  { name: 'Netflix', category: 'Subscriptions', patterns: ['netflix'], recurring: true },
  { name: 'Spotify', category: 'Subscriptions', patterns: ['spotify'], recurring: true },
  { name: 'Anthropic', category: 'Subscriptions', patterns: ['anthropic'], recurring: true },
  { name: 'YouTube', category: 'Subscriptions', patterns: ['youtube'], recurring: true },
  { name: 'Oddbunch', category: 'Groceries', patterns: ['oddbunch'], recurring: true },
  { name: 'Distributel', category: 'Subscriptions', patterns: ['distributel'], recurring: true },
  // Groceries
  { name: 'Metro', category: 'Groceries', patterns: ['metro'] },
  { name: 'Shoppers Drug Mart', category: 'Health', patterns: ['shoppers drug mart', 'shoppers'] },
  { name: 'Adonis', category: 'Groceries', patterns: ['adonis'] },
  { name: 'Nations Fresh Food', category: 'Groceries', patterns: ['nations fresh'] },
  // Dining
  { name: 'Uber', category: 'Transport', patterns: ['uber'] },
  { name: 'Baskin Robbins', category: 'Dining', patterns: ['baskin robbins'] },
  { name: 'Pizzaiolo', category: 'Dining', patterns: ['pizzaiolo'] },
  { name: 'Boston Pizza', category: 'Dining', patterns: ['boston pizza'] },
  { name: 'KFC', category: 'Dining', patterns: ['kfc'] },
  { name: 'East Side Marios', category: 'Dining', patterns: ['east side mario'] },
  { name: 'Cactus Club', category: 'Dining', patterns: ['cactus club'] },
  { name: 'Second Cup', category: 'Dining', patterns: ['second cup'] },
  { name: 'DavidsTea', category: 'Dining', patterns: ['davidstea'] },
  { name: 'Lindt', category: 'Dining', patterns: ['lindt'] },
  { name: 'Parma Pizza', category: 'Dining', patterns: ['parma pizza'] },
  // Shopping
  { name: 'Marshalls', category: 'Shopping', patterns: ['marshalls'] },
  { name: 'Winners', category: 'Shopping', patterns: ['winners'] },
  { name: 'Sport Chek', category: 'Shopping', patterns: ['sport chek'] },
  { name: 'Softmoc', category: 'Shopping', patterns: ['softmoc'] },
  { name: 'Bluenotes', category: 'Shopping', patterns: ['bluenotes'] },
  { name: 'Bath & Body Works', category: 'Shopping', patterns: ['bath and body'] },
  { name: 'Indigo', category: 'Shopping', patterns: ['indigo', 'chapters'] },
  { name: 'Crocs', category: 'Shopping', patterns: ['crocs'] },
  { name: 'DSW', category: 'Shopping', patterns: ['dsw'] },
  { name: 'Groupon', category: 'Shopping', patterns: ['groupon'] },
  // Home
  { name: 'Home Depot', category: 'Shopping', patterns: ['home depot', 'homedepotca'] },
  // Kids
  { name: 'Toys R Us', category: 'Kids', patterns: ['toys r us'] },
  { name: 'Mastermind Toys', category: 'Kids', patterns: ['mastermind toys'] },
  { name: 'The Lunch Lady', category: 'Kids', patterns: ['lunch lady'] },
  // Entertainment
  { name: 'Cineplex', category: 'Entertainment', patterns: ['cineplex'] },
  { name: 'Dave & Busters', category: 'Entertainment', patterns: ['dave and buster'] },
  { name: 'Air Riderz', category: 'Entertainment', patterns: ['air riderz'] },
  { name: 'Pickleplex', category: 'Entertainment', patterns: ['pickleplex'] },
  { name: 'Canada\'s Wonderland', category: 'Entertainment', patterns: ['wonderland'] },
  // Travel
  { name: 'British Airways', category: 'Travel', patterns: ['british airways'] },
  // Subscriptions
  { name: 'Real-Debrid', category: 'Subscriptions', patterns: ['real debrid'], recurring: true },
  { name: 'Audible', category: 'Subscriptions', patterns: ['audible'], recurring: true },
  // Cars (fuel)
  { name: 'Circle K', category: 'Cars', patterns: ['circle k'] },
]
