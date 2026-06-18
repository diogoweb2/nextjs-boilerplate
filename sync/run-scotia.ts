/**
 * Scotiabank daily sync runner (AUTO_SYNC_PLAN.md §10). Mirrors run-rogers.ts.
 *
 * Thin wrapper: the orchestration lives in lib/runner.ts; this file just wires
 * in the Scotia adapter and source key.
 *
 *   npx tsx sync/run-scotia.ts             # headed (watch it work)
 *   npx tsx sync/run-scotia.ts --headless  # headless
 *
 * Requires Keychain items (one-time):
 *   security add-generic-password -a "scotia" -s "budget-sync-scotia"      -w  # password
 *   security add-generic-password -a "scotia" -s "budget-sync-scotia-user" -w  # username/card #
 *   security add-generic-password -a "ingest" -s "budget-sync-ingest"      -w
 * And (for a deployed app) INGEST_URL=https://your-app/api/ingest.
 */
import { runSync } from './lib/runner'
import { scotia } from './adapters/scotia'

runSync('scotia', 'Scotia', scotia, process.argv.includes('--headless')).catch((err) => {
  console.error('\n✗ run failed:', err.message)
  process.exit(1)
})
