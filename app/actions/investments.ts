'use server'

import { revalidatePath } from 'next/cache'
import { and, asc, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  registeredAccounts,
  holdingSnapshots,
  holdingPositions,
  registeredContributions,
  type RegisteredKind,
} from '@/db/schema'
import { requireAuth } from '@/app/lib/auth-guard'
import { isDemoSession } from '@/app/lib/demo'
import { parseHoldings, toCad, totalValueCad } from '@/app/lib/holdings'
import { fetchUsdCadRate } from '@/app/lib/fx'
import { computeTfsaRoom, type RegisteredEntry, type TfsaRoom } from '@/app/lib/tfsa'
import { computeRespGrant, type RespGrant } from '@/app/lib/resp'

const SELF_NAME = process.env.SELF_NAME || 'Me'
const PARTNER_NAME = process.env.PARTNER_NAME || 'Partner'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}
const round2 = (n: number) => Math.round(n * 100) / 100
const numOrNull = (v: string | null) => (v === null ? null : Number(v))

function revalidateInvestments() {
  revalidatePath('/investments')
  revalidatePath('/')
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type PositionView = {
  symbol: string
  name: string
  assetClass: string
  currency: string
  quantity: number
  marketValue: number
  marketValueCad: number
  changePct: number
  changeAmount: number
}

export type ContributionView = {
  id: number
  kind: 'contribution' | 'withdrawal'
  amount: number
  occurredAt: string
  note: string | null
  fromTransfer: boolean
}

export type AccountView = {
  id: number
  kind: RegisteredKind
  name: string
  owner: 'self' | 'partner'
  ownerName: string
  currency: string
  brokerageAccountNo: string | null
  latest: { occurredAt: string; fxUsdCad: number; totalValueCad: number; bookValueCad: number } | null
  positions: PositionView[]
  valueSeries: { ym: string; value: number }[]
  contributions: ContributionView[]
  contributionsTotal: number
  tfsa: TfsaRoom | null
  resp: RespGrant | null
  // Raw baselines, surfaced so the editor can pre-fill.
  roomBaselineAmount: number | null
  roomBaselineDate: string | null
  beneficiaryBirthYear: number | null
  grantBaselineReceived: number | null
  contributionBaseline: number | null
  grantCarryForward: number | null
}

export type InvestmentsData = {
  accounts: AccountView[]
  totalValueCad: number
  selfName: string
  partnerName: string
}

export async function loadInvestmentsData(): Promise<InvestmentsData> {
  if (await isDemoSession()) {
    const { demoInvestmentsData } = await import('@/app/lib/demo-data')
    return demoInvestmentsData()
  }

  const accounts = await db
    .select()
    .from(registeredAccounts)
    .where(eq(registeredAccounts.archived, false))
    .orderBy(asc(registeredAccounts.sortOrder), asc(registeredAccounts.createdAt))

  const asOf = todayIso()
  const views: AccountView[] = []

  for (const a of accounts) {
    // Holdings: all snapshots (for the trend) + the latest one's positions.
    const snaps = await db
      .select()
      .from(holdingSnapshots)
      .where(eq(holdingSnapshots.accountId, a.id))
      .orderBy(asc(holdingSnapshots.occurredAt))
    const latestSnap = snaps.at(-1) ?? null

    let positions: PositionView[] = []
    let latest: AccountView['latest'] = null
    if (latestSnap) {
      const rows = await db
        .select()
        .from(holdingPositions)
        .where(eq(holdingPositions.snapshotId, latestSnap.id))
      positions = rows.map((p) => ({
        symbol: p.symbol,
        name: p.name ?? '',
        assetClass: p.assetClass ?? '',
        currency: p.currency,
        quantity: Number(p.quantity ?? 0),
        marketValue: Number(p.marketValue ?? 0),
        marketValueCad: Number(p.marketValueCad ?? 0),
        changePct: Number(p.changePct ?? 0),
        changeAmount: Number(p.changeAmount ?? 0),
      }))
      latest = {
        occurredAt: latestSnap.occurredAt,
        fxUsdCad: Number(latestSnap.fxUsdCad),
        totalValueCad: Number(latestSnap.totalValueCad),
        // Book value isn't denormalized on the header; sum the positions' CAD book.
        bookValueCad: round2(
          rows.reduce((s, p) => s + toCad(Number(p.bookValue ?? 0), p.currency, Number(latestSnap.fxUsdCad)), 0),
        ),
      }
    }
    const valueSeries = snaps.map((s) => ({ ym: s.occurredAt, value: Number(s.totalValueCad) }))

    // Contribution ledger.
    const contribRows = await db
      .select()
      .from(registeredContributions)
      .where(eq(registeredContributions.accountId, a.id))
      .orderBy(desc(registeredContributions.occurredAt))
    const contributions: ContributionView[] = contribRows.map((c) => ({
      id: c.id,
      kind: c.kind,
      amount: Number(c.amount),
      occurredAt: c.occurredAt,
      note: c.note,
      fromTransfer: c.transactionId != null,
    }))
    const contributionsTotal = round2(
      contribRows.reduce((s, c) => s + (c.kind === 'contribution' ? Number(c.amount) : -Number(c.amount)), 0),
    )

    // Rule engines.
    const entries: RegisteredEntry[] = contribRows.map((c) => ({
      kind: c.kind,
      amount: Number(c.amount),
      occurredAt: c.occurredAt,
    }))
    const tfsa =
      a.kind === 'tfsa' && a.roomBaselineAmount != null && a.roomBaselineDate
        ? computeTfsaRoom(Number(a.roomBaselineAmount), a.roomBaselineDate, entries, asOf)
        : null
    const resp =
      a.kind === 'resp'
        ? computeRespGrant(
            entries,
            {
              contributionBaseline: numOrNull(a.contributionBaseline),
              grantBaselineReceived: numOrNull(a.grantBaselineReceived),
              grantCarryForward: numOrNull(a.grantCarryForward),
              beneficiaryBirthYear: a.beneficiaryBirthYear,
            },
            asOf,
          )
        : null

    views.push({
      id: a.id,
      kind: a.kind,
      name: a.name,
      owner: a.owner,
      ownerName: a.owner === 'partner' ? PARTNER_NAME : SELF_NAME,
      currency: a.currency,
      brokerageAccountNo: a.brokerageAccountNo,
      latest,
      positions,
      valueSeries,
      contributions,
      contributionsTotal,
      tfsa,
      resp,
      roomBaselineAmount: numOrNull(a.roomBaselineAmount),
      roomBaselineDate: a.roomBaselineDate,
      beneficiaryBirthYear: a.beneficiaryBirthYear,
      grantBaselineReceived: numOrNull(a.grantBaselineReceived),
      contributionBaseline: numOrNull(a.contributionBaseline),
      grantCarryForward: numOrNull(a.grantCarryForward),
    })
  }

  return {
    accounts: views,
    totalValueCad: round2(views.reduce((s, v) => s + (v.latest?.totalValueCad ?? 0), 0)),
    selfName: SELF_NAME,
    partnerName: PARTNER_NAME,
  }
}

/** Minimal account list for the transfer-review "which account?" picker. */
export async function loadRegisteredAccountOptions(): Promise<
  { id: number; name: string; kind: RegisteredKind; ownerName: string }[]
> {
  if (await isDemoSession()) {
    const { demoInvestmentsData } = await import('@/app/lib/demo-data')
    return demoInvestmentsData().accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, ownerName: a.ownerName }))
  }
  const rows = await db
    .select()
    .from(registeredAccounts)
    .where(eq(registeredAccounts.archived, false))
    .orderBy(asc(registeredAccounts.sortOrder))
  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    ownerName: a.owner === 'partner' ? PARTNER_NAME : SELF_NAME,
  }))
}

export type TfsaRoomSummary = {
  hasTfsa: boolean
  roomLeft: number
  contributedThisYear: number
  overContributed: boolean
}

/** Aggregate TFSA contribution room across all TFSA accounts — for the Budget
 *  page nudge. Sums room/this-year contributions; over if any account is over. */
export async function loadTfsaRoomSummary(): Promise<TfsaRoomSummary> {
  const empty: TfsaRoomSummary = { hasTfsa: false, roomLeft: 0, contributedThisYear: 0, overContributed: false }
  if (await isDemoSession()) {
    const { demoInvestmentsData } = await import('@/app/lib/demo-data')
    const tfsas = demoInvestmentsData().accounts.filter((a) => a.tfsa)
    if (tfsas.length === 0) return empty
    return {
      hasTfsa: true,
      roomLeft: round2(tfsas.reduce((s, a) => s + (a.tfsa?.room ?? 0), 0)),
      contributedThisYear: round2(tfsas.reduce((s, a) => s + (a.tfsa?.contributionsThisYear ?? 0), 0)),
      overContributed: tfsas.some((a) => a.tfsa?.overContributed),
    }
  }

  const accounts = await db
    .select()
    .from(registeredAccounts)
    .where(and(eq(registeredAccounts.kind, 'tfsa'), eq(registeredAccounts.archived, false)))
  const withBaseline = accounts.filter((a) => a.roomBaselineAmount != null && a.roomBaselineDate)
  if (withBaseline.length === 0) return empty

  const asOf = todayIso()
  let roomLeft = 0
  let contributedThisYear = 0
  let overContributed = false
  for (const a of withBaseline) {
    const contribRows = await db
      .select()
      .from(registeredContributions)
      .where(eq(registeredContributions.accountId, a.id))
    const entries: RegisteredEntry[] = contribRows.map((c) => ({
      kind: c.kind,
      amount: Number(c.amount),
      occurredAt: c.occurredAt,
    }))
    const room = computeTfsaRoom(Number(a.roomBaselineAmount), a.roomBaselineDate!, entries, asOf)
    roomLeft += room.room
    contributedThisYear += room.contributionsThisYear
    if (room.overContributed) overContributed = true
  }
  return { hasTfsa: true, roomLeft: round2(roomLeft), contributedThisYear: round2(contributedThisYear), overContributed }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createRegisteredAccount(input: {
  kind: RegisteredKind
  name: string
  owner?: 'self' | 'partner'
  brokerageAccountNo?: string | null
  currency?: string
  roomBaselineAmount?: number | null
  roomBaselineDate?: string | null
  beneficiaryBirthYear?: number | null
  grantBaselineReceived?: number | null
  contributionBaseline?: number | null
  grantCarryForward?: number | null
}): Promise<void> {
  await requireAuth()
  const name = input.name.trim()
  if (!name) return
  const [{ max }] = await db
    .select({ max: registeredAccounts.sortOrder })
    .from(registeredAccounts)
    .orderBy(desc(registeredAccounts.sortOrder))
    .limit(1)
    .then((r) => (r.length ? r : [{ max: 0 }]))
  await db.insert(registeredAccounts).values({
    kind: input.kind,
    name,
    owner: input.owner ?? 'self',
    brokerageAccountNo: input.brokerageAccountNo?.trim() || null,
    currency: input.currency || 'CAD',
    roomBaselineAmount: input.roomBaselineAmount != null ? input.roomBaselineAmount.toFixed(2) : null,
    roomBaselineDate: input.roomBaselineDate || null,
    beneficiaryBirthYear: input.beneficiaryBirthYear ?? null,
    grantBaselineReceived: input.grantBaselineReceived != null ? input.grantBaselineReceived.toFixed(2) : null,
    contributionBaseline: input.contributionBaseline != null ? input.contributionBaseline.toFixed(2) : null,
    grantCarryForward: input.grantCarryForward != null ? input.grantCarryForward.toFixed(2) : null,
    sortOrder: (max ?? 0) + 1,
  })
  revalidateInvestments()
}

export async function updateRegisteredAccount(
  id: number,
  patch: {
    name?: string
    owner?: 'self' | 'partner'
    brokerageAccountNo?: string | null
    roomBaselineAmount?: number | null
    roomBaselineDate?: string | null
    beneficiaryBirthYear?: number | null
    grantBaselineReceived?: number | null
    contributionBaseline?: number | null
    grantCarryForward?: number | null
  },
): Promise<void> {
  await requireAuth()
  const set: Record<string, unknown> = {}
  if (patch.name !== undefined) set.name = patch.name.trim()
  if (patch.owner !== undefined) set.owner = patch.owner
  if (patch.brokerageAccountNo !== undefined) set.brokerageAccountNo = patch.brokerageAccountNo?.trim() || null
  if (patch.roomBaselineAmount !== undefined)
    set.roomBaselineAmount = patch.roomBaselineAmount != null ? patch.roomBaselineAmount.toFixed(2) : null
  if (patch.roomBaselineDate !== undefined) set.roomBaselineDate = patch.roomBaselineDate || null
  if (patch.beneficiaryBirthYear !== undefined) set.beneficiaryBirthYear = patch.beneficiaryBirthYear ?? null
  if (patch.grantBaselineReceived !== undefined)
    set.grantBaselineReceived = patch.grantBaselineReceived != null ? patch.grantBaselineReceived.toFixed(2) : null
  if (patch.contributionBaseline !== undefined)
    set.contributionBaseline = patch.contributionBaseline != null ? patch.contributionBaseline.toFixed(2) : null
  if (patch.grantCarryForward !== undefined)
    set.grantCarryForward = patch.grantCarryForward != null ? patch.grantCarryForward.toFixed(2) : null
  if (Object.keys(set).length === 0) return
  await db.update(registeredAccounts).set(set).where(eq(registeredAccounts.id, id))
  revalidateInvestments()
}

export async function deleteRegisteredAccount(id: number): Promise<void> {
  await requireAuth()
  await db.delete(registeredAccounts).where(eq(registeredAccounts.id, id))
  revalidateInvestments()
}

export type HoldingsImportResult =
  | { ok: true; positions: number; totalValueCad: number; fxUsdCad: number; fxLive: boolean }
  | { ok: false; error: string }

/**
 * Core holdings ingest (no auth / no FormData) so it is reusable by both the
 * manual upload action and the token-authed monthly sync endpoint. The account is
 * resolved by `accountId` (UI) or `brokerageAccountNo` (sync, from the iTrade
 * account the CSV was downloaded from). USD positions are valued in CAD with a
 * USD→CAD rate: an explicit override wins, else the live Bank of Canada rate, else
 * the previous snapshot's rate, else 1 — and the rate is STORED on the snapshot so
 * the CAD total stays reproducible.
 */
export async function ingestHoldings(input: {
  text: string
  accountId?: number
  brokerageAccountNo?: string
  fxOverride?: number | null
  occurredAt?: string
  filename?: string
}): Promise<HoldingsImportResult> {
  let accountId = input.accountId
  if (!accountId && input.brokerageAccountNo) {
    const [acc] = await db
      .select({ id: registeredAccounts.id })
      .from(registeredAccounts)
      .where(eq(registeredAccounts.brokerageAccountNo, input.brokerageAccountNo))
      .limit(1)
    accountId = acc?.id
  }
  if (!accountId || !Number.isInteger(accountId)) {
    return { ok: false, error: 'No matching registered account for this holdings file.' }
  }

  let positions
  try {
    positions = parseHoldings(input.text)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not parse the file.' }
  }
  if (positions.length === 0) return { ok: false, error: 'No holdings found in the file.' }

  const hasUsd = positions.some((p) => p.currency === 'USD')
  const fxOverride = input.fxOverride ?? null
  let fxUsdCad = 1
  let fxLive = false
  if (hasUsd) {
    if (fxOverride && fxOverride > 0.5 && fxOverride < 3) {
      fxUsdCad = fxOverride
    } else {
      const live = await fetchUsdCadRate()
      if (live) {
        fxUsdCad = live
        fxLive = true
      } else {
        const [prev] = await db
          .select({ fx: holdingSnapshots.fxUsdCad })
          .from(holdingSnapshots)
          .where(eq(holdingSnapshots.accountId, accountId))
          .orderBy(desc(holdingSnapshots.occurredAt))
          .limit(1)
        fxUsdCad = prev ? Number(prev.fx) : 1
      }
    }
  }

  const total = totalValueCad(positions, fxUsdCad)

  const [snap] = await db
    .insert(holdingSnapshots)
    .values({
      accountId,
      occurredAt: input.occurredAt || todayIso(),
      fxUsdCad: fxUsdCad.toFixed(5),
      totalValueCad: total.toFixed(2),
      note: input.filename || null,
    })
    .returning({ id: holdingSnapshots.id })

  await db.insert(holdingPositions).values(
    positions.map((p) => ({
      snapshotId: snap.id,
      symbol: p.symbol,
      name: p.name || null,
      assetClass: p.assetClass || null,
      currency: p.currency,
      quantity: p.quantity.toFixed(4),
      avgCost: p.avgCost.toFixed(4),
      marketPrice: p.marketPrice.toFixed(4),
      bookValue: p.bookValue.toFixed(2),
      marketValue: p.marketValue.toFixed(2),
      marketValueCad: toCad(p.marketValue, p.currency, fxUsdCad).toFixed(2),
      changePct: p.changePct.toFixed(2),
      changeAmount: p.changeAmount.toFixed(2),
    })),
  )

  revalidateInvestments()
  return { ok: true, positions: positions.length, totalValueCad: total, fxUsdCad, fxLive }
}

/** Manual upload from the Investments page (auth-gated FormData wrapper). */
export async function importHoldings(formData: FormData): Promise<HoldingsImportResult> {
  await requireAuth()
  const file = formData.get('file')
  const accountId = Number(formData.get('accountId'))
  const fxRaw = formData.get('fxUsdCad')
  const fxOverride = typeof fxRaw === 'string' && fxRaw.trim() ? Number(fxRaw) : null
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'Please choose a CSV file.' }
  if (!Number.isInteger(accountId)) return { ok: false, error: 'Pick an account to import into.' }
  return ingestHoldings({
    text: await file.text(),
    accountId,
    fxOverride,
    occurredAt: (formData.get('occurredAt') as string) || todayIso(),
    filename: file.name,
  })
}

/** Manually add a contribution / withdrawal to an account's ledger. */
export async function addManualContribution(input: {
  accountId: number
  amount: number
  kind?: 'contribution' | 'withdrawal'
  occurredAt?: string
  note?: string
}): Promise<void> {
  await requireAuth()
  const amount = Math.abs(round2(input.amount))
  if (!Number.isFinite(amount) || amount === 0) return
  await db.insert(registeredContributions).values({
    accountId: input.accountId,
    kind: input.kind ?? 'contribution',
    amount: amount.toFixed(2),
    occurredAt: input.occurredAt || todayIso(),
    note: input.note?.trim() || null,
  })
  revalidateInvestments()
}

export async function deleteContribution(id: number): Promise<void> {
  await requireAuth()
  await db.delete(registeredContributions).where(eq(registeredContributions.id, id))
  revalidateInvestments()
}

/**
 * Link an imported transfer to a registered account as a contribution. Called by
 * the dashboard transfer-review when the owner tags a Scotia→iTrade transfer to
 * TFSA/RESP. Idempotent (the unique transactionId index collapses re-tags), and a
 * no-op overlay: it never changes the transaction's flow/category, so spend
 * analytics and the Goals system are untouched — it only feeds room/grant math.
 */
export async function recordTransferContribution(input: {
  accountId: number
  transactionId: number
  amount: number
  occurredAt: string
}): Promise<void> {
  const amount = Math.abs(round2(input.amount))
  if (!Number.isFinite(amount) || amount === 0) return
  await db
    .insert(registeredContributions)
    .values({
      accountId: input.accountId,
      kind: 'contribution',
      amount: amount.toFixed(2),
      occurredAt: input.occurredAt,
      transactionId: input.transactionId,
      note: 'From transfer',
    })
    .onConflictDoNothing({ target: registeredContributions.transactionId })
  revalidateInvestments()
}
