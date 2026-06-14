/**
 * Bank-statement classification (Scotia chequing + Tangerine). Pure &
 * deterministic so it is easy to reason about and test. Maps each raw bank row
 * to a money-flow, a category, a payee/merchant, and a recurring flag. See
 * BUSINESS_RULES.md for the full specification and the rationale behind each
 * rule (confirmed with the account owner).
 *
 * Sign of `input.amount` follows the CSV: positive = money in (deposit),
 * negative = money out (debit). Callers negate it when storing so the unified
 * convention (positive = money out) holds.
 */

export type BankSource = 'tangerine' | 'scotia'

export type BankInput = {
  source: BankSource
  date: string // YYYY-MM-DD
  description: string // Tangerine "Name" / Scotia "Description"
  subDescription: string // Tangerine "Memo" / Scotia "Sub-description"
  amount: number // CSV sign: + in, - out
}

export type BankClass = {
  flow: 'expense' | 'income' | 'transfer'
  /** Category name (must exist in the seed) or null for the learning path. */
  category: string | null
  /** Fixed payee name, or null to resolve via normalizeKey + merchant_rules. */
  merchant: string | null
  recurring: boolean
}

/**
 * When the card's own statement is imported, the bank-side payment is a
 * duplicate of tracked spending, so it is ignored (transfer). Before these
 * dates we have no statement, so the payment counts as a "CC Payment" expense.
 */
const CARD_TRACKED_SINCE: Record<string, string> = {
  amex: '2024-12-01',
  rogers: '2025-06-01',
  // visa & mbna: no statements ever -> always counted as an expense.
}

const income = (category: string, merchant: string, recurring = false): BankClass => ({
  flow: 'income',
  category,
  merchant,
  recurring,
})
const expense = (category: string | null, merchant: string | null, recurring = false): BankClass => ({
  flow: 'expense',
  category,
  merchant,
  recurring,
})
const transfer = (merchant: string): BankClass => ({
  flow: 'transfer',
  category: 'Transfer',
  merchant,
  recurring: false,
})

/** A bank payment toward a credit card: ignore if tracked, else an expense. */
function cardPayment(card: string, label: string, date: string): BankClass {
  const since = CARD_TRACKED_SINCE[card]
  if (since && date >= since) return transfer(label)
  return expense('CC Payment', label)
}

const has = (haystack: string, ...needles: string[]) =>
  needles.some((n) => haystack.includes(n))

export function classifyBank(input: BankInput): BankClass {
  return input.source === 'tangerine' ? classifyTangerine(input) : classifyScotia(input)
}

function classifyTangerine(input: BankInput): BankClass {
  const name = input.description.toLowerCase()

  // --- Income (deposits) ---
  if (has(name, 'bgrs', 'sirva', 'payroll deposit')) return income('Salary', 'BGRS / Sirva')
  if (has(name, 'pereira', 'aparecid', 'transferwise'))
    return income('Family Support', 'Family (Brazil)')
  if (has(name, 'canada life')) return income('Insurance', 'Canada Life')
  if (has(name, 'manulife')) return income('Insurance', 'Manulife')
  if (has(name, 'interest paid')) return income('Interest', 'Tangerine Interest', true)

  // --- Transfers (ignored) ---
  // Tangerine -> Scotia chequing (matches a Scotia "investment / Tangerine" credit).
  if (has(name, 'the bank of no')) return transfer('Account Transfer')

  // --- Credit-card payments ---
  if (has(name, 'rogers bank') || has(name, 'rogers'))
    return cardPayment('rogers', 'Rogers Mastercard Payment', input.date)
  if (has(name, 'american express', 'amex'))
    return cardPayment('amex', 'Amex Payment', input.date)
  if (has(name, 'mbna')) return cardPayment('mbna', 'MBNA Payment', input.date)

  // --- Other expenses ---
  if (has(name, 'highway 407', '407')) return expense('Transport', 'Highway 407')
  if (has(name, 'koodo')) return expense('Utilities', 'Koodo Mobile', true)
  if (has(name, 'interac e-transfer to', 'e-transfer to')) return expense('Other', 'E-Transfer Out')
  if (has(name, 'cheque withdrawal')) return expense('Other', 'Cheque Withdrawal')

  // Unknown: deposits -> income, debits -> expense (review).
  return input.amount > 0 ? income('Other Income', 'Other Deposit') : expense('Other', 'Bank Withdrawal')
}

function classifyScotia(input: BankInput): BankClass {
  const desc = input.description.toLowerCase()
  const sub = input.subDescription.toLowerCase()
  const both = `${desc} ${sub}`
  const out = Math.abs(input.amount)

  // --- Income (credits) ---
  if (has(desc, 'payroll deposit')) return income('Salary', 'University Health Network')
  if (has(desc, 'canadian child benefit')) return income('Benefits', 'Child Benefit', true)
  if (has(desc, 'canada carbon rebate')) return income('Benefits', 'Carbon Rebate')
  if (has(desc, 'tax refund')) return income('Tax Refund', 'Tax Refund (CRA)')
  if (has(desc, 'miscellaneous payment') && has(sub, 'sun life'))
    return income('Insurance', 'Sun Life')

  // --- Transfers (ignored) ---
  // Inbound from Tangerine (Scotia labels these "investment / Tangerine").
  if (has(desc, 'investment') && has(sub, 'tangerine')) return transfer('Account Transfer')

  // --- Credit-card payments ---
  if (has(both, 'american express', 'amex')) return cardPayment('amex', 'Amex Payment', input.date)
  if (has(both, 'rogers')) return cardPayment('rogers', 'Rogers Mastercard Payment', input.date)
  if (has(both, 'mbna')) return cardPayment('mbna', 'MBNA Payment', input.date)
  if (has(desc, 'crd. card bill payment')) return cardPayment('visa', 'Visa Payment', input.date)
  if (has(desc, 'customer transfer') && has(sub, 'credit card', 'loc pay'))
    return cardPayment('loc', 'Card / Line of Credit Payment', input.date)

  // --- Recurring bank expenses ---
  if (has(desc, 'mortgage payment')) return expense('Mortgage', 'Mortgage', true)
  if (has(desc, 'taxes') && has(sub, 'toronto')) return expense('Property Tax', 'Toronto Property Tax', true)
  if (has(desc, 'water bill payment')) return expense('Utilities', 'Toronto Water')
  if (has(desc, 'bill payment') && has(sub, 'toronto hydro'))
    return expense('Utilities', 'Toronto Hydro', true)
  if (has(both, 'goodlife')) return expense('Health', 'Goodlife Fitness', true)
  if (has(both, 'planet fitness')) return expense('Health', 'Planet Fitness', true)
  if (has(both, 'new haven')) return expense('Kids', 'New Haven Learning', true)
  if (has(both, 'kumon')) return expense('Kids', 'Kumon', true)
  if (has(desc, 'service charge')) return expense('Bank Fees', 'Scotia Fees', true)
  if (has(desc, 'abm withdrawal')) return expense('Cash', 'ABM Cash')

  // Real card-present purchases: resolve via the learning layer on the
  // sub-description (which holds the merchant text), like card statements.
  if (has(desc, 'pos purchase')) return { flow: 'expense', category: null, merchant: null, recurring: false }

  // Recurring outbound "customer transfer dr." split (owner-confirmed):
  // $1,100 = extra mortgage, $900 = iTrade investment, everything else = investment (review).
  if (has(desc, 'customer transfer')) {
    if (out === 1100) return expense('Mortgage', 'Mortgage', true)
    return expense('Investment', 'Investment (iTrade)')
  }

  // Remaining deposits/withdrawals.
  if (has(desc, 'deposit')) return income('Other Income', 'Other Deposit')
  if (has(desc, 'withdrawal')) return expense('Other', 'E-Transfer Out')

  return input.amount > 0 ? income('Other Income', 'Other Deposit') : expense('Other', 'Bank Withdrawal')
}
