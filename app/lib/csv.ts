import { createHash } from 'crypto'
import { fixMojibake, isPaymentDescription, stripTrailingLocation } from '@/app/lib/normalize'
import { classifyBank, type BankSource } from '@/app/lib/bank-classify'

export type CardSource = 'master' | 'amex'
export type ImportSource = CardSource | BankSource

/** A normalized row ready to become a transaction (merchant resolved later). */
export type ParsedRow = {
  source: ImportSource
  externalId: string
  txnDate: string // YYYY-MM-DD
  postedDate: string | null
  rawDescription: string
  amount: number // positive = expense, negative = income/refund/payment
  rawCategory: string | null
  cardLast4: string | null
  country: string | null
  isPayment: boolean
  // Bank rows carry a precomputed classification (cards leave these undefined).
  flow?: 'expense' | 'income' | 'transfer'
  suggestedCategory?: string | null
  suggestedMerchant?: string | null
  isRecurring?: boolean
}

export type ParseResult = {
  source: ImportSource
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

/** Inspect the header row to decide which export this is. */
export function detectSource(header: string[]): ImportSource | null {
  const h = header.map((c) => c.trim().toLowerCase())
  if (h.includes('merchant category description') || h.includes('reference number')) {
    return 'master'
  }
  if (h.includes('card member') || h.includes('account #')) {
    return 'amex'
  }
  // Scotia: "Filter,Date,Description,Sub-description,Type of Transaction,Amount,Balance".
  if (h.includes('sub-description') && h.includes('type of transaction')) {
    return 'scotia'
  }
  // Tangerine: "Date,Transaction,Name,Memo,Amount".
  if (h.includes('transaction') && h.includes('memo') && h.includes('name')) {
    return 'tangerine'
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

/**
 * Normalize the date formats we ingest to ISO `YYYY-MM-DD`:
 *  - Master / Scotia: already ISO.
 *  - Amex: "10 Jun 2026".
 *  - Tangerine: "MM/DD/YYYY".
 */
function parseDate(raw: string): string | null {
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})$/)
  if (m) {
    const day = m[1].padStart(2, '0')
    const mon = MONTH_INDEX[m[2].toLowerCase()]
    if (mon) return `${m[3]}-${mon}-${day}`
  }
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slash) {
    return `${slash[3]}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`
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

/**
 * Turn one classified bank row into a ParsedRow. The CSV amount is signed
 * (+ in, - out); we negate it so the unified convention holds (positive = money
 * out). For card-present "pos purchase" rows the classifier returns no merchant,
 * so we keep the merchant text as the description for the learning layer.
 */
function bankRow(
  source: BankSource,
  date: string,
  description: string,
  subDescription: string,
  csvAmount: number,
  externalId: string
): ParsedRow {
  const cls = classifyBank({ source, date, description, subDescription, amount: csvAmount })
  const usesLearning = cls.merchant === null
  const rawDescription = usesLearning
    ? subDescription || description
    : [description, subDescription].filter(Boolean).join(' · ')
  return {
    source,
    externalId,
    txnDate: date,
    postedDate: null,
    rawDescription,
    amount: -csvAmount, // unified: positive = money out
    rawCategory: null,
    cardLast4: null,
    country: null,
    isPayment: false,
    flow: cls.flow,
    suggestedCategory: cls.category,
    suggestedMerchant: cls.merchant,
    isRecurring: cls.recurring,
  }
}

/** Tangerine export: Date (MM/DD/YYYY), Transaction, Name, Memo, Amount. */
function parseTangerine(rows: string[][]): ParsedRow[] {
  const header = rows[0]
  const idx = {
    date: colIndex(header, 'Date'),
    name: colIndex(header, 'Name'),
    memo: colIndex(header, 'Memo'),
    amount: colIndex(header, 'Amount'),
  }
  const out: ParsedRow[] = []
  for (const r of rows.slice(1)) {
    const txnDate = parseDate(r[idx.date] ?? '')
    const name = fixMojibake(r[idx.name] ?? '')
    if (!txnDate || !name) continue
    const memo = fixMojibake(r[idx.memo] ?? '')
    const amount = parseAmount(r[idx.amount] ?? '0')
    const externalId = `tangerine:${hashRow(['tangerine', txnDate, name, amount.toFixed(2)])}`
    out.push(bankRow('tangerine', txnDate, name, memo, amount, externalId))
  }
  return out
}

/** Scotia export: Filter, Date (ISO), Description, Sub-description, Type, Amount, Balance. */
function parseScotia(rows: string[][]): ParsedRow[] {
  const header = rows[0]
  const idx = {
    date: colIndex(header, 'Date'),
    description: colIndex(header, 'Description'),
    sub: colIndex(header, 'Sub-description'),
    amount: colIndex(header, 'Amount'),
  }
  const out: ParsedRow[] = []
  for (const r of rows.slice(1)) {
    const txnDate = parseDate(r[idx.date] ?? '')
    const description = fixMojibake(r[idx.description] ?? '')
    if (!txnDate || !description) continue
    const sub = fixMojibake(r[idx.sub] ?? '')
    const amount = parseAmount(r[idx.amount] ?? '0')
    // Balance is deliberately excluded from the id so duplicates collapse.
    const externalId = `scotia:${hashRow(['scotia', txnDate, description, sub, amount.toFixed(2)])}`
    out.push(bankRow('scotia', txnDate, description, sub, amount, externalId))
  }
  return out
}

function hashRow(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)
}

/** Parse a full CSV file, auto-detecting the source (card or bank). */
export function parseStatement(text: string, expected?: ImportSource): ParseResult {
  const rows = parseCsv(text)
  if (rows.length < 2) throw new Error('The file has no data rows.')
  const source = detectSource(rows[0])
  if (!source) {
    throw new Error('Could not recognize this CSV. Expected a Master, Amex, Scotia, or Tangerine export.')
  }
  if (expected && expected !== source) {
    throw new Error(
      `This looks like a ${source.toUpperCase()} file, but it was uploaded as ${expected.toUpperCase()}.`
    )
  }
  const parsed =
    source === 'master'
      ? parseMaster(rows)
      : source === 'amex'
        ? parseAmex(rows)
        : source === 'tangerine'
          ? parseTangerine(rows)
          : parseScotia(rows)
  return { source, rows: parsed }
}
