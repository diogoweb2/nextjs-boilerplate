import { db } from '@/db'
import { transactions } from '@/db/schema'
import { sql } from 'drizzle-orm'

export default async function Home() {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-900">
      <div className="text-center">
        <h1 className="text-3xl font-semibold text-zinc-900 dark:text-zinc-50">
          Budget
        </h1>
        <p className="mt-2 text-zinc-500 dark:text-zinc-400">
          {count} transaction{count !== 1 ? 's' : ''} in the database
        </p>
      </div>
    </div>
  )
}
