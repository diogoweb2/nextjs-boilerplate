/**
 * Camping 2025 / Camping 2026 projects — "what does the camping setup cost me a year?"
 *
 *   npx dotenv -e .env.local -- tsx scripts/camping-projects.ts            # dry run
 *   npx dotenv -e .env.local -- tsx scripts/camping-projects.ts --apply    # write
 *
 * Creates (or refreshes) one project per camping season and fills it with three
 * kinds of transaction, and nothing else — on-trip food / firewood / fun is
 * deliberately excluded, because the question is the *setup* cost (truck + trailer
 * + storage), not the holiday:
 *
 *  1. FEES — campground and Ontario Parks charges, counted in the SEASON THEY ARE
 *     FOR, not when they were paid (bookings go out months ahead: the two
 *     2025-12-28 Ontario Parks charges are 2026 camping). Season window for year
 *     Y is [Y-1-11-01, Y-10-31]. Small on-site charges at a park we already paid
 *     a booking for (firewood, ice, day-use top-ups) are filtered by a $100 floor;
 *     every Ontario Parks reservation-system charge counts, including the $8.50
 *     fees and refunds.
 *  2. GAS — every fill of $20+ from the day before a trip starts through its last
 *     day. That is the "tank to get there + tank to get home" the owner asked for,
 *     widened by a day because the departure fill often posts on day 1. The $20
 *     floor drops gas-station snack/variety-store taps.
 *  3. STORAGE — the $111.87/month Interac e-transfer that parks the trailer
 *     (confirmed by the "trailer" note on the recent ones), on a cash basis.
 *
 * Trip dates come from the RV trips app (Firestore project `rv-groceries`), which
 * only starts in July 2026. Earlier trips were reconstructed from the statements
 * themselves — campground charges plus the local groceries/restaurants around them
 * — and are marked `inferred` below.
 *
 * Re-running is safe and is how a later import (e.g. the Presqu'ile trip) gets
 * pulled in: memberships are inserted with ON CONFLICT DO NOTHING, so a row the
 * owner removed in the app (which leaves a `dismissed` tombstone) is never
 * resurrected, and nothing is ever duplicated.
 */
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { projects, projectTransactions } from '../db/schema'

type Trip = { start: string; end: string; where: string; source: 'app' | 'inferred' }

type Season = {
  year: number
  emoji: string
  color: string
  trips: Trip[]
  notes: string
}

const SEASONS: Season[] = [
  {
    year: 2025,
    emoji: '🏕️',
    color: '#f59e0b',
    trips: [
      { start: '2025-06-13', end: '2025-06-15', where: 'Meaford / Thornbury area', source: 'inferred' },
      { start: '2025-07-18', end: '2025-07-20', where: 'Windmill Point Park', source: 'inferred' },
      { start: '2025-09-05', end: '2025-09-07', where: 'Bass Lake PP', source: 'inferred' },
      { start: '2025-09-12', end: '2025-09-14', where: "Fisherman's Cove, Tobermory", source: 'inferred' },
    ],
    notes:
      'Yearly cost of the camping setup: park/campground fees (counted in the season they are for, not when paid), the fill-up leaving and the one coming home for each trip, and the $111.87/mo trailer storage. On-trip food, firewood and fun are deliberately left out. The trips app only has 2026, so 2025 dates were reconstructed from the statements: Jun 13-15 Meaford area, Jul 18-20 Windmill Point, Sep 5-7 Bass Lake, Sep 12-14 Fisherman’s Cove. Priced at 2026’s gas rate (~$153/trip) those four trips would be ~$611 instead of the ~$397 actually spent — 2025 was closer to home and mostly pre-trailer (storage starts Aug 2025).',
  },
  {
    year: 2026,
    emoji: '🏕️',
    color: '#0ea5e9',
    trips: [
      { start: '2026-05-15', end: '2026-05-18', where: 'Killbear PP', source: 'inferred' },
      { start: '2026-07-03', end: '2026-07-05', where: 'Meaford Memorial Park', source: 'app' },
      { start: '2026-07-10', end: '2026-07-12', where: 'Windmill Point Park & Campground', source: 'app' },
      { start: '2026-08-14', end: '2026-08-17', where: 'Albion Hills', source: 'app' },
      { start: '2026-08-28', end: '2026-08-31', where: 'Arrowhead PP', source: 'app' },
      { start: '2026-09-04', end: '2026-09-07', where: 'The Ponderosa', source: 'app' },
      { start: '2026-09-11', end: '2026-09-14', where: "Presqu'ile PP", source: 'app' },
    ],
    notes:
      'Yearly cost of the camping setup: park/campground fees (counted in the season they are for — which is why the Dec-2025 Ontario Parks bookings sit here), the fill-up leaving and the one coming home for each trip, and the $111.87/mo trailer storage. On-trip food, firewood and fun are deliberately left out. Trips come from the RV trips app, plus Killbear May 15-18 reconstructed from charges; the Jun 27 Sibbald Point charge was left out as day use. Presqu’ile Sep 11-14 is booked but its gas has not been imported yet — re-run scripts/camping-projects.ts after the next statement sync to pull it in.',
  },
]

/** Gas stations, cross-checked against the Cars category so "Mobile Klinik" etc. can't sneak in. */
const GAS_RE = 'petro-?can|costco gas|circle k|^esso|shell canada|ultramar|husky|pioneer|canadian tire gas|^mobil( |$)|gas and|flying j|macewen'
/** Campgrounds, provincial parks and conservation authorities we have actually paid. */
const CAMP_RE =
  'ontario parks reservation|windmill point|the ponderosa|toronto and region conservation|fisherman.s cove|albion hills|arrowhead provincial|killbear provincial|bass lake provincial|sibbald point|presqu'
/** A booking is three digits; anything smaller at a park is firewood/ice/day-use. */
const FEE_FLOOR = 100
/** A tow-vehicle fill; anything smaller at a pump is a snack or a variety-store tap. */
const GAS_FLOOR = 20
const STORAGE_AMOUNT = '111.87'

type Row = { id: number; txnDate: string; merchant: string; amount: number; why: string }

async function pick(season: Season): Promise<Row[]> {
  const { year } = season
  const feeFrom = `${year - 1}-11-01`
  const feeTo = `${year}-10-31`

  const fees: any = await db.execute(sql`
    select t.id, t.txn_date, m.name, t.amount::float as amount
    from transactions t join merchants m on m.id = t.merchant_id
    where t.txn_date between ${feeFrom} and ${feeTo}
      and m.name ~* ${CAMP_RE}
      and (m.name ilike 'ontario parks%' or abs(t.amount) >= ${FEE_FLOOR})
    order by t.txn_date`)

  const storage: any = await db.execute(sql`
    select t.id, t.txn_date, m.name, t.amount::float as amount
    from transactions t join merchants m on m.id = t.merchant_id
    where t.txn_date between ${`${year}-01-01`} and ${`${year}-12-31`}
      and m.name = 'E-Transfer Out' and t.amount = ${STORAGE_AMOUNT}
    order by t.txn_date`)

  const out: Row[] = []
  const seen = new Set<number>()
  const add = (r: any, why: string) => {
    if (seen.has(r.id)) return
    seen.add(r.id)
    out.push({ id: r.id, txnDate: r.txn_date, merchant: r.name, amount: r.amount, why })
  }

  for (const r of fees.rows ?? fees) add(r, 'fee')
  for (const r of storage.rows ?? storage) add(r, 'storage')

  for (const trip of season.trips) {
    const from = new Date(`${trip.start}T00:00:00Z`)
    from.setUTCDate(from.getUTCDate() - 1)
    const gas: any = await db.execute(sql`
      select t.id, t.txn_date, m.name, t.amount::float as amount
      from transactions t join merchants m on m.id = t.merchant_id
      left join categories c on c.id = coalesce(t.category_id, m.category_id)
      where t.txn_date between ${from.toISOString().slice(0, 10)} and ${trip.end}
        and c.name = 'Cars' and m.name ~* ${GAS_RE} and t.amount >= ${GAS_FLOOR}
      order by t.txn_date`)
    for (const r of gas.rows ?? gas) add(r, `gas · ${trip.where}`)
  }

  return out.sort((a, b) => a.txnDate.localeCompare(b.txnDate))
}

async function upsertProject(season: Season) {
  const name = `Camping ${season.year}`
  const start = season.trips[0].start
  const end = season.trips[season.trips.length - 1].end
  const existing = await db.select().from(projects).where(eq(projects.name, name))
  if (existing.length) {
    await db
      .update(projects)
      .set({ startDate: start, endDate: end, notes: season.notes })
      .where(eq(projects.id, existing[0].id))
    return existing[0].id
  }
  const [row] = await db
    .insert(projects)
    .values({
      name,
      emoji: season.emoji,
      color: season.color,
      startDate: start,
      endDate: end,
      notes: season.notes,
      autoFill: null, // manual-only: never hoover up every card charge in the window
    })
    .returning({ id: projects.id })
  return row.id
}

async function main() {
  const apply = process.argv.includes('--apply')
  for (const season of SEASONS) {
    const rows = await pick(season)
    const sum = (w: string) =>
      rows.filter((r) => r.why.startsWith(w)).reduce((t, r) => t + r.amount, 0)
    console.log(`\n=== Camping ${season.year} — ${rows.length} transactions ===`)
    for (const r of rows)
      console.log(
        `  ${r.txnDate}  ${String(r.amount).padStart(8)}  ${r.merchant.padEnd(42)} ${r.why}`
      )
    console.log(
      `  fees $${sum('fee').toFixed(2)} · gas $${sum('gas').toFixed(2)} · storage $${sum(
        'storage'
      ).toFixed(2)} · TOTAL $${rows.reduce((t, r) => t + r.amount, 0).toFixed(2)}`
    )
    if (!apply) continue
    const projectId = await upsertProject(season)
    let added = 0
    for (const r of rows) {
      const res = await db
        .insert(projectTransactions)
        .values({ projectId, transactionId: r.id })
        .onConflictDoNothing()
        .returning({ id: projectTransactions.id })
      if (res.length) added++
    }
    const kept = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(projectTransactions)
      .where(
        and(eq(projectTransactions.projectId, projectId), eq(projectTransactions.dismissed, false))
      )
    console.log(`  → project #${projectId}: ${added} added, ${kept[0].n} members total`)
  }
  if (!apply) console.log('\nDry run. Re-run with --apply to write.')
}

main()
