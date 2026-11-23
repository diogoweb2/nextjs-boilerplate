import { neon } from '@neondatabase/serverless'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import { getPersonNames } from '@/app/lib/cardholders'

/**
 * Read-only tools exposed to Claude through the MCP connector (BUSINESS_RULES §28).
 *
 * Every number is computed deterministically in SQL with the same semantics as
 * the app's analytics (§1, §4, §6): positive = money out, effective category =
 * txn override ?? merchant default, card payments (`is_payment`) never count as
 * spend, transfers are excluded unless asked for, and split children already sum
 * to the original so nothing double-counts. Nothing here writes to the DB.
 */

type Json = Record<string, unknown>
export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean; structuredContent?: Json }

const SOURCES = ['master', 'amex', 'tangerine', 'scotia', 'manual'] as const
const CARD_SOURCES = ['master', 'amex']
const FLOWS = ['expense', 'income', 'transfer'] as const
const GROUPS = ['category', 'merchant', 'month', 'year', 'source', 'cardholder', 'flow'] as const
type Group = (typeof GROUPS)[number]

const SERVER_INSTRUCTIONS = `Family budget data (Canada, CAD) for one household.
Conventions:
- amount sign: POSITIVE = money out (spend, bill, payment), NEGATIVE = money in (income, refund, card payment received).
- sources: master = Rogers Mastercard (credit card), amex = American Express (credit card), tangerine and scotia = chequing bank accounts, manual = app-generated goal ledger rows.
- flow: expense (all spending incl. mortgage/bills/investment contributions), income (deposits), transfer (inter-account moves and bank->card payments; excluded from spend so card purchases are not double counted).
- Card payments: the card side shows is_payment=true ("PAYMENT THANK YOU"); the bank side shows a transfer-flow "Bill Payment - ROGERS BANK MASTE..." / "AMERICAN EXPRESS" row. Neither counts as spend.
- "Spending" means flow=expense, net of refunds. summarize_spending already applies this.
- Bank e-transfers out appear as merchant "E-Transfer Out" with no payee name; identify them by amount/date/note.
- Cardholder (who paid) only exists for credit-card rows.
Start with get_budget_context to see data freshness, categories and balances; use search_transactions for "did I pay X" questions; summarize_spending for totals/trends; run_readonly_sql only when the other tools cannot answer.`

export { SERVER_INSTRUCTIONS }

// ---------------------------------------------------------------- helpers

const ok = (data: Json): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
})
const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: msg }], isError: true })

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const likeEscape = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
const inList = (expr: SQL, values: string[]) =>
  sql`${expr} IN (${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `
  )})`

async function rows<T = Json>(q: SQL): Promise<T[]> {
  const r = (await db.execute(q)) as unknown as { rows?: T[] } | T[]
  return Array.isArray(r) ? r : (r.rows ?? [])
}

const round2 = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100

function cardholderExpr(): SQL {
  const { selfName, partnerName, partnerCards } = getPersonNames()
  const isCard = inList(sql`t.source`, CARD_SOURCES)
  if (partnerCards.length === 0) return sql`CASE WHEN ${isCard} THEN ${selfName}::text END`
  return sql`CASE WHEN NOT ${isCard} THEN NULL WHEN ${inList(sql`t.card_last4`, partnerCards)} THEN ${partnerName}::text ELSE ${selfName}::text END`
}

const FROM = sql`FROM transactions t
  JOIN merchants m ON m.id = t.merchant_id
  LEFT JOIN categories c ON c.id = COALESCE(t.category_id, m.category_id)`
const CAT_NAME = sql`COALESCE(c.name, 'Uncategorized')`

type Filters = {
  date_from?: unknown
  date_to?: unknown
  text?: unknown
  merchant?: unknown
  categories?: unknown
  sources?: unknown
  flows?: unknown
  min_amount?: unknown
  max_amount?: unknown
  direction?: unknown
  cardholder?: unknown
  exclude_special?: unknown
  include_payments?: unknown
}

/** Shared WHERE builder. Returns an error string on bad input. */
function buildWhere(f: Filters, defaults: { flows: string[]; includePayments: boolean }): SQL[] | string {
  const w: SQL[] = []
  if (f.date_from !== undefined) {
    if (!isDate(f.date_from)) return 'date_from must be YYYY-MM-DD'
    w.push(sql`t.txn_date >= ${f.date_from}`)
  }
  if (f.date_to !== undefined) {
    if (!isDate(f.date_to)) return 'date_to must be YYYY-MM-DD'
    w.push(sql`t.txn_date <= ${f.date_to}`)
  }
  if (typeof f.text === 'string' && f.text.trim()) {
    const p = likeEscape(f.text.trim())
    w.push(sql`(t.raw_description ILIKE ${p} OR m.name ILIKE ${p} OR COALESCE(t.note, '') ILIKE ${p})`)
  }
  if (typeof f.merchant === 'string' && f.merchant.trim()) {
    w.push(sql`m.name ILIKE ${likeEscape(f.merchant.trim())}`)
  }
  const cats = strList(f.categories).map((c) => c.toLowerCase())
  if (cats.length) w.push(inList(sql`lower(${CAT_NAME})`, cats))

  const sources = strList(f.sources)
  const badSource = sources.find((s) => !(SOURCES as readonly string[]).includes(s))
  if (badSource) return `unknown source "${badSource}" (use ${SOURCES.join(', ')})`
  if (sources.length) w.push(inList(sql`t.source`, sources))

  const flows = f.flows === undefined ? defaults.flows : strList(f.flows)
  const badFlow = flows.find((s) => !(FLOWS as readonly string[]).includes(s))
  if (badFlow) return `unknown flow "${badFlow}" (use ${FLOWS.join(', ')})`
  if (flows.length && flows.length < FLOWS.length) w.push(inList(sql`t.flow`, flows))

  const min = num(f.min_amount)
  const max = num(f.max_amount)
  if (min !== null) w.push(sql`abs(t.amount) >= ${min}`)
  if (max !== null) w.push(sql`abs(t.amount) <= ${max}`)
  if (f.direction === 'out') w.push(sql`t.amount > 0`)
  else if (f.direction === 'in') w.push(sql`t.amount < 0`)

  if (f.cardholder === 'self' || f.cardholder === 'partner') {
    const { partnerCards } = getPersonNames()
    w.push(inList(sql`t.source`, CARD_SOURCES))
    const isPartner = partnerCards.length ? inList(sql`t.card_last4`, partnerCards) : sql`false`
    w.push(f.cardholder === 'partner' ? isPartner : sql`NOT COALESCE(${isPartner}, false)`)
  }
  if (f.exclude_special === true) w.push(sql`NOT COALESCE(t.is_special, m.default_special)`)

  const includePayments = typeof f.include_payments === 'boolean' ? f.include_payments : defaults.includePayments
  if (!includePayments) w.push(sql`NOT t.is_payment`)
  return w
}

const whereSql = (w: SQL[]) => (w.length ? sql`WHERE ${sql.join(w, sql` AND `)}` : sql``)

// ---------------------------------------------------------------- tools

async function getBudgetContext(): Promise<ToolResult> {
  const { selfName, partnerName } = getPersonNames()
  const [freshness, cats, balances, syncs] = await Promise.all([
    rows(sql`SELECT source, min(txn_date)::text AS first_txn, max(txn_date)::text AS last_txn, count(*)::int AS rows
             FROM transactions GROUP BY source ORDER BY source`),
    rows(sql`SELECT name, kind, bucket FROM categories ORDER BY kind, name`),
    rows(sql`SELECT source, balance::float AS balance, captured_at FROM live_balances ORDER BY source`),
    rows(sql`SELECT source, status, last_run_at, last_success_at FROM sync_runs ORDER BY source`),
  ])
  return ok({
    today: new Date().toISOString().slice(0, 10),
    currency: 'CAD',
    sources: {
      master: 'Rogers Mastercard (credit card)',
      amex: 'American Express (credit card)',
      tangerine: 'Tangerine chequing (bank)',
      scotia: 'Scotiabank chequing (bank)',
      manual: 'app-generated goal ledger rows',
    },
    data_freshness: freshness,
    last_sync_runs: syncs,
    live_balances: balances,
    cardholders: { self: selfName, partner: partnerName, note: 'only credit-card rows carry a cardholder' },
    categories: cats,
  })
}

async function searchTransactions(a: Json): Promise<ToolResult> {
  const w = buildWhere(a as Filters, { flows: [...FLOWS], includePayments: true })
  if (typeof w === 'string') return fail(w)
  const limit = Math.min(Math.max(Math.trunc(num(a.limit) ?? 100), 1), 500)
  const order =
    a.sort === 'date_asc'
      ? sql`t.txn_date ASC, t.id ASC`
      : a.sort === 'amount_desc'
        ? sql`t.amount DESC`
        : a.sort === 'amount_asc'
          ? sql`t.amount ASC`
          : sql`t.txn_date DESC, t.id DESC`
  const where = whereSql(w)
  const [list, [agg]] = await Promise.all([
    rows(sql`SELECT t.id, t.txn_date::text AS date, t.posted_date::text AS posted_date, t.source, t.flow,
               t.amount::float AS amount, m.name AS merchant, ${CAT_NAME} AS category,
               t.raw_description AS description, t.note, ${cardholderExpr()} AS cardholder,
               t.is_payment, COALESCE(t.is_recurring, m.default_recurring) AS is_recurring,
               COALESCE(t.is_special, m.default_special) AS is_special, t.split_parent_id AS split_of
             ${FROM} ${where} ORDER BY ${order} LIMIT ${limit}`),
    rows<{ n: number; total: number }>(sql`SELECT count(*)::int AS n, COALESCE(sum(t.amount), 0)::float AS total ${FROM} ${where}`),
  ])
  return ok({
    matched: agg?.n ?? 0,
    sum_amount: round2(agg?.total),
    returned: list.length,
    truncated: (agg?.n ?? 0) > list.length,
    transactions: list,
  })
}

const GROUP_EXPR: Record<Group, () => SQL> = {
  category: () => CAT_NAME,
  merchant: () => sql`m.name`,
  month: () => sql`to_char(t.txn_date, 'YYYY-MM')`,
  year: () => sql`to_char(t.txn_date, 'YYYY')`,
  source: () => sql`t.source::text`,
  cardholder: () => sql`COALESCE(${cardholderExpr()}, '(bank)')`,
  flow: () => sql`t.flow::text`,
}

async function summarizeSpending(a: Json): Promise<ToolResult> {
  const groupBy = strList(a.group_by) as Group[]
  if (groupBy.length === 0) groupBy.push('category')
  if (groupBy.length > 2) return fail('group_by takes at most 2 dimensions')
  const bad = groupBy.find((g) => !(GROUPS as readonly string[]).includes(g))
  if (bad) return fail(`unknown group_by "${bad}" (use ${GROUPS.join(', ')})`)

  // Card payments never count as spend or income (§1), regardless of input.
  const w = buildWhere({ ...(a as Filters), include_payments: false }, { flows: ['expense'], includePayments: false })
  if (typeof w === 'string') return fail(w)
  const limit = Math.min(Math.max(Math.trunc(num(a.limit) ?? 60), 1), 500)

  const keys = groupBy.map((g, i) => sql`${GROUP_EXPR[g]()} AS ${sql.raw(`g${i}`)}`)
  const groupCols = sql.raw(groupBy.map((_, i) => `g${i}`).join(', '))
  const chronological = groupBy[0] === 'month' || groupBy[0] === 'year'
  const order = chronological ? sql`g0 ASC, net DESC` : sql`net DESC`

  const where = whereSql(w)
  const [groups, [tot]] = await Promise.all([
    rows<Json>(sql`SELECT ${sql.join(keys, sql`, `)},
               COALESCE(sum(t.amount) FILTER (WHERE t.amount > 0), 0)::float AS gross,
               COALESCE(sum(t.amount) FILTER (WHERE t.amount < 0), 0)::float AS refunds,
               sum(t.amount)::float AS net,
               count(*) FILTER (WHERE t.amount > 0)::int AS purchases
             ${FROM} ${where} GROUP BY ${groupCols} ORDER BY ${order} LIMIT ${limit}`),
    rows<Json>(sql`SELECT COALESCE(sum(t.amount), 0)::float AS net,
               COALESCE(sum(t.amount) FILTER (WHERE t.amount > 0), 0)::float AS gross,
               count(*)::int AS rows, count(DISTINCT ${GROUP_EXPR[groupBy[0]]()})::int AS groups
             ${FROM} ${where}`),
  ])

  const out = groups.map((g) => {
    const row: Json = {}
    groupBy.forEach((name, i) => (row[name] = g[`g${i}`]))
    row.gross = round2(g.gross)
    row.refunds = round2(g.refunds)
    row.net = round2(g.net)
    row.purchases = g.purchases
    return row
  })

  // Category credits (§6): income filed under an expense-kind category (e.g. a
  // dental insurance reimbursement) nets against that category on the app's
  // tiles. Report it alongside so totals match the dashboard.
  const flows = a.flows === undefined ? ['expense'] : strList(a.flows)
  let creditsNote: string | undefined
  if (groupBy.length === 1 && groupBy[0] === 'category' && flows.length === 1 && flows[0] === 'expense') {
    const cw = buildWhere({ ...(a as Filters), flows: ['income'], include_payments: false }, { flows: ['income'], includePayments: false })
    if (typeof cw !== 'string') {
      const credits = await rows<{ category: string; credit: number }>(
        sql`SELECT ${CAT_NAME} AS category, (-sum(t.amount))::float AS credit ${FROM}
            ${whereSql([...cw, sql`c.kind = 'expense'`])} GROUP BY 1`
      )
      const byCat = new Map(credits.map((c) => [c.category, round2(c.credit)]))
      if (byCat.size) {
        for (const r of out) {
          const cr = byCat.get(r.category as string)
          if (cr) {
            r.credits = cr
            r.net_after_credits = round2(Math.max(0, (r.net as number) - cr))
          }
        }
        creditsNote = 'credits = reimbursements/goal money filed under that category; the app tiles show net_after_credits'
      }
    }
  }

  return ok({
    group_by: groupBy,
    flows,
    totals: { net: round2(tot?.net), gross: round2(tot?.gross), rows: tot?.rows ?? 0, groups: tot?.groups ?? 0 },
    truncated: Number(tot?.groups ?? 0) > out.length && groupBy.length === 1,
    note: creditsNote,
    groups: out,
  })
}

async function describeSchema(): Promise<ToolResult> {
  const cols = await rows<{ table_name: string; column_name: string; data_type: string }>(
    sql`SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
  )
  const tables: Record<string, string[]> = {}
  for (const c of cols) (tables[c.table_name] ??= []).push(`${c.column_name} ${c.data_type}`)
  return ok({
    notes: [
      'transactions.amount: positive = money out. Effective category = COALESCE(transactions.category_id, merchants.category_id).',
      'Spend = flow = \'expense\' AND NOT is_payment, summed signed (refunds net). Effective is_special = COALESCE(t.is_special, merchants.default_special).',
      'transactions.split_parent_id: a split child; the parent amount is already reduced, so summing all rows is correct.',
      'transactions.card_last4 identifies the card; cardholder names are not stored in the DB.',
      'live_balances: latest scraped balance per account. goals/goal_entries: savings goals. projects/project_transactions: trips and other grouped spend.',
    ],
    tables,
  })
}

const MAX_SQL_ROWS = 500

async function runReadonlySql(a: Json): Promise<ToolResult> {
  const raw = typeof a.query === 'string' ? a.query.trim().replace(/;\s*$/, '') : ''
  if (!raw) return fail('query is required')
  if (!/^(select|with)\b/i.test(raw)) return fail('only a single SELECT (or WITH … SELECT) statement is allowed')
  if (raw.includes(';')) return fail('only a single statement is allowed (remove the ";")')
  const client = neon(process.env.DATABASE_URL!)
  try {
    // Wrapping as a subquery forces one SELECT (data-modifying CTEs are illegal
    // in a subquery) and caps rows; the READ ONLY transaction is the real guard.
    const [, result] = await client.transaction(
      [
        client.query('SET LOCAL statement_timeout = 8000'),
        client.query(`SELECT * FROM (${raw}\n) AS _q LIMIT ${MAX_SQL_ROWS + 1}`),
      ],
      { readOnly: true }
    )
    const list = result as Json[]
    return ok({ rows: list.slice(0, MAX_SQL_ROWS), returned: Math.min(list.length, MAX_SQL_ROWS), truncated: list.length > MAX_SQL_ROWS })
  } catch (e) {
    return fail(`SQL error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ---------------------------------------------------------------- registry

const filterProps = {
  date_from: { type: 'string', description: 'Inclusive start date, YYYY-MM-DD (transaction date).' },
  date_to: { type: 'string', description: 'Inclusive end date, YYYY-MM-DD.' },
  text: { type: 'string', description: 'Case-insensitive substring over the raw bank description, merchant name and note.' },
  merchant: { type: 'string', description: 'Case-insensitive substring of the normalized merchant name (e.g. "costco").' },
  categories: { type: 'array', items: { type: 'string' }, description: 'Exact category names (see get_budget_context).' },
  sources: { type: 'array', items: { type: 'string', enum: [...SOURCES] } },
  min_amount: { type: 'number', description: 'Minimum absolute amount in CAD (sign ignored).' },
  max_amount: { type: 'number', description: 'Maximum absolute amount in CAD (sign ignored).' },
  direction: { type: 'string', enum: ['out', 'in', 'any'], description: 'out = amount > 0 (money out), in = amount < 0.' },
  cardholder: { type: 'string', enum: ['self', 'partner'], description: 'Who made the purchase. Limits results to credit-card rows.' },
  exclude_special: { type: 'boolean', description: 'Drop one-off/special purchases (flights, reimbursable medical) like the app toggle.' },
} as const

export const TOOLS = [
  {
    name: 'get_budget_context',
    description:
      'Overview needed before answering: today\'s date, the accounts (sources), how fresh each account\'s data is, latest account balances, cardholder names and the category list.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, title: 'Budget context' },
    run: () => getBudgetContext(),
  },
  {
    name: 'search_transactions',
    description:
      'Find individual transactions with filters. Use it for questions like "did I pay X this month", "show my Costco trips", "what was that $115 charge". Returns the matching rows plus the count and signed sum of everything matched. Includes all flows and card payments unless filtered.',
    inputSchema: {
      type: 'object',
      properties: {
        ...filterProps,
        flows: { type: 'array', items: { type: 'string', enum: [...FLOWS] }, description: 'Default: all flows.' },
        include_payments: { type: 'boolean', description: 'Include card-side "PAYMENT THANK YOU" rows. Default true.' },
        sort: { type: 'string', enum: ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'] },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 100.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, title: 'Search transactions' },
    run: (a: Json) => searchTransactions(a),
  },
  {
    name: 'summarize_spending',
    description:
      'Totals grouped by up to two dimensions (category, merchant, month, year, source, cardholder, flow) using the app\'s analytics rules: card payments always excluded, refunds net against spend. Default flows = ["expense"] (spending); pass ["income"] for income. Each group returns gross (purchases), refunds (negative), net, purchases (count).',
    inputSchema: {
      type: 'object',
      properties: {
        ...filterProps,
        group_by: {
          type: 'array',
          items: { type: 'string', enum: [...GROUPS] },
          maxItems: 2,
          description: 'e.g. ["category"], ["month"], ["month","category"]. Default ["category"].',
        },
        flows: { type: 'array', items: { type: 'string', enum: [...FLOWS] }, description: 'Default ["expense"].' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max groups returned. Default 60.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, title: 'Summarize spending' },
    run: (a: Json) => summarizeSpending(a),
  },
  {
    name: 'describe_schema',
    description: 'Database tables, columns and the key semantics. Call before writing SQL for run_readonly_sql.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, title: 'Describe schema' },
    run: () => describeSchema(),
  },
  {
    name: 'run_readonly_sql',
    description:
      'Escape hatch: run ONE read-only PostgreSQL SELECT (or WITH … SELECT) against the budget database, for questions the other tools cannot answer (goals, projects, investments, unusual joins). Runs in a READ ONLY transaction with an 8s timeout; at most 500 rows. Apply the conventions from describe_schema.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A single SELECT statement, no trailing semicolon needed.' } },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, title: 'Read-only SQL' },
    run: (a: Json) => runReadonlySql(a),
  },
] as const

export async function callTool(name: string, args: Json): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return fail(`unknown tool "${name}"`)
  try {
    return await tool.run(args)
  } catch (e) {
    console.error('[mcp] tool failed', name, e)
    return fail(`tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
