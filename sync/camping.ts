/**
 * Monthly camping-project refresh.
 *
 *   npx dotenv -e .env.local -- tsx sync/camping.ts             # dry run
 *   npx dotenv -e .env.local -- tsx sync/camping.ts --apply     # write
 *   ... --year=2027   pin the season   ... --no-ai   skip the claude sweep
 *
 * What it does, once a month (see sync/camping.sh + the LaunchAgent):
 *  1. reads the trips the owner logged in the RV app (Firestore `rv-groceries`)
 *     for the current year — new trips, and trips that have now happened;
 *  2. makes sure the `Camping <year>` project exists (a new year gets a new
 *     project) and that its date window covers those trips;
 *  3. adds this season's fees, per-trip gas and trailer storage (rules and the
 *     reasoning behind them live in sync/lib/camping.ts);
 *  4. asks `claude -p` (Opus, high effort) to look over the transactions the
 *     rules did NOT claim, so a campground we have never paid before still gets
 *     picked up instead of silently missing from the year's total.
 *
 * Everything is additive and idempotent: a row the owner removed in the app is
 * tombstoned and never comes back, and nothing is ever duplicated. A transaction
 * the job adds by mistake is one "✕ Remove" away from being gone for good.
 *
 * Trips that were never logged in the RV app are the one gap: their fees are
 * still found (the AI sweep and the fee rules don't need a trip), but their gas
 * can't be — gas is scoped to trip windows. Log the trip in the app and the next
 * run picks the fills up.
 */
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { projects } from '../db/schema'
import { notify } from './lib/notify'
import {
  addMembers,
  aiSweep,
  knownTxnIds,
  loadCandidates,
  loadTripsFromRvApp,
  pickSeason,
  total,
  upsertSeasonProject,
  type Pick,
} from './lib/camping'

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

async function main() {
  const apply = flag('apply')
  const year = Number(arg('year') ?? new Date().getFullYear())
  const name = `Camping ${year}`
  console.log(`===== camping refresh · ${name} · ${apply ? 'APPLY' : 'dry run'} @ ${new Date().toISOString()} =====`)

  const trips = await loadTripsFromRvApp(year)
  console.log(`RV app: ${trips.length} trip(s) logged for ${year}`)
  for (const t of trips) console.log(`  ${t.start} → ${t.end}  ${t.where}`)

  // Resolve the project. Creating it is a write, so a dry run only looks.
  let projectId: number | null = null
  let created = false
  if (apply) {
    const r = await upsertSeasonProject(year, trips)
    projectId = r.id
    created = r.created
    console.log(created ? `→ created project #${projectId} "${name}"` : `→ project #${projectId} "${name}"`)
  } else {
    const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.name, name))
    projectId = p?.id ?? null
    console.log(projectId ? `→ project #${projectId} "${name}"` : `→ would create "${name}"`)
  }

  // Already a member, or tombstoned by the owner — either way, hands off.
  const known = projectId ? await knownTxnIds(projectId) : new Set<number>()

  const season = await pickSeason(year, trips)
  const fresh = season.filter((p) => !known.has(p.id))
  console.log(
    `\nrules: ${season.length} in scope, ${fresh.length} new` +
      ` (season total $${total(season).toFixed(2)})`
  )
  for (const p of fresh) console.log(`  + ${p.txnDate}  ${String(p.amount).padStart(8)}  ${p.merchant} — ${p.why}`)

  // The sweep only ever looks at what the rules left behind.
  const picks: Pick[] = [...fresh]
  if (!flag('no-ai')) {
    const seen = new Set([...known, ...season.map((p) => p.id)])
    const candidates = await loadCandidates(year, trips, seen)
    console.log(`\nclaude sweep: ${candidates.length} unclaimed candidate(s)…`)
    try {
      const byId = new Map(candidates.map((c) => [c.id, c]))
      for (const hit of aiSweep(year, trips, candidates, season)) {
        const c = byId.get(hit.id)!
        console.log(`  + ${c.txnDate}  ${String(c.amount).padStart(8)}  ${c.merchant} — ${hit.kind} · ${hit.why}`)
        picks.push({ id: c.id, txnDate: c.txnDate, merchant: c.merchant, amount: c.amount, why: `${hit.kind} · ai` })
      }
    } catch (err) {
      // A broken sweep must not fail the run — the deterministic picks are the
      // backbone, and next month's run sees the same candidates again.
      console.error(`  ! sweep skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!apply) {
    console.log(`\nDry run — ${picks.length} transaction(s) would be added. Re-run with --apply.`)
    return
  }

  const added = await addMembers(projectId!, picks)
  console.log(`\n✓ ${added.length} transaction(s) added to ${name} ($${total(added).toFixed(2)})`)
  if (created || added.length > 0) {
    notify(
      created ? `${name} created` : `${name} updated`,
      `${added.length} transaction${added.length === 1 ? '' : 's'} added · $${total(added).toFixed(2)}`
    )
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`✗ camping refresh failed: ${message}`)
  notify('Camping refresh failed', message.slice(0, 180))
  process.exit(1)
})
