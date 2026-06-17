/**
 * Amex daily sync runner (AUTO_SYNC_PLAN.md §10). Mirrors run-rogers.ts.
 *
 * Thin wrapper: the orchestration lives in lib/runner.ts; this file just wires
 * in the Amex adapter and source key.
 *
 *   npx tsx sync/run-amex.ts             # headed (watch it work)
 *   npx tsx sync/run-amex.ts --headless  # headless
 *
 * Requires Keychain items (one-time):
 *   security add-generic-password -a "amex" -s "budget-sync-amex"      -w
 *   security add-generic-password -a "amex" -s "budget-sync-amex-user" -w
 *   security add-generic-password -a "ingest" -s "budget-sync-ingest"  -w
 * And (for a deployed app) INGEST_URL=https://your-app/api/ingest.
 */
import { runSync } from './lib/runner'
import { amex } from './adapters/amex'

runSync('amex', 'Amex', amex, process.argv.includes('--headless')).catch((err) => {
  console.error('\n✗ run failed:', err.message)
  process.exit(1)
})
