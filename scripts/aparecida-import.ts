/**
 * Processes new "Aparecida" credit card statement PDFs (Brasil/aparecida/*.pdf)
 * with `claude -p` (sonnet, low effort) and inserts the extracted line items.
 * Fully isolated from the rest of the app — see db/schema.ts
 * (aparecidaTransactions/aparecidaImports) and app/lib/aparecida.ts.
 *
 * Idempotent: skips any filename already recorded in aparecida_imports.
 *
 *   npm run aparecida:import
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { db } from '../db'
import { aparecidaTransactions, aparecidaImports } from '../db/schema'
import { APARECIDA_CATEGORIES } from '../app/lib/aparecida'

const STATEMENTS_DIR = path.join(__dirname, '..', 'Brasil', 'aparecida')

type ExtractedTxn = {
  date: string
  description: string
  amount: number
  installment: string | null
  category: string
}

function extractionPrompt(filename: string): string {
  return `Read the PDF file at "Brasil/aparecida/${filename}" using the Read tool. It is a Brazilian credit card statement (fatura) in Portuguese, belonging to someone's elderly stepmother.

Extract every purchase/transaction line item (skip the payment/pagamento line and any statement summary/total lines). For each item return:
- date: ISO YYYY-MM-DD (use the year printed on the statement; infer month/day from the transaction line)
- description: the raw merchant text as printed
- amount: positive number, in BRL, the transaction's own value (not adjusted for anything)
- installment: if the line shows an installment count like "03/10", return it as "3/10"; otherwise null
- category: pick exactly one from this fixed list based on the merchant: ${APARECIDA_CATEGORIES.join(', ')}. Use "Outros" only when nothing else plausibly fits.

Output ONLY a JSON array of objects with those five keys — no markdown fences, no commentary, no trailing text.`
}

function runClaudeExtraction(filename: string): ExtractedTxn[] {
  const result = spawnSync(
    'claude',
    [
      '-p',
      extractionPrompt(filename),
      '--model',
      'sonnet',
      '--effort',
      'low',
      '--output-format',
      'json',
      '--allowedTools',
      'Read',
      '--permission-mode',
      'bypassPermissions',
    ],
    {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 32,
    }
  )

  if (result.status !== 0) {
    throw new Error(`claude -p failed for ${filename} (exit ${result.status}): ${result.stderr}`)
  }

  const outer = JSON.parse(result.stdout)
  if (outer.is_error) {
    throw new Error(`claude -p returned an error for ${filename}: ${outer.result}`)
  }

  const raw = String(outer.result).trim()
  const jsonText = raw.startsWith('```')
    ? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    : raw

  const parsed = JSON.parse(jsonText)
  if (!Array.isArray(parsed)) {
    throw new Error(`claude -p did not return a JSON array for ${filename}`)
  }
  return parsed
}

function externalId(filename: string, t: ExtractedTxn): string {
  return createHash('sha1').update(`${filename}|${t.date}|${t.description}|${t.amount}`).digest('hex')
}

async function main() {
  const files = readdirSync(STATEMENTS_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'))
  if (files.length === 0) {
    console.log(`No PDFs found in ${STATEMENTS_DIR}`)
    return
  }

  const already = new Set(
    (await db.select({ filename: aparecidaImports.filename }).from(aparecidaImports)).map((r) => r.filename)
  )

  for (const filename of files) {
    if (already.has(filename)) {
      console.log(`- skip (already imported): ${filename}`)
      continue
    }

    console.log(`→ extracting ${filename}...`)
    const txns = runClaudeExtraction(filename)
    console.log(`  ${txns.length} line items extracted`)

    let inserted = 0
    let total = 0
    for (const t of txns) {
      const category = APARECIDA_CATEGORIES.includes(t.category as (typeof APARECIDA_CATEGORIES)[number])
        ? t.category
        : 'Outros'
      const [row] = await db
        .insert(aparecidaTransactions)
        .values({
          txnDate: t.date,
          description: t.description,
          category,
          amount: String(t.amount),
          installment: t.installment,
          statementFile: filename,
          externalId: externalId(filename, t),
        })
        .onConflictDoNothing({ target: aparecidaTransactions.externalId })
        .returning({ id: aparecidaTransactions.id })
      if (row) {
        inserted++
        total += t.amount
      }
    }

    await db
      .insert(aparecidaImports)
      .values({ filename, transactionCount: inserted, totalAmount: String(total) })
      .onConflictDoUpdate({
        target: aparecidaImports.filename,
        set: { transactionCount: inserted, totalAmount: String(total) },
      })

    console.log(`  ✓ ${filename}: ${inserted} inserted, total R$ ${total.toFixed(2)}`)
  }
}

main()
  .then(() => {
    console.log('done')
    process.exit(0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
