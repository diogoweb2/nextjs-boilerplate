/**
 * Merchant-name cleanup review — proposes human-readable names for the bank's
 * shouty statement labels ("MECP ARROWHEAD PPARK" -> "Arrowhead Park Parking").
 *
 * Uses `claude -p` (the CLI subscription, not the OpenRouter key) with WebSearch,
 * so an unfamiliar acronym can actually be looked up instead of guessed.
 *
 *   npm run merchants:names                 # review every merchant (dry run)
 *   npm run merchants:names -- --days=45    # only merchants first seen in the last 45 days
 *   npm run merchants:names -- --limit=20   # cheap smoke test
 *   npm run merchants:names -- --apply      # write the reviewed .md file's renames to the DB
 *
 * Without --apply this is a DRY RUN: it writes .scratch/merchant-renames.md
 * (old -> new) and touches nothing in the database. Applying is a separate,
 * deliberate step, and it only ever renames rows still listed in that file — so
 * deleting a table row from the .md is how you reject a proposal.
 *
 * Why a rename is enough for future imports: `merchant_rules.exact_key` maps the
 * normalized statement key to the merchant *row*, and the display name is just
 * `merchants.name` (§3). Renaming the row therefore re-labels every past AND
 * future transaction with that key — no rule edit, no re-import needed.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { merchants, merchantNameRuns } from '../db/schema'

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.scratch', 'merchant-renames.md')
/** Merchants per `claude -p` call — small enough that one bad batch is cheap to redo. */
const BATCH = 40

type MerchantRow = {
  id: number
  name: string
  txns: number
  category: string
  samples: string[]
}

type Proposal = { id: number; newName: string; why: string }

function arg(flag: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`))
  return hit ? hit.slice(flag.length + 3) : null
}

async function loadMerchants(): Promise<MerchantRow[]> {
  const days = arg('days') ? Number(arg('days')) : null
  const limit = arg('limit') ? Number(arg('limit')) : null
  // Raw statement lines are the real evidence for what a merchant is — the model
  // needs them, not just the already-prettified name.
  const rows = await db.execute(sql`
    select m.id,
           m.name,
           coalesce(c.name, 'Uncategorized') as category,
           count(t.id)::int as txns,
           (array_agg(distinct t.raw_description))[1:3] as samples
      from merchants m
      left join transactions t on t.merchant_id = m.id
      left join categories c on c.id = m.category_id
     ${days ? sql`where m.created_at > now() - ${`${days} days`}::interval` : sql``}
     group by m.id, m.name, c.name
     order by count(t.id) desc
     ${limit ? sql`limit ${limit}` : sql``}
  `)
  return (rows.rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    txns: Number(r.txns),
    category: String(r.category),
    samples: ((r.samples as string[]) ?? []).filter(Boolean).slice(0, 3),
  }))
}

function prompt(batch: MerchantRow[]): string {
  const list = batch
    .map(
      (m) =>
        `${m.id} | name: ${m.name} | category: ${m.category} | ${m.txns} txns | raw: ${
          m.samples.join(' ~ ') || '(none)'
        }`
    )
    .join('\n')

  return `These are merchant records from a Canadian family's budgeting app (Ontario). Each line is:
id | name | category | transaction count | raw statement lines

${list}

For each merchant, decide whether the stored NAME should be improved into what a person would actually call this place. Improve when the name is bank noise: truncations ("PPARK", "MECP"), missing spaces, ALLCAPS gibberish, processor prefixes (SQ*, TST*, PAYPAL*), city/store codes, or a brand written unrecognizably. Use WebSearch when an acronym or local name is unclear (these are mostly Ontario, Canada businesses) — do not guess wildly.

Rules for the new name:
- Title Case, human, specific: "Arrowhead Park Parking", "Uniqlo Union Station", "GoodLife Fitness".
- Keep the brand's real spelling; keep a location only when it distinguishes ("Metro Bloor St").
- Never invent a business that the raw text doesn't support. If unsure, leave it alone.
- Do NOT include store numbers, card processor prefixes, provinces, or postal codes.
- Leave generic bank labels alone: E-Transfer Out, Bank Withdrawal, Cheque Withdrawal, Payment, Interest, and similar.

Return ONLY a JSON array, one object per merchant you would CHANGE (omit the ones you'd leave as-is):
[{"id": 123, "newName": "Arrowhead Park Parking", "why": "MECP = Muskoka; PPARK = park parking"}]
"why" is at most 12 words. No markdown fences, no commentary.`
}

function runClaude(batch: MerchantRow[]): Proposal[] {
  const res = spawnSync(
    'claude',
    [
      '-p',
      prompt(batch),
      '--model',
      'sonnet',
      '--output-format',
      'json',
      '--allowedTools',
      'WebSearch',
      '--permission-mode',
      'bypassPermissions',
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 32, timeout: 15 * 60 * 1000 }
  )
  if (res.status !== 0) throw new Error(`claude -p failed (exit ${res.status}): ${res.stderr}`)
  const outer = JSON.parse(res.stdout)
  if (outer.is_error) throw new Error(`claude -p returned an error: ${outer.result}`)

  const raw = String(outer.result)
  const a = raw.indexOf('[')
  const b = raw.lastIndexOf(']')
  if (a === -1 || b === -1 || b < a) throw new Error(`No JSON array in output: ${raw.slice(0, 200)}`)
  const parsed = JSON.parse(raw.slice(a, b + 1))
  if (!Array.isArray(parsed)) throw new Error('Parsed JSON was not an array')

  const known = new Map(batch.map((m) => [m.id, m]))
  const out: Proposal[] = []
  for (const p of parsed as Proposal[]) {
    const m = known.get(Number(p.id))
    const newName = typeof p.newName === 'string' ? p.newName.trim() : ''
    // Drop hallucinated ids and no-op renames rather than showing them as changes.
    if (!m || !newName || newName === m.name) continue
    out.push({ id: m.id, newName, why: typeof p.why === 'string' ? p.why.slice(0, 80) : '' })
  }
  return out
}

function markdown(all: MerchantRow[], proposals: Proposal[]): string {
  const byId = new Map(all.map((m) => [m.id, m]))
  const lines: string[] = []
  lines.push('# Merchant rename — dry run')
  lines.push('')
  lines.push(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · reviewed ${all.length} merchants · ${proposals.length} proposed changes.`)
  lines.push('')
  lines.push('**Nothing has been written to the database.** Review the table, delete any row you')
  lines.push('disagree with, then run the apply step on what is left.')
  lines.push('')
  lines.push('| id | old name | → | new name | txns | why | raw statement line |')
  lines.push('|---:|---|---|---|---:|---|---|')
  for (const p of proposals.sort((x, y) => (byId.get(y.id)!.txns - byId.get(x.id)!.txns))) {
    const m = byId.get(p.id)!
    const raw = (m.samples[0] ?? '').replace(/\|/g, '/')
    lines.push(`| ${m.id} | ${m.name} | → | **${p.newName}** | ${m.txns} | ${p.why} | \`${raw}\` |`)
  }
  lines.push('')
  const unchanged = all.filter((m) => !proposals.some((p) => p.id === m.id))
  lines.push(`## Left alone (${unchanged.length})`)
  lines.push('')
  lines.push(unchanged.map((m) => m.name).join(' · '))
  lines.push('')
  return lines.join('\n')
}

/**
 * Re-read the report the owner just edited and apply what survived. A row is
 * skipped when the merchant's current name no longer matches the "old name"
 * column — the report is stale, and silently overwriting a newer name (yours or
 * a later run's) would be worse than doing nothing. That also makes a second
 * --apply of the same file a no-op instead of a surprise.
 */
async function apply() {
  const rows = readFileSync(OUT, 'utf8')
    .split('\n')
    .map((line) => /^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*→\s*\|\s*\*\*(.+?)\*\*\s*\|/.exec(line))
    .flatMap((m) => (m ? [{ id: Number(m[1]), oldName: m[2], newName: m[3] }] : []))

  if (rows.length === 0) {
    console.log(`No rename rows found in ${path.relative(ROOT, OUT)} — nothing to apply.`)
    return
  }

  const current = await db.select({ id: merchants.id, name: merchants.name }).from(merchants)
  const nameById = new Map(current.map((m) => [m.id, m.name]))

  let applied = 0
  const skipped: string[] = []
  for (const r of rows) {
    const now = nameById.get(r.id)
    if (now === undefined) {
      skipped.push(`#${r.id} (${r.oldName}) — merchant no longer exists`)
      continue
    }
    if (now !== r.oldName) {
      skipped.push(`#${r.id} — is now "${now}", report said "${r.oldName}"`)
      continue
    }
    await db.update(merchants).set({ name: r.newName }).where(eq(merchants.id, r.id))
    console.log(`  ${r.oldName} → ${r.newName}`)
    applied++
  }

  // Stamp the same watermark the in-app batch button reads, so the two flows share
  // one "already reviewed up to here" line instead of re-reviewing each other's work.
  await db.insert(merchantNameRuns).values({ source: 'cli', reviewed: rows.length, renamed: applied })

  console.log(`\n${applied} renamed, ${skipped.length} skipped.`)
  for (const s of skipped) console.log(`  skipped: ${s}`)
  console.log('Past and future transactions follow the new name automatically (merchant_rules §3).')
}

async function review() {
  const merchants = await loadMerchants()
  console.log(`Reviewing ${merchants.length} merchants in batches of ${BATCH}…`)

  const proposals: Proposal[] = []
  for (let i = 0; i < merchants.length; i += BATCH) {
    const batch = merchants.slice(i, i + BATCH)
    process.stdout.write(`  batch ${i / BATCH + 1}/${Math.ceil(merchants.length / BATCH)}… `)
    const got = runClaude(batch)
    proposals.push(...got)
    console.log(`${got.length} proposed`)
  }

  mkdirSync(path.dirname(OUT), { recursive: true })
  writeFileSync(OUT, markdown(merchants, proposals))
  console.log(`\n${proposals.length} proposed renames → ${path.relative(ROOT, OUT)}`)
  console.log('Dry run only — no database writes.')
}

const main = process.argv.includes('--apply') ? apply : review

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
