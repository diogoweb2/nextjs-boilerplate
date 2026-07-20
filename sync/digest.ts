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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readSecret } from './lib/keychain'
import { notify } from './lib/notify'

const STATUS_DIR = join(homedir(), 'Library', 'Application Support', 'budget-sync', 'status')
const STATUS_SOURCES = [
  { key: 'rogers', label: 'Rogers' },
  { key: 'amex', label: 'Amex' },
  { key: 'scotia', label: 'Scotia' },
  { key: 'tangerine', label: 'Tangerine' },
]
// Only consider status files written in the last 4 hours — avoids yesterday's failures.
const STALE_MS = 4 * 60 * 60 * 1000

// Once-per-day marker for the "sync failed" nudge, so repeated per-sync triggers
// don't banner more than once. Stored next to the status files as YYYY-MM-DD.
const NUDGE_FILE = join(STATUS_DIR, 'digest-nudge')

function nudgedToday(): boolean {
  try {
    return readFileSync(NUDGE_FILE, 'utf8').trim() === today()
  } catch {
    return false
  }
}

function markNudgedToday(): void {
  try {
    mkdirSync(STATUS_DIR, { recursive: true })
    writeFileSync(NUDGE_FILE, today())
  } catch {
    /* best-effort; a missed marker just risks one extra banner */
  }
}

function today(): string {
  return new Date().toLocaleDateString('en-CA') // YYYY-MM-DD, local
}

function readSyncStatus(key: string): 'ok' | 'fail' | null {
  const file = join(STATUS_DIR, key)
  if (!existsSync(file)) return null
  try {
    if (Date.now() - statSync(file).mtimeMs > STALE_MS) return null
    const content = readFileSync(file, 'utf8').trim()
    return content === 'ok' ? 'ok' : content === 'fail' ? 'fail' : null
  } catch {
    return null
  }
}

type DigestResponse = {
  title?: string
  body?: string
  error?: string
  push?: { sent: number; failed: number; skipped?: boolean }
  // Monthly recap path: returned instead of title/body when a prior month is final.
  monthReport?: boolean
  ym?: string
  note?: { title: string; body: string; url?: string }
}

function digestUrl(): string {
  if (process.env.DIGEST_URL) return process.env.DIGEST_URL
  if (process.env.INGEST_URL) return process.env.INGEST_URL.replace(/\/ingest\/?$/, '/digest')
  return 'http://localhost:3000/api/digest'
}

async function main(): Promise<void> {
  const token = readSecret('budget-sync-ingest', 'ingest')
  const url = digestUrl()

  const failedSources = STATUS_SOURCES
    .filter(({ key }) => readSyncStatus(key) === 'fail')
    .map(({ label }) => label)

  if (failedSources.length > 0) {
    console.log(`⚠️  failed syncs detected: ${failedSources.join(', ')}`)
  }

  // Gate: only send the digest once ALL 4 accounts have a fresh "ok" sync. If any
  // is failed, missing, or stale, stay quiet — the next scheduled run (or a re-run
  // after the sync catches up) will push once the day's imports are complete.
  const notReady = STATUS_SOURCES
    .filter(({ key }) => readSyncStatus(key) !== 'ok')
    .map(({ label }) => label)

  if (notReady.length > 0) {
    console.log(`→ digest skipped: waiting on all accounts to sync (${notReady.join(', ')} not ready)`)
    // Nudge only when a sync actually FAILED today (not merely "hasn't run yet"),
    // and only once per day — otherwise every early per-sync trigger would banner.
    if (failedSources.length > 0 && !nudgedToday()) {
      notify('Budget digest skipped', `No daily push — sync failed: ${failedSources.join(', ')}`)
      markNudgedToday()
    }
    return
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ failedSources }),
  })
  const json = (await res.json().catch(() => null)) as DigestResponse | null

  if (!res.ok) {
    const reason = json?.error ?? `${res.status} ${res.statusText}`
    throw new Error(`digest endpoint error: ${reason}`)
  }
  if (!json?.title && !json?.monthReport) {
    throw new Error(`digest endpoint error: unexpected response (no title or monthReport)`)
  }

  const { sent = 0, failed = 0, skipped = false } = json.push ?? {}
  if (json.monthReport && json.note) {
    console.log(`[Monthly recap — ${json.ym}] ${json.note.title}\n${json.note.body ?? ''}`)
  } else {
    console.log(`${json.title}\n${json.body ?? ''}`)
  }
  if (skipped) {
    console.log('\n→ push skipped (failed syncs, no new transactions, or already sent today)')
  } else {
    console.log(`\n→ pushed to ${sent} device(s)${failed ? `, ${failed} failed` : ''}`)
    if (sent === 0) {
      console.log('  (no subscribed devices — enable notifications in Settings on your phone)')
    }
  }
}

main().catch((err) => {
  console.error('\n✗ digest failed:', err.message)
  // Surface the failure itself — a silent digest is the thing we're guarding against.
  notify('Budget digest FAILED', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
