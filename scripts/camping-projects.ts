/**
 * Camping 2025 / Camping 2026 backfill — the one-off seed for the yearly
 * "what does the camping setup cost me?" projects.
 *
 *   npx dotenv -e .env.local -- tsx scripts/camping-projects.ts            # dry run
 *   npx dotenv -e .env.local -- tsx scripts/camping-projects.ts --apply    # write
 *
 * From here on the monthly job (`sync/camping.ts`, run by the LaunchAgent) keeps
 * the current year's project up to date using trips from the RV app. This script
 * exists because that app's trip history only starts in July 2026 — every trip
 * below that is marked `inferred` was reconstructed from the statements
 * themselves (campground charges plus the local groceries and restaurants around
 * them), and nothing else in the repo remembers them.
 *
 * What goes in a season and why lives in sync/lib/camping.ts, shared with the
 * monthly job so the two can't drift. Re-running is safe: memberships insert
 * with ON CONFLICT DO NOTHING, so a row removed in the app (a `dismissed`
 * tombstone) is never resurrected and nothing is duplicated.
 */
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { projects } from '../db/schema'
import { addMembers, pickSeason, total, type Trip } from '../sync/lib/camping'

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
      'Yearly cost of the camping setup: park/campground fees (counted in the season they are for — which is why the Dec-2025 Ontario Parks bookings sit here), the fill-up leaving and the one coming home for each trip, and the $111.87/mo trailer storage. On-trip food, firewood and fun are deliberately left out. Trips come from the RV trips app, plus Killbear May 15-18 reconstructed from charges; the Jun 27 Sibbald Point charge was left out as day use. A monthly job (sync/camping.ts) keeps this refreshed as new trips and statements land.',
  },
]

async function upsertProject(season: Season): Promise<number> {
  const name = `Camping ${season.year}`
  const start = season.trips[0].start
  const end = season.trips[season.trips.length - 1].end
  const [existing] = await db.select().from(projects).where(eq(projects.name, name))
  if (existing) {
    await db
      .update(projects)
      .set({ startDate: start, endDate: end, notes: season.notes })
      .where(eq(projects.id, existing.id))
    return existing.id
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
    const rows = await pickSeason(season.year, season.trips)
    const sum = (w: string) => total(rows.filter((r) => r.why.startsWith(w)))
    console.log(`\n=== Camping ${season.year} — ${rows.length} transactions ===`)
    for (const r of rows)
      console.log(`  ${r.txnDate}  ${String(r.amount).padStart(8)}  ${r.merchant.padEnd(42)} ${r.why}`)
    console.log(
      `  fees $${sum('fee').toFixed(2)} · gas $${sum('gas').toFixed(2)} · storage $${sum(
        'storage'
      ).toFixed(2)} · TOTAL $${total(rows).toFixed(2)}`
    )
    if (!apply) continue
    const projectId = await upsertProject(season)
    const added = await addMembers(projectId, rows)
    console.log(`  → project #${projectId}: ${added.length} added`)
  }
  if (!apply) console.log('\nDry run. Re-run with --apply to write.')
}

main()
