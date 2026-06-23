'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { cashflowConfig, categories } from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { isDemoSession } from '@/app/lib/demo'
import { loadAllFlows } from '@/app/lib/analytics'
import { FIXED_CATEGORIES } from '@/app/lib/budget'
import { loadProjectionRules } from '@/app/actions/projection'
import { loadEmergencyFund, loadOutstandingByCard } from '@/app/actions/emergency'
import {
  inferSchedule,
  applyOverrides,
  ACCOUNT_LABELS,
  DEFAULT_CARD_ACCOUNTS,
  DEFAULT_CC_PAYMENT_DAY,
  DEFAULT_CC_PENDING_BUFFER,
  type Account,
  type CardAccounts,
  type EventOverride,
  type ScheduledEvent,
} from '@/app/lib/cashflow'

const ACCOUNTS: Account[] = ['tangerine', 'scotia']

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export type CashflowConfig = {
  buffers: Record<Account, number>
  cardAccounts: CardAccounts
  /** Day of month both cards are paid (owner pays ~the 11th). */
  ccPaymentDay: number
  /** Combined $ added to the card payment for charges still pending (not in CSV). */
  ccPendingBuffer: number
  overrides: EventOverride[]
  /** Manual "big expense before next CC payment" — kept PER account so each bank
   *  has its own value (switching the picker shows that account's amount). */
  unplannedExpense: Record<Account, number>
}

const DEFAULT_CONFIG: CashflowConfig = {
  buffers: { tangerine: 0, scotia: 0 },
  cardAccounts: DEFAULT_CARD_ACCOUNTS,
  ccPaymentDay: DEFAULT_CC_PAYMENT_DAY,
  ccPendingBuffer: DEFAULT_CC_PENDING_BUFFER,
  overrides: [],
  unplannedExpense: { tangerine: 0, scotia: 0 },
}

/** Normalize the stored unplanned-expense (handles the legacy `{account,amount}`
 *  shape so old rows keep working without a migration). */
function readUnplanned(raw: unknown): Record<Account, number> {
  const v = raw as Record<string, unknown> | null
  if (v && (typeof v.tangerine === 'number' || typeof v.scotia === 'number')) {
    return { tangerine: Number(v.tangerine) || 0, scotia: Number(v.scotia) || 0 }
  }
  if (v && typeof v.account === 'string') {
    const out = { tangerine: 0, scotia: 0 }
    out[v.account as Account] = Number(v.amount) || 0
    return out
  }
  return { ...DEFAULT_CONFIG.unplannedExpense }
}

/** Read the singleton config row, falling back to defaults before first save. */
export async function loadCashflowConfig(): Promise<CashflowConfig> {
  const [row] = await db.select().from(cashflowConfig).limit(1)
  if (!row) return DEFAULT_CONFIG
  return {
    buffers: { ...DEFAULT_CONFIG.buffers, ...(row.buffers as Record<Account, number>) },
    cardAccounts: { ...DEFAULT_CONFIG.cardAccounts, ...(row.cardAccounts as CardAccounts) },
    ccPaymentDay: row.ccPaymentDay ?? DEFAULT_CONFIG.ccPaymentDay,
    ccPendingBuffer: row.ccPendingBuffer != null ? Number(row.ccPendingBuffer) : DEFAULT_CONFIG.ccPendingBuffer,
    overrides: (row.overrides as EventOverride[]) ?? [],
    unplannedExpense: readUnplanned(row.unplannedExpense),
  }
}

export type CashflowAccountPlan = {
  account: Account
  label: string
  balance: number
  buffer: number
  events: ScheduledEvent[]
}

export type CashflowPlan = {
  hasData: boolean
  today: string
  accounts: CashflowAccountPlan[]
  cardAccounts: CardAccounts
  ccPaymentDay: number
  ccPendingBuffer: number
  outstandingByCard: { master: number; amex: number }
  unplannedExpense: Record<Account, number>
  /** The owner's saved overrides, so the editor can round-trip them. */
  overrides: EventOverride[]
}

/**
 * Assemble the "safe to move" plan: live chequing balances + the inferred (then
 * override-applied) schedule + the current card balances, so the client widget
 * can run `projectAccount` live as the owner edits the unplanned-expense input.
 * See BUSINESS_RULES.md §14.
 */
export async function loadCashflowPlan(): Promise<CashflowPlan> {
  if (await isDemoSession()) {
    const { demoCashflowPlan } = await import('@/app/lib/demo-data')
    return demoCashflowPlan()
  }
  const [all, catRows, rules, fund, outstandingByCard, config] = await Promise.all([
    loadAllFlows(),
    db.select().from(categories),
    loadProjectionRules(),
    loadEmergencyFund(),
    loadOutstandingByCard(),
    loadCashflowConfig(),
  ])
  const today = todayIso()
  const cats = catRows.map((c) => ({ name: c.name, kind: c.kind }))
  const inferred = inferSchedule(
    all,
    cats,
    rules,
    outstandingByCard,
    config.cardAccounts,
    FIXED_CATEGORIES,
    today,
    config.ccPaymentDay,
    config.ccPendingBuffer,
  )
  const events = applyOverrides(inferred, config.overrides, today)
  const balanceOf = (account: Account) => fund.accounts.find((a) => a.source === account)?.balance ?? 0

  return {
    hasData: fund.hasData,
    today,
    accounts: ACCOUNTS.map((account) => ({
      account,
      label: ACCOUNT_LABELS[account],
      balance: balanceOf(account),
      buffer: config.buffers[account] ?? 0,
      events: events.filter((e) => e.account === account),
    })),
    cardAccounts: config.cardAccounts,
    ccPaymentDay: config.ccPaymentDay,
    ccPendingBuffer: config.ccPendingBuffer,
    outstandingByCard,
    unplannedExpense: config.unplannedExpense,
    overrides: config.overrides,
  }
}

/** Upsert the owner's edits to the cash-flow tool (blocked in demo by auth). */
export async function saveCashflowConfig(patch: Partial<CashflowConfig>): Promise<void> {
  await requireAuth()
  const current = await loadCashflowConfig()
  const next: CashflowConfig = {
    buffers: { ...current.buffers, ...(patch.buffers ?? {}) },
    cardAccounts: { ...current.cardAccounts, ...(patch.cardAccounts ?? {}) },
    ccPaymentDay: patch.ccPaymentDay ?? current.ccPaymentDay,
    ccPendingBuffer: patch.ccPendingBuffer ?? current.ccPendingBuffer,
    overrides: patch.overrides ?? current.overrides,
    unplannedExpense: { ...current.unplannedExpense, ...(patch.unplannedExpense ?? {}) },
  }
  const [existing] = await db.select().from(cashflowConfig).limit(1)
  const values = {
    buffers: next.buffers,
    cardAccounts: next.cardAccounts,
    ccPaymentDay: Math.min(28, Math.max(1, Math.round(next.ccPaymentDay))),
    ccPendingBuffer: String(Math.max(0, Math.round(next.ccPendingBuffer * 100) / 100)),
    overrides: next.overrides,
    unplannedExpense: next.unplannedExpense,
    updatedAt: new Date(),
  }
  if (existing) {
    await db.update(cashflowConfig).set(values).where(eq(cashflowConfig.id, existing.id))
  } else {
    await db.insert(cashflowConfig).values(values)
  }
  revalidatePath('/')
}
