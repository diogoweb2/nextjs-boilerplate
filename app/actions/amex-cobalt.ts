'use server'

import { and, eq, isNotNull } from 'drizzle-orm'
import { db } from '@/db'
import { transactions, goals, goalEntries } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { isDemoSession } from '@/app/lib/demo'
import { cardholderKey } from '@/app/lib/cardholders'
import type { CardRewardContext } from '@/app/lib/amex-cobalt'

/**
 * Everything the card-reward models (§24/§25) need beyond `loadAllFlows()`:
 *
 * - **countryById** — merchant country code per transaction, for the domestic
 *   vs foreign cash-back split. Only Master-format card rows carry a real code
 *   (§1); everything else is `null` and treated as domestic.
 * - **giftCardLoadIds** — transactions that `loadGiftCard` (§10c) flipped to
 *   `flow = 'transfer'`. They are real card swipes at a supermarket, so the
 *   reward models must count them even though spend analytics don't.
 * - **personById** — which cardholder made the purchase, as a neutral
 *   `self`/`partner` key. Derived from the card last-4 via `cardholders.ts`, so
 *   no name ever reaches the DB or this (public) repo. Feeds §26.
 */
export async function loadCardRewardContext(): Promise<CardRewardContext> {
  await requireAuth()
  if (await isDemoSession()) {
    return { countryById: new Map(), giftCardLoadIds: new Set(), personById: new Map() }
  }

  const [countryRows, giftRows] = await Promise.all([
    db
      .select({ id: transactions.id, country: transactions.country, cardLast4: transactions.cardLast4 })
      .from(transactions),
    db
      .select({ transactionId: goalEntries.transactionId, amount: goalEntries.amount })
      .from(goalEntries)
      .innerJoin(goals, eq(goals.id, goalEntries.goalId))
      .where(and(eq(goals.kind, 'giftcard'), isNotNull(goalEntries.transactionId))),
  ])

  const giftCardLoadIds = new Set<number>()
  for (const r of giftRows) {
    // Positive entries are loads; gift-card spends carry their own manual txn
    // (which earns nothing, since no card is involved).
    if (r.transactionId != null && Number(r.amount) > 0) giftCardLoadIds.add(r.transactionId)
  }

  return {
    countryById: new Map(countryRows.map((r) => [r.id, r.country])),
    personById: new Map(countryRows.map((r) => [r.id, cardholderKey(r.cardLast4)])),
    giftCardLoadIds,
  }
}
