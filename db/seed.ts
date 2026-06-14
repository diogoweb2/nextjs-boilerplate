/**
 * Idempotent seed: inserts the starter categories and well-known brand merchants
 * (+ their `contains` rules). Safe to re-run — only creates what's missing, never
 * clobbers user edits. Run with: npm run db:seed
 */
import { db } from './index'
import { categories, merchants, merchantRules } from './schema'
import { CATEGORY_SEED, BRAND_SEED } from '../app/lib/seed-data'

async function seed() {
  // 1. Categories (unique by name). kind defaults to 'expense' when omitted.
  for (const c of CATEGORY_SEED) {
    await db
      .insert(categories)
      .values({ name: c.name, color: c.color, kind: c.kind ?? 'expense' })
      .onConflictDoNothing({ target: categories.name })
  }
  const catRows = await db.select().from(categories)
  const catId = new Map(catRows.map((c) => [c.name, c.id]))

  // 2. Brand merchants + contains rules (skip brands that already exist).
  const existing = await db.select({ name: merchants.name }).from(merchants)
  const existingNames = new Set(existing.map((m) => m.name))

  let createdMerchants = 0
  let createdRules = 0
  for (const brand of BRAND_SEED) {
    if (existingNames.has(brand.name)) continue
    const [merchant] = await db
      .insert(merchants)
      .values({
        name: brand.name,
        categoryId: catId.get(brand.category) ?? null,
        defaultRecurring: brand.recurring ?? false,
      })
      .returning({ id: merchants.id })
    createdMerchants++
    for (const pattern of brand.patterns) {
      await db.insert(merchantRules).values({
        pattern,
        matchType: 'contains',
        merchantId: merchant.id,
        // Longer/more specific patterns rank higher so "costco gas" beats "costco".
        priority: pattern.length,
      })
      createdRules++
    }
  }

  console.log(
    `Seed complete: ${catRows.length} categories, +${createdMerchants} merchants, +${createdRules} rules.`
  )
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
