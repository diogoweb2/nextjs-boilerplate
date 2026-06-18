/**
 * Daily-digest runner. Fires AFTER the day's card syncs (via launchd) and asks
 * the app to **Web Push** a budget summary — sync health, new spend, month pace,
 * and anything unusual — to every subscribed device (your Android phone, desktop
 * Chrome). You get a "go check the site" nudge with no tab open.
 *
 * It POSTs the app's /api/digest, which computes the digest AND sends the push
 * server-side (the VAPID private key + subscriptions live there). This runner
 * just triggers it and logs the result; a local macOS banner is fired only if the
 * trigger itself fails, so a broken pipeline still surfaces on the Mac.
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

type DigestResponse = {
  title?: string
  body?: string
  error?: string
  push?: { sent: number; failed: number }
}

function digestUrl(): string {
  if (process.env.DIGEST_URL) return process.env.DIGEST_URL
  if (process.env.INGEST_URL) return process.env.INGEST_URL.replace(/\/ingest\/?$/, '/digest')
  return 'http://localhost:3000/api/digest'
}

async function main(): Promise<void> {
  const token = readSecret('budget-sync-ingest', 'ingest')
  const url = digestUrl()

  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  const json = (await res.json().catch(() => null)) as DigestResponse | null

  if (!res.ok || !json?.title) {
    const reason = json?.error ?? `${res.status} ${res.statusText}`
    throw new Error(`digest endpoint error: ${reason}`)
  }

  const { sent = 0, failed = 0 } = json.push ?? {}
  console.log(`${json.title}\n${json.body ?? ''}`)
  console.log(`\n→ pushed to ${sent} device(s)${failed ? `, ${failed} failed` : ''}`)
  if (sent === 0) {
    console.log('  (no subscribed devices — enable notifications in Settings on your phone)')
  }
}

main().catch((err) => {
  console.error('\n✗ digest failed:', err.message)
  // Surface the failure itself — a silent digest is the thing we're guarding against.
  notify('Budget digest FAILED', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
