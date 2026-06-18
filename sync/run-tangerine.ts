/**
 * Tangerine daily sync runner (AUTO_SYNC_PLAN.md §10). Mirrors run-rogers.ts.
 *
 * Thin wrapper: the orchestration lives in lib/runner.ts; this file just wires
 * in the Tangerine adapter and source key.
 *
 *   npx tsx sync/run-tangerine.ts             # headed (watch it work)
 *   npx tsx sync/run-tangerine.ts --headless  # headless
 *
 * Requires Keychain items (one-time):
 *   security add-generic-password -a "tangerine" -s "budget-sync-tangerine"      -w  # password
 *   security add-generic-password -a "tangerine" -s "budget-sync-tangerine-user" -w  # login ID
 *   security add-generic-password -a "ingest"    -s "budget-sync-ingest"         -w
 * And (for a deployed app) INGEST_URL=https://your-app/api/ingest.
 */
import { runSync } from './lib/runner'
import { tangerine } from './adapters/tangerine'

runSync('tangerine', 'Tangerine', tangerine, process.argv.includes('--headless')).catch((err) => {
  console.error('\n✗ run failed:', err.message)
  process.exit(1)
})
