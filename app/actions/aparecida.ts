'use server'

import { desc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
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

/** Owner override for a single row: "não é suspeito" — clears its anomaly flags everywhere. */
export async function setAparecidaNotSuspicious(id: number, notSuspicious: boolean): Promise<void> {
  await db.update(aparecidaTransactions).set({ notSuspicious }).where(eq(aparecidaTransactions.id, id))
  revalidatePath('/aparecida')
}
