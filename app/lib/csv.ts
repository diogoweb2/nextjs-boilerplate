import { createHash } from 'crypto'
import { fixMojibake, isPaymentDescription, stripTrailingLocation } from '@/app/lib/normalize'

export type CardSource = 'master' | 'amex'

/** A normalized row ready to become a transaction (merchant resolved later). */
export type ParsedRow = {
  source: CardSource
  externalId: string
  txnDate: string // YYYY-MM-DD
  postedDate: string | null
  rawDescription: string
  amount: number // positive = expense, negative = refund/payment
  rawCategory: string | null
  cardLast4: string | null
  country: string | null
  isPayment: boolean
}

export type ParseResult = {
  source: CardSource
  rows: ParsedRow[]
}

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields containing commas,
 * escaped quotes (""), and CRLF/LF line endings. Returns rows of string cells.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  // Strip a BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c === '\r') {
      // ignore; newline handled on \n
    } else {
      field += c
    }
  }
  // Flush last field/row if the file didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

/** Inspect the header row to decide which card export this is. */
export function detectSource(header: string[]): CardSource | null {
  const h = header.map((c) => c.trim().toLowerCase())
  if (h.includes('merchant category description') || h.includes('reference number')) {
    return 'master'
  }
  if (h.includes('card member') || h.includes('account #')) {
    return 'amex'
  }
  return null
}

/** "$1,234.56" / "-$3,500.00" / "9.03" -> number. */
function parseAmount(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : 0
}

const MONTH_INDEX: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
}

/** Amex date "10 Jun 2026" -> "2026-06-10". Master dates are already ISO. */
function parseDate(raw: string): string | null {
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})$/)
  if (m) {
    const day = m[1].padStart(2, '0')
    const mon = MONTH_INDEX[m[2].toLowerCase()]
    if (mon) return `${m[3]}-${mon}-${day}`
  }
  return null
}

function lastDigits(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  return digits ? digits.slice(-4) : null
}

function colIndex(header: string[], name: string): number {
  return header.findIndex((c) => c.trim().toLowerCase() === name.toLowerCase())
}

function parseMaster(rows: string[][]): ParsedRow[] {
  const header = rows[0]
  const idx = {
    date: colIndex(header, 'Date'),
    posted: colIndex(header, 'Posted Date'),
    ref: colIndex(header, 'Reference Number'),
    card: colIndex(header, 'Card Number'),
    category: colIndex(header, 'Merchant Category Description'),
    merchant: colIndex(header, 'Merchant Name'),
    country: colIndex(header, 'Merchant Country Code'),
    amount: colIndex(header, 'Amount'),
  }
  const out: ParsedRow[] = []
  for (const r of rows.slice(1)) {
    const merchant = fixMojibake(r[idx.merchant] ?? '')
    const txnDate = parseDate(r[idx.date] ?? '')
    if (!txnDate || !merchant) continue
    const ref = (r[idx.ref] ?? '').trim()
    const amount = parseAmount(r[idx.amount] ?? '0')
    out.push({
      source: 'master',
      externalId: ref ? `master:${ref}` : `master:${hashRow(['master', txnDate, merchant, String(amount)])}`,
      txnDate,
      postedDate: parseDate(r[idx.posted] ?? '') ?? null,
      rawDescription: merchant,
      amount,
      rawCategory: fixMojibake(r[idx.category] ?? '') || null,
      cardLast4: lastDigits(r[idx.card] ?? ''),
      country: (r[idx.country] ?? '').trim() || null,
      isPayment: isPaymentDescription(merchant) || (amount < 0 && !(r[idx.category] ?? '').trim()),
    })
  }
  return out
}

function parseAmex(rows: string[][]): ParsedRow[] {
  const header = rows[0]
  const idx = {
    date: colIndex(header, 'Date'),
    processed: colIndex(header, 'Date Processed'),
    description: colIndex(header, 'Description'),
    account: colIndex(header, 'Account #'),
    amount: colIndex(header, 'Amount'),
  }
  const out: ParsedRow[] = []
  for (const r of rows.slice(1)) {
    const rawDesc = r[idx.description] ?? ''
    // Strip trailing city/phone on the raw (2+ space split) before normalizing.
    const merchant = fixMojibake(stripTrailingLocation(rawDesc))
    const fullDesc = fixMojibake(rawDesc)
    const txnDate = parseDate(r[idx.date] ?? '')
    if (!txnDate || !merchant) continue
    const amount = parseAmount(r[idx.amount] ?? '0')
    const account = (r[idx.account] ?? '').trim()
    out.push({
      source: 'amex',
      externalId: `amex:${hashRow(['amex', txnDate, fullDesc, String(amount), account])}`,
      txnDate,
      postedDate: parseDate(r[idx.processed] ?? '') ?? null,
      rawDescription: merchant,
      amount,
      rawCategory: null,
      cardLast4: lastDigits(account),
      country: null,
      isPayment: isPaymentDescription(fullDesc),
    })
  }
  return out
}

function hashRow(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)
}

/** Parse a full CSV file, auto-detecting the card source. */
export function parseStatement(text: string, expected?: CardSource): ParseResult {
  const rows = parseCsv(text)
  if (rows.length < 2) throw new Error('The file has no data rows.')
  const source = detectSource(rows[0])
  if (!source) {
    throw new Error('Could not recognize this CSV. Expected a Master or Amex export.')
  }
  if (expected && expected !== source) {
    throw new Error(
      `This looks like a ${source.toUpperCase()} file, but it was uploaded as ${expected.toUpperCase()}.`
    )
  }
  const parsed = source === 'master' ? parseMaster(rows) : parseAmex(rows)
  return { source, rows: parsed }
}
