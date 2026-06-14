/**
 * Merchant-name normalization. Pure & deterministic so it is easy to reason
 * about and test. See BUSINESS_RULES.md for the full specification.
 *
 * Goal: turn messy raw descriptions like "COSTCO WHOLESALE #1655",
 * "PAYPAL *HOMEDEPOTCA", "AMZN Mktp CA*255ZD3II3" into a stable grouping KEY
 * used to match merchant_rules and (for unknown merchants) to derive a display
 * name. Brand-level grouping (all Amazon variants -> "Amazon") is handled by
 * seeded `contains` rules in the DB, not here, so the knowledge stays editable.
 */

/** Processor prefixes that wrap the real merchant; we keep the remainder. */
const PROCESSOR_PREFIXES = [
  'PAYPAL *',
  'PAYPAL*',
  'SQ *',
  'SQ*',
  'TST-',
  'TST *',
  'TST*',
  'SP ', // Amex Square-style prefix, e.g. "SP ODDBUNCH"
  'NTS ',
]

/** Fix UTF-8 mojibake (NBSP read as latin1 shows up as "Â ") and tidy spaces. */
export function fixMojibake(input: string): string {
  return input
    .replace(/Â /g, ' ') // "Â " sequence
    .replace(/Â/g, ' ')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Amex descriptions are fixed-width: "<merchant>   <city/phone>". Take the
 * merchant portion (before the first run of 2+ spaces). Master merchant names
 * pass through unchanged.
 */
export function stripTrailingLocation(input: string): string {
  const parts = input.split(/\s{2,}/)
  return parts[0].trim()
}

function looksRandom(token: string): boolean {
  // Reference codes like "514AG76G3", "255ZD3II3", "W1655": letters + digits.
  if (token.length >= 5 && /[a-z]/.test(token) && /\d/.test(token)) return true
  // Pure store / phone numbers.
  if (/^\d{2,}$/.test(token)) return true
  return false
}

/**
 * Produce the canonical grouping key for a raw merchant description.
 * Lowercased, punctuation collapsed to spaces, noise tokens removed.
 */
export function normalizeKey(rawInput: string): string {
  // Strip the trailing city/phone BEFORE collapsing whitespace, since the
  // Amex fixed-width split relies on runs of 2+ spaces.
  let s = stripTrailingLocation(rawInput)
  s = fixMojibake(s)

  let upper = s.toUpperCase()
  for (const prefix of PROCESSOR_PREFIXES) {
    if (upper.startsWith(prefix)) {
      s = s.slice(prefix.length)
      upper = s.toUpperCase()
      break
    }
  }

  // Cut at separators that precede location / reference noise.
  s = s.split('/')[0]
  s = s.split('(')[0]

  // Drop "#1655" style store numbers up front.
  s = s.replace(/#\s*\d+/g, ' ')

  // Tokenize on anything non-alphanumeric (handles "*", ".", "-", "&", etc.).
  const tokens = s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !looksRandom(t))

  const key = tokens.join(' ').trim()
  // Fallback: if everything was stripped, use a cleaned version of the original.
  return key || fixMojibake(rawInput).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
}

/** Title-case a key into a human display name: "costco wholesale" -> "Costco Wholesale". */
export function prettify(key: string): string {
  return key
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Map a Master "Merchant Category Description" to one of our seed category
 * names so brand-new merchants land in a sensible bucket automatically.
 * Returns null when nothing matches (caller leaves category unset).
 */
export function masterCategoryFor(description: string | null): string | null {
  if (!description) return null
  const d = fixMojibake(description).toLowerCase()

  const has = (...needles: string[]) => needles.some((n) => d.includes(n))

  if (has('grocery', 'supermarket', 'wholesale club')) return 'Groceries'
  if (has('fast food', 'eating places', 'restaurant')) return 'Dining'
  if (has('drug store', 'pharmacies', 'medical', 'dental', 'health')) return 'Health'
  if (has('fuel', 'service station', 'gas')) return 'Fuel'
  if (has('commuter', 'transportation', 'parking', 'ferries')) return 'Transport'
  if (has('automotive', 'car and truck', 'vehicle')) return 'Transport'
  if (has('software', 'digital goods')) return 'Subscriptions'
  if (has('telecommunication', 'utilities', 'cable')) return 'Utilities'
  if (has('furniture', 'home furnishings', 'hardware')) return 'Home'
  if (has('school', 'educational', 'children', 'infants', 'toy')) return 'Kids'
  if (has('theatrical', 'ticket', 'entertainment', 'motion picture')) return 'Entertainment'
  if (has('travel', 'airline', 'lodging', 'hotel', 'car rental')) return 'Travel'
  if (
    has(
      'clothing',
      'discount store',
      'variety store',
      'general merchandise',
      'specialty retail',
      'electronics',
      'sporting goods',
      'merchandise',
      'beer wine and liquor',
      'package stores'
    )
  )
    return 'Shopping'

  return null
}

/** Detect card-payment rows that must be excluded from spend analytics. */
export function isPaymentDescription(raw: string): boolean {
  const d = raw.toLowerCase()
  return d.includes('payment') && d.includes('thank you')
}
