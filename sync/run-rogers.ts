/**
 * Rogers daily sync runner (AUTO_SYNC_PLAN.md §10, phases 1–2 + scheduling).
 *
 * Thin wrapper: the orchestration lives in lib/runner.ts; this file just wires
 * in the Rogers adapter and source key.
 *
 *   npx tsx sync/run-rogers.ts             # headed (watch it work)
 *   npx tsx sync/run-rogers.ts --headless  # headless
 *
 * Requires Keychain items (one-time):
 *   security add-generic-password -a "rogers" -s "budget-sync-rogers"      -w
 *   security add-generic-password -a "rogers" -s "budget-sync-rogers-user" -w
 *   security add-generic-password -a "ingest" -s "budget-sync-ingest"      -w
 * And (for a deployed app) INGEST_URL=https://your-app/api/ingest.
 */
import { runSync } from './lib/runner'
import { rogers } from './adapters/rogers'

runSync('rogers', 'Rogers', rogers, process.argv.includes('--headless')).catch((err) => {
  console.error('\n✗ run failed:', err.message)
  process.exit(1)
})
