import type { NextRequest } from 'next/server'
import { desc, eq, ilike, or, sql, and } from 'drizzle-orm'
import { db } from '@/db'
import { categories, goals, merchants, projects, transactions } from '@/db/schema'
import { isDemoSession } from '@/app/lib/demo'
import type { SearchResult } from '@/app/lib/search-index'

/**
 * Global-search data endpoint. Feature results are matched client-side from
 * FEATURE_INDEX; this route answers the database half — merchants, categories,
 * projects, goals and transactions — for the autocomplete dropdown
 * (app/components/GlobalSearch.tsx). Session-cookie authed via proxy.ts.
 *
 * A numeric-looking query ("84", "84.99", "$1,100") also matches transactions
 * by absolute amount, so "what was that $84 charge?" works.
 */
export const dynamic = 'force-dynamic'

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (m) => `\\${m}`)
}

export async function GET(request: NextRequest): Promise<Response> {
  const q = (request.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 80)
  if (q.length < 2) return Response.json({ results: [] })

  // Demo sessions browse synthetic data only — never search the real database.
  if (await isDemoSession()) return Response.json({ results: [] })

  const pattern = `%${escapeLike(q)}%`
  const asAmount = Number(q.replace(/[$,\s]/g, ''))
  const amountQuery = Number.isFinite(asAmount) && asAmount !== 0 ? Math.abs(asAmount) : null

  const [merchantRows, categoryRows, projectRows, goalRows, txnRows] = await Promise.all([
    db
      .select({ id: merchants.id, name: merchants.name, categoryName: categories.name })
      .from(merchants)
      .leftJoin(categories, eq(merchants.categoryId, categories.id))
      .where(ilike(merchants.name, pattern))
      .orderBy(merchants.name)
      .limit(6),
    db
      .select({ name: categories.name })
      .from(categories)
      .where(ilike(categories.name, pattern))
      .orderBy(categories.name)
      .limit(4),
    db
      .select({ id: projects.id, name: projects.name, emoji: projects.emoji })
      .from(projects)
      .where(and(ilike(projects.name, pattern), eq(projects.archived, false)))
      .orderBy(projects.name)
      .limit(4),
    db
      .select({ name: goals.name, emoji: goals.emoji })
      .from(goals)
      .where(and(ilike(goals.name, pattern), eq(goals.archived, false)))
      .orderBy(goals.name)
      .limit(4),
    db
      .select({
        txnDate: transactions.txnDate,
        rawDescription: transactions.rawDescription,
        note: transactions.note,
        amount: transactions.amount,
        merchantName: merchants.name,
      })
      .from(transactions)
      .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
      .where(
        or(
          ilike(transactions.rawDescription, pattern),
          ilike(transactions.note, pattern),
          ilike(merchants.name, pattern),
          ...(amountQuery != null
            ? [sql`abs(${transactions.amount}) = ${amountQuery.toFixed(2)}::numeric`]
            : [])
        )
      )
      .orderBy(desc(transactions.txnDate))
      .limit(8),
  ])

  const results: SearchResult[] = [
    ...merchantRows.map((m) => ({
      tag: 'merchant' as const,
      label: m.name,
      sublabel: m.categoryName ?? 'Uncategorized',
      href: `/transactions?month=all&q=${encodeURIComponent(m.name)}`,
    })),
    ...categoryRows.map((c) => ({
      tag: 'category' as const,
      label: c.name,
      sublabel: 'Category report',
      href: `/category?name=${encodeURIComponent(c.name)}`,
    })),
    ...projectRows.map((p) => ({
      tag: 'project' as const,
      label: `${p.emoji} ${p.name}`,
      sublabel: 'Project',
      href: `/projects/${p.id}`,
    })),
    ...goalRows.map((g) => ({
      tag: 'goal' as const,
      label: `${g.emoji} ${g.name}`,
      sublabel: 'Goal',
      href: '/accounts',
    })),
    ...txnRows.map((t) => ({
      tag: 'transaction' as const,
      label: `${t.merchantName} · $${Math.abs(Number(t.amount)).toFixed(2)}`,
      sublabel: `${t.txnDate} · ${t.note || t.rawDescription}`,
      href: `/transactions?month=${t.txnDate.slice(0, 7)}&q=${encodeURIComponent(t.rawDescription)}`,
    })),
  ]

  return Response.json({ results })
}
