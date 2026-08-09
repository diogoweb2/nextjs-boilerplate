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
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
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
  aiFeedback: string | null
}

function extractionPrompt(filename: string): string {
  return `Read the PDF file at "Brasil/aparecida/${filename}" using the Read tool. It is a Brazilian credit card statement (fatura) in Portuguese, belonging to someone's elderly stepmother who lives in Recife, Brazil.

Extract every purchase/transaction line item (skip the payment/pagamento line and any statement summary/total lines). For each item return:
- date: ISO YYYY-MM-DD (use the year printed on the statement; infer month/day from the transaction line)
- description: the raw merchant text as printed
- amount: positive number, in BRL, the transaction's own value (not adjusted for anything)
- installment: if the line shows an installment count like "03/10", return it as "3/10"; otherwise null
- category: pick exactly one from this fixed list based on the merchant: ${APARECIDA_CATEGORIES.join(', ')}. Use "Outros" only when nothing else plausibly fits.
- aiFeedback: use WebSearch to look up the merchant name (cleaned of card-machine noise, e.g. "MERCPAGO*ACOUGUEDOZ" -> search "Açougue Doz"). Write ONE short sentence in Portuguese saying what kind of business it is and, if you can tell, whether it looks like a normal/legitimate establishment (a supermarket, pharmacy, restaurant, etc. in or near Recife) or something worth a second look. If the search turns up nothing useful, say so plainly ("Não encontrei informações sobre este estabelecimento") instead of guessing. Being in Olinda or elsewhere in the Grande Recife metro area is normal for her and NOT a reason for suspicion — only call something out if it's a genuinely unfamiliar or dubious business. Keep it under 200 characters. Do this for every line item, but merchants you've already searched earlier in this same statement can reuse the same note instead of searching again.

Output ONLY a JSON array of objects with those six keys — no markdown fences, no commentary, no trailing text.`
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
      'Read,WebSearch',
      '--permission-mode',
      'bypassPermissions',
    ],
    {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 32,
      timeout: 10 * 60 * 1000,
    }
  )

  if (result.status !== 0) {
    throw new Error(`claude -p failed for ${filename} (exit ${result.status}): ${result.stderr}`)
  }

  const outer = JSON.parse(result.stdout)
  if (outer.is_error) {
    throw new Error(`claude -p returned an error for ${filename}: ${outer.result}`)
  }

  return extractJsonArray(String(outer.result)) as ExtractedTxn[]
}

/** Model output sometimes wraps the array in fences or trails commentary after it — pull out just the array. */
function extractJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim()
  const fenced = trimmed.startsWith('```') ? trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '') : trimmed
  const start = fenced.indexOf('[')
  const end = fenced.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON array found in model output: ${fenced.slice(0, 200)}`)
  }
  const parsed = JSON.parse(fenced.slice(start, end + 1))
  if (!Array.isArray(parsed)) throw new Error('Parsed JSON was not an array')
  return parsed
}

function externalId(filename: string, t: ExtractedTxn): string {
  return createHash('sha1').update(`${filename}|${t.date}|${t.description}|${t.amount}`).digest('hex')
}

function backfillFeedbackPrompt(descriptions: string[]): string {
  return `These are raw merchant description lines from a Brazilian credit card statement (fatura), belonging to someone's elderly stepmother who lives in Recife, Brazil:

${descriptions.map((d) => `- ${d}`).join('\n')}

For each one, use WebSearch to look up the merchant name (cleaned of card-machine noise, e.g. "MERCPAGO*ACOUGUEDOZ" -> search "Açougue Doz"). Write ONE short sentence in Portuguese saying what kind of business it is and, if you can tell, whether it looks like a normal/legitimate establishment (a supermarket, pharmacy, restaurant, etc. in or near Recife) or something worth a second look. If the search turns up nothing useful, say so plainly ("Não encontrei informações sobre este estabelecimento") instead of guessing. Being in Olinda or elsewhere in the Grande Recife metro area is normal for her and NOT a reason for suspicion — only call something out if it's a genuinely unfamiliar or dubious business. Keep each note under 200 characters.

Output ONLY a JSON array of objects with keys "description" (the exact original line above) and "aiFeedback" — no markdown fences, no commentary, no trailing text.`
}

function runClaudeFeedbackBackfill(descriptions: string[]): { description: string; aiFeedback: string }[] {
  const result = spawnSync(
    'claude',
    [
      '-p',
      backfillFeedbackPrompt(descriptions),
      '--model',
      'sonnet',
      '--effort',
      'low',
      '--output-format',
      'json',
      '--allowedTools',
      'WebSearch',
      '--permission-mode',
      'bypassPermissions',
    ],
    {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 32,
      timeout: 10 * 60 * 1000,
    }
  )

  if (result.status !== 0) {
    throw new Error(`claude -p feedback backfill failed (exit ${result.status}): ${result.stderr}`)
  }
  const outer = JSON.parse(result.stdout)
  if (outer.is_error) {
    throw new Error(`claude -p returned an error for feedback backfill: ${outer.result}`)
  }
  return extractJsonArray(String(outer.result)) as { description: string; aiFeedback: string }[]
}

async function main() {
  const files = readdirSync(STATEMENTS_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'))
  if (files.length === 0) {
    console.log(`No PDFs found in ${STATEMENTS_DIR}`)
    return
  }

  const existingImports = await db
    .select({ filename: aparecidaImports.filename, pdfBase64: aparecidaImports.pdfBase64 })
    .from(aparecidaImports)
  const already = new Map(existingImports.map((r) => [r.filename, r]))

  for (const filename of files) {
    const pdfBase64 = readFileSync(path.join(STATEMENTS_DIR, filename)).toString('base64')
    const existing = already.get(filename)

    if (existing) {
      if (!existing.pdfBase64) {
        await db.update(aparecidaImports).set({ pdfBase64 }).where(eq(aparecidaImports.filename, filename))
        console.log(`  ✓ ${filename}: stored PDF for existing import`)
      }

      const missingFeedback = await db
        .select({ id: aparecidaTransactions.id, description: aparecidaTransactions.description })
        .from(aparecidaTransactions)
        .where(
          and(eq(aparecidaTransactions.statementFile, filename), isNull(aparecidaTransactions.aiFeedback))
        )
      if (missingFeedback.length > 0) {
        console.log(`→ backfilling AI feedback for ${missingFeedback.length} line items in ${filename}...`)
        const uniqueDescriptions = [...new Set(missingFeedback.map((r) => r.description))]
        const feedback = runClaudeFeedbackBackfill(uniqueDescriptions)
        const byDescription = new Map(feedback.map((f) => [f.description, f.aiFeedback]))
        for (const row of missingFeedback) {
          const aiFeedback = byDescription.get(row.description)
          if (aiFeedback) {
            await db.update(aparecidaTransactions).set({ aiFeedback }).where(eq(aparecidaTransactions.id, row.id))
          }
        }
        console.log(`  ✓ ${filename}: AI feedback backfilled`)
      } else {
        console.log(`- skip (already imported): ${filename}`)
      }
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
          aiFeedback: t.aiFeedback ?? null,
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
      .values({ filename, transactionCount: inserted, totalAmount: String(total), pdfBase64 })
      .onConflictDoUpdate({
        target: aparecidaImports.filename,
        set: { transactionCount: inserted, totalAmount: String(total), pdfBase64 },
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
