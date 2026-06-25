import { readFileSync } from 'fs'
import { basename } from 'path'
import { readSecret } from './keychain'

/**
 * POST a downloaded CSV to the app's token-authed ingest endpoint
 * (app/api/ingest). The token comes from Keychain (never a file); the URL
 * defaults to the local dev server and is overridable for a deployed app.
 *
 *   security add-generic-password -a "ingest" -s "budget-sync-ingest" -w
 *   # optional: export INGEST_URL=https://your-app.vercel.app/api/ingest
 */
export type IngestResult =
  | { ok: true; source: string; inserted: number; skipped: number; period: string }
  | { ok: false; error: string }

export async function postCsv(filePath: string, source: string): Promise<IngestResult> {
  const token = readSecret('budget-sync-ingest', 'ingest')
  const base = process.env.INGEST_URL ?? 'http://localhost:3000/api/ingest'
  const url = `${base}?source=${encodeURIComponent(source)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/csv',
      'x-filename': basename(filePath),
    },
    body: readFileSync(filePath, 'utf8'),
  })

  const json = (await res.json().catch(() => null)) as IngestResult | null
  if (!json) {
    throw new Error(`Ingest endpoint returned ${res.status} with a non-JSON body.`)
  }
  return json
}

export type HoldingsIngestResult =
  | { ok: true; positions: number; totalValueCad: number; fxUsdCad: number; fxLive: boolean }
  | { ok: false; error: string }

/**
 * POST a downloaded iTrade HOLDINGS CSV to /api/ingest-holdings, tagged with the
 * brokerage `account` number so the snapshot lands in the right registered
 * account. Same bearer token as postCsv; the URL is derived from INGEST_URL's host
 * (swapping /api/ingest → /api/ingest-holdings) so there's no extra env to set.
 */
export async function postHoldingsCsv(filePath: string, account: string): Promise<HoldingsIngestResult> {
  const token = readSecret('budget-sync-ingest', 'ingest')
  const ingest = process.env.INGEST_URL ?? 'http://localhost:3000/api/ingest'
  const base = ingest.replace(/\/api\/ingest\b.*$/, '/api/ingest-holdings')
  const url = `${base}?account=${encodeURIComponent(account)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/csv',
      'x-filename': basename(filePath),
    },
    body: readFileSync(filePath, 'utf8'),
  })

  const json = (await res.json().catch(() => null)) as HoldingsIngestResult | null
  if (!json) {
    throw new Error(`Holdings ingest endpoint returned ${res.status} with a non-JSON body.`)
  }
  return json
}
