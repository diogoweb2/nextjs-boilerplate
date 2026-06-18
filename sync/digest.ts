/**
 * Daily-digest runner. Fires AFTER the day's card syncs (via launchd) and pops a
 * single native macOS notification summarizing the budget — sync health, new
 * spend, month pace, and anything unusual — so you get a "go check the site"
 * nudge WITHOUT keeping a browser tab open.
 *
 * It just GETs the app's /api/digest (which does all the computing and returns a
 * ready-made title/body) and hands that to `notify()`. No browser, no Playwright.
 *
 *   npx tsx sync/digest.ts
 *
 * Requires the shared ingest token in Keychain (already set up for the syncs):
 *   security add-generic-password -a ingest -s budget-sync-ingest -w
 * And, for the deployed app, INGEST_URL (the digest URL is derived from it) or an
 * explicit DIGEST_URL override.
 */
import { readSecret } from './lib/keychain'
import { notify } from './lib/notify'

type DigestResponse = { title?: string; body?: string; error?: string }

function digestUrl(): string {
  if (process.env.DIGEST_URL) return process.env.DIGEST_URL
  if (process.env.INGEST_URL) return process.env.INGEST_URL.replace(/\/ingest\/?$/, '/digest')
  return 'http://localhost:3000/api/digest'
}

async function main(): Promise<void> {
  const token = readSecret('budget-sync-ingest', 'ingest')
  const url = digestUrl()

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const json = (await res.json().catch(() => null)) as DigestResponse | null

  if (!res.ok || !json?.title) {
    const reason = json?.error ?? `${res.status} ${res.statusText}`
    throw new Error(`digest endpoint error: ${reason}`)
  }

  console.log(`${json.title}\n${json.body ?? ''}`)
  notify(json.title, json.body ?? '')
}

main().catch((err) => {
  console.error('\n✗ digest failed:', err.message)
  // Surface the failure itself — a silent digest is the thing we're guarding against.
  notify('Budget digest FAILED', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
