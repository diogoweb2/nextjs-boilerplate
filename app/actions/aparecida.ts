'use server'

import { desc } from 'drizzle-orm'
import { db } from '@/db'
import { aparecidaTransactions, aparecidaImports } from '@/db/schema'
import type { AparecidaTransaction, AparecidaImport } from '@/db/schema'

export type AparecidaData = {
  transactions: AparecidaTransaction[]
  imports: AparecidaImport[]
}

export async function loadAparecidaData(): Promise<AparecidaData> {
  const [transactions, imports] = await Promise.all([
    db.select().from(aparecidaTransactions).orderBy(desc(aparecidaTransactions.txnDate)),
    db.select().from(aparecidaImports).orderBy(desc(aparecidaImports.importedAt)),
  ])
  return { transactions, imports }
}
