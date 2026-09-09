/**
 * Camping-season rules — the shared engine behind the yearly "Camping <year>"
 * project (BUSINESS_RULES.md §15). Two entry points use it:
 *
 *   - `sync/camping.ts`            — the monthly job (trips from the RV app + an
 *                                    AI sweep for merchants the rules don't know)
 *   - `scripts/camping-projects.ts` — the one-off 2025/2026 backfill, whose trips
 *                                    were reconstructed by hand from statements
 *
 * The question the project answers is "what does the setup (truck + trailer +
 * storage) cost me a year?", so exactly three kinds of transaction go in, and
 * nothing else — on-trip food, firewood, ice and fun are deliberately out:
 *
 *  1. FEES — campground / Ontario Parks charges, counted in the SEASON THEY ARE
 *     FOR rather than when they were paid (bookings go out months ahead: a
 *     December Ontario Parks charge is next summer's camping). Season window for
 *     year Y is [Y-1-11-01, Y-10-31]. A $100 floor drops the small on-site taps
 *     at a park whose booking we already counted; every Ontario Parks
 *     reservation-system charge counts, including $8.50 fees and refunds.
 *  2. GAS — every fill of $20+ from the day before a trip starts through its last
 *     day: the tank to get there and the tank to get home. The floor drops
 *     gas-station snack/variety taps.
 *  3. STORAGE — the $111.87/month Interac e-transfer that parks the trailer, on a
 *     cash basis.
 *
 * Membership is written with ON CONFLICT DO NOTHING, so a row the owner removed
 * in the app (which leaves a `dismissed` tombstone) is never resurrected and
 * re-running is always safe.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { projects, projectTransactions } from '../../db/schema'

export type Trip = {
  start: string
  end: string
  where: string
  /** 'app' = logged in the RV trips app; 'inferred' = reconstructed from statements. */
  source: 'app' | 'inferred'
}

export type Pick = {
  id: number
  txnDate: string
  merchant: string
  amount: number
  why: string
}

/** Gas stations, cross-checked against the Cars category so "Mobile Klinik" can't sneak in. */
export const GAS_RE =
  'petro-?can|costco gas|circle k|^esso|shell canada|ultramar|husky|pioneer|canadian tire gas|^mobil( |$)|gas and|flying j|macewen'
/** Campgrounds, provincial parks and conservation authorities we have actually paid. */
export const CAMP_RE =
  'ontario parks reservation|windmill point|the ponderosa|toronto and region conservation|fisherman.s cove|albion hills|arrowhead provincial|killbear provincial|bass lake provincial|sibbald point|presqu'
/** A booking is three digits; anything smaller at a park is firewood/ice/day-use. */
export const FEE_FLOOR = 100
/** A tow-vehicle fill; anything smaller at a pump is a snack or a variety-store tap. */
export const GAS_FLOOR = 20
export const STORAGE_AMOUNT = '111.87'

/** The methodology note stamped on a project the first time it is created. */
export function seasonNotes(year: number): string {
  return (
    `What the camping setup costs in ${year}: park/campground fees (counted in the season ` +
    'they are for, not when they were paid), the fill-up leaving and the one coming home for ' +
    'each trip, and the $111.87/mo trailer storage. On-trip food, firewood and fun are ' +
    'deliberately left out. Trips come from the RV trips app; the monthly job refreshes this ' +
    'after every statement sync. Remove anything that does not belong — a removed row is ' +
    'tombstoned and never comes back.'
  )
}

/** `db.execute` hands back either a rows envelope or a bare array, depending on the driver. */
function rowsOf<T>(res: unknown): T[] {
  const r = res as { rows?: T[] } | T[]
  return Array.isArray(r) ? r : (r.rows ?? [])
}

type TxnRow = { id: number; txn_date: string; name: string; amount: number }
type CandidateRow = TxnRow & { raw_description: string; category: string }

function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// The RV trips app (Firestore project `rv-groceries`)
// ---------------------------------------------------------------------------

/**
 * Read the trips the owner logged in https://rv-groceries.web.app for one year.
 *
 * Auth is the Mac's own gcloud user credential (`gcloud auth print-access-token`)
 * — no service-account key in the repo. If that fails the caller should let the
 * whole run fail: the job is retried the next day, and the fix is a one-off
 * `gcloud auth login`.
 */
export function loadTripsFromRvApp(year: number, gcloud = '/opt/homebrew/bin/gcloud'): Promise<Trip[]> {
  const token = execFileSync(gcloud, ['auth', 'print-access-token'], {
    encoding: 'utf8',
    timeout: 60_000,
  }).trim()
  if (!token) throw new Error('gcloud returned an empty access token')

  const fields = ['title', 'startDate', 'endDate', 'status']
    .map((f) => `mask.fieldPaths=${f}`)
    .join('&')

  const fetchPage = async (pageToken?: string): Promise<Trip[]> => {
    const url =
      'https://firestore.googleapis.com/v1/projects/rv-groceries/databases/(default)/documents/trips' +
      `?pageSize=300&${fields}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Firestore ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body = (await res.json()) as {
      documents?: { fields?: Record<string, { stringValue?: string }> }[]
      nextPageToken?: string
    }
    const trips: Trip[] = []
    for (const doc of body.documents ?? []) {
      const f = doc.fields ?? {}
      const start = f.startDate?.stringValue
      const end = f.endDate?.stringValue ?? start
      const status = f.status?.stringValue ?? 'planned'
      // A cancelled trip never happened; a trip in another year belongs to another project.
      if (!start || !end || status === 'cancelled' || !start.startsWith(String(year))) continue
      trips.push({ start, end, where: f.title?.stringValue ?? 'Trip', source: 'app' })
    }
    if (body.nextPageToken) trips.push(...(await fetchPage(body.nextPageToken)))
    return trips
  }

  return fetchPage().then((trips) =>
    trips.sort((a, b) => a.start.localeCompare(b.start) || a.where.localeCompare(b.where))
  )
}

// ---------------------------------------------------------------------------
// Deterministic picks
// ---------------------------------------------------------------------------

/** Fees + storage + per-trip gas for one season, de-duplicated and date-sorted. */
export async function pickSeason(year: number, trips: Trip[]): Promise<Pick[]> {
  const fees = await db.execute(sql`
    select t.id, t.txn_date, m.name, t.amount::float as amount
    from transactions t join merchants m on m.id = t.merchant_id
    where t.txn_date between ${`${year - 1}-11-01`} and ${`${year}-10-31`}
      and m.name ~* ${CAMP_RE}
      and (m.name ilike 'ontario parks%' or abs(t.amount) >= ${FEE_FLOOR})
    order by t.txn_date`)

  const storage = await db.execute(sql`
    select t.id, t.txn_date, m.name, t.amount::float as amount
    from transactions t join merchants m on m.id = t.merchant_id
    where t.txn_date between ${`${year}-01-01`} and ${`${year}-12-31`}
      and m.name = 'E-Transfer Out' and t.amount = ${STORAGE_AMOUNT}
    order by t.txn_date`)

  const out: Pick[] = []
  const seen = new Set<number>()
  const add = (r: TxnRow, why: string) => {
    if (seen.has(r.id)) return
    seen.add(r.id)
    out.push({ id: r.id, txnDate: r.txn_date, merchant: r.name, amount: r.amount, why })
  }

  for (const r of rowsOf<TxnRow>(fees)) add(r, 'fee')
  for (const r of rowsOf<TxnRow>(storage)) add(r, 'storage')

  for (const trip of trips) {
    const gas = await db.execute(sql`
      select t.id, t.txn_date, m.name, t.amount::float as amount
      from transactions t join merchants m on m.id = t.merchant_id
      left join categories c on c.id = coalesce(t.category_id, m.category_id)
      where t.txn_date between ${shift(trip.start, -1)} and ${trip.end}
        and c.name = 'Cars' and m.name ~* ${GAS_RE} and t.amount >= ${GAS_FLOOR}
      order by t.txn_date`)
    for (const r of rowsOf<TxnRow>(gas)) add(r, `gas · ${trip.where}`)
  }

  return out.sort((a, b) => a.txnDate.localeCompare(b.txnDate))
}

// ---------------------------------------------------------------------------
// Project upsert + membership
// ---------------------------------------------------------------------------

/**
 * Find (or create) `Camping <year>` and keep its date window covering the trips.
 *
 * Notes are written only on CREATE, and the window is only ever WIDENED — the
 * monthly job must never overwrite something the owner edited by hand.
 */
export async function upsertSeasonProject(
  year: number,
  trips: Trip[]
): Promise<{ id: number; created: boolean }> {
  const name = `Camping ${year}`
  const start = trips.length ? trips[0].start : null
  const end = trips.length ? trips.reduce((m, t) => (t.end > m ? t.end : m), trips[0].end) : null

  const [existing] = await db.select().from(projects).where(eq(projects.name, name))
  if (!existing) {
    const [row] = await db
      .insert(projects)
      .values({
        name,
        emoji: '🏕️',
        color: '#0ea5e9',
        startDate: start,
        endDate: end,
        notes: seasonNotes(year),
        autoFill: null, // manual-only: never hoover up every card charge in the window
      })
      .returning({ id: projects.id })
    return { id: row.id, created: true }
  }

  const widened = {
    startDate: !start ? existing.startDate : !existing.startDate || start < existing.startDate ? start : existing.startDate,
    endDate: !end ? existing.endDate : !existing.endDate || end > existing.endDate ? end : existing.endDate,
  }
  if (widened.startDate !== existing.startDate || widened.endDate !== existing.endDate) {
    await db.update(projects).set(widened).where(eq(projects.id, existing.id))
  }
  return { id: existing.id, created: false }
}

/** Insert memberships, skipping anything already a member OR tombstoned. Returns what was new. */
export async function addMembers(projectId: number, picks: Pick[]): Promise<Pick[]> {
  const added: Pick[] = []
  for (const p of picks) {
    const res = await db
      .insert(projectTransactions)
      .values({ projectId, transactionId: p.id })
      .onConflictDoNothing()
      .returning({ id: projectTransactions.id })
    if (res.length) added.push(p)
  }
  return added
}

/** Transaction ids the project already knows about — members and tombstones alike. */
export async function knownTxnIds(projectId: number): Promise<Set<number>> {
  const rows = await db
    .select({ id: projectTransactions.transactionId })
    .from(projectTransactions)
    .where(eq(projectTransactions.projectId, projectId))
  return new Set(rows.map((r) => r.id))
}

// ---------------------------------------------------------------------------
// AI sweep — the part the regexes can't do
// ---------------------------------------------------------------------------

export type Candidate = {
  id: number
  txnDate: string
  merchant: string
  raw: string
  amount: number
  category: string
}

/**
 * Rows worth showing the model: anything inside a trip window (± a day) or,
 * anywhere in the season, anything that smells outdoorsy. That is where a new
 * campground we have never paid before will turn up — "PRX*SHERKSTON SHORES"
 * matches no rule we ship, but it is obviously a campground to a human.
 */
export async function loadCandidates(
  year: number,
  trips: Trip[],
  exclude: Set<number>,
  limit = 150
): Promise<Candidate[]> {
  const windows = trips.map((t) => sql`(t.txn_date between ${shift(t.start, -1)} and ${shift(t.end, 1)})`)
  const nearTrip = windows.length ? sql`(${sql.join(windows, sql` or `)})` : sql`false`
  const rows = await db.execute(sql`
    select t.id, t.txn_date, m.name, t.raw_description, t.amount::float as amount,
           coalesce(c.name, 'Uncategorized') as category
    from transactions t join merchants m on m.id = t.merchant_id
    left join categories c on c.id = coalesce(t.category_id, m.category_id)
    where t.txn_date between ${`${year - 1}-11-01`} and ${`${year}-12-31`}
      and t.is_payment = false
      and (
        ${nearTrip}
        or m.name ~* 'park|camp|conserv|rv |trailer|campground|koa|reserv|mecp|trca|marina|yurt|cabin|outdoor'
        or t.raw_description ~* 'park|camp|conserv|campground|koa|mecp|trca|trailer'
      )
    order by t.txn_date desc
    limit ${limit * 2}`)

  const out: Candidate[] = []
  for (const r of rowsOf<CandidateRow>(rows)) {
    if (exclude.has(r.id)) continue
    out.push({
      id: r.id,
      txnDate: r.txn_date,
      merchant: r.name,
      raw: r.raw_description,
      amount: r.amount,
      category: r.category,
    })
    if (out.length >= limit) break
  }
  return out
}

function prompt(
  year: number,
  trips: Trip[],
  candidates: Candidate[],
  alreadyIn: Pick[]
): string {
  const tripLines = trips.length
    ? trips.map((t) => `- ${t.start} → ${t.end}: ${t.where}`).join('\n')
    : '- (no trips logged for this year yet)'
  const rows = candidates
    .map((c) => `${c.id} | ${c.txnDate} | ${c.merchant} | ${c.raw} | $${c.amount} | ${c.category}`)
    .join('\n')
  const counted = alreadyIn.length
    ? alreadyIn.map((p) => `- ${p.txnDate} | ${p.merchant} | $${p.amount} | ${p.why}`).join('\n')
    : '- (nothing counted yet)'

  return `You are auditing a Canadian family's bank/credit-card transactions to find what belongs in their "Camping ${year}" project. They camp at Ontario provincial parks, conservation-area campgrounds and private campgrounds, towing a trailer with a truck.

The project answers ONE question: what does the camping SETUP cost per year. So it contains only:
- FEE: a campground/park site booking, reservation, permit or seasonal fee (often paid months before the trip).
- GAS: a fuel fill for the tow vehicle from the day before a trip through its last day.

It must NOT contain: groceries, restaurants, firewood, ice, bait, souvenirs, camp-store or gas-station snacks, attractions, parking meters, city parking, day-use-only outings, gear purchases, or anything unrelated.

Their ${year} trips (from their RV trip app):
${tripLines}

Already counted in the project — never propose these again, and use them to judge the rest: if
a campground's booking is already here, the small charges at that same campground during the
trip are on-site extras, not fees.
${counted}

Candidate transactions — "id | date | merchant | statement line | amount | category":
${rows}

Rules:
- Only classify a row as FEE if the merchant really is a campground / park / conservation authority AND the amount looks like a site or reservation fee, not a $4 firewood tap.
- Charges under $100 at a park or campground DURING a trip are on-site extras (firewood, ice, camp store, day-use top-up) — skip them, even though the merchant is a campground.
- Only classify a row as GAS if it is a fuel purchase at a gas station within a trip window above.
- A merchant you don't recognise: it is fine to search the web to check whether it is an Ontario campground.
- When in doubt, skip it. A missed row is cheap; a wrong row pollutes a yearly total.

Return ONLY a JSON array of the rows that belong (omit everything you would skip):
[{"id": 123, "kind": "fee", "why": "Sherkston Shores is a private campground on Lake Erie"}]
"kind" is "fee" or "gas". "why" is at most 12 words. No markdown fences, no commentary.`
}

export type AiPick = { id: number; kind: 'fee' | 'gas'; why: string }

/**
 * Ask `claude -p` (Opus, high effort, WebSearch allowed so an unfamiliar
 * campground can actually be looked up) which candidates are camping.
 *
 * Best-effort by design: a failure here is logged and the deterministic picks
 * still get written. Only ids we actually offered are accepted back, so a
 * hallucinated id can never reach the database.
 */
export function aiSweep(
  year: number,
  trips: Trip[],
  candidates: Candidate[],
  alreadyIn: Pick[] = []
): AiPick[] {
  if (candidates.length === 0) return []
  const res = spawnSync(
    'claude',
    [
      '-p',
      prompt(year, trips, candidates, alreadyIn),
      '--model',
      'opus',
      '--effort',
      'high',
      '--output-format',
      'json',
      '--allowedTools',
      'WebSearch',
      '--permission-mode',
      'bypassPermissions',
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32, timeout: 20 * 60 * 1000 }
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

  const offered = new Map(candidates.map((c) => [c.id, c]))
  const out: AiPick[] = []
  for (const p of parsed as AiPick[]) {
    const id = Number(p.id)
    if (!offered.has(id) || (p.kind !== 'fee' && p.kind !== 'gas')) continue
    out.push({ id, kind: p.kind, why: typeof p.why === 'string' ? p.why.slice(0, 80) : '' })
  }
  return out
}

/** Total of a set of picks, for the run summary. */
export function total(picks: Pick[]): number {
  return picks.reduce((t, p) => t + p.amount, 0)
}

export const _internals = { shift, prompt }
