import { readSecret } from './keychain'

/**
 * Report a run's outcome to the app's token-authed /api/sync-status endpoint, so
 * the dashboard can show which bank failed and when it last worked. Best-effort:
 * a reporting failure must never mask the real sync error, so this never throws.
 *
 * The URL is derived from INGEST_URL (same host as the CSV ingest), defaulting
 * to the local dev server — so no extra env var to configure.
 */
function statusUrl(): string {
  const ingest = process.env.INGEST_URL ?? 'http://localhost:3000/api/ingest'
  return ingest.replace(/\/api\/ingest\b.*$/, '/api/sync-status')
}

export async function reportSyncStatus(
  source: string,
  status: 'ok' | 'fail',
  error?: string
): Promise<void> {
  try {
    const token = readSecret('budget-sync-ingest', 'ingest')
    const res = await fetch(statusUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source, status, error }),
    })
    if (!res.ok) {
      console.error(`  (sync-status report returned ${res.status})`)
    }
  } catch (err) {
    console.error(`  (sync-status report failed: ${err instanceof Error ? err.message : String(err)})`)
  }
}
