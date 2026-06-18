import { timingSafeEqual } from 'crypto'
import type { NextRequest } from 'next/server'

/**
 * Bearer-token auth shared by the local budget-sync runner and the server. The
 * token lives only in `process.env.INGEST_TOKEN` (set at server startup) and in
 * the runner's Keychain — never in the repo. Used by the token-authed routes
 * `/api/ingest` (POST a CSV) and `/api/digest` (GET the daily summary), both of
 * which `proxy.ts` whitelists past the session cookie.
 */
export function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization')
  if (header?.startsWith('Bearer ')) return header.slice(7)
  return req.headers.get('x-ingest-token')
}

export function ingestTokenOk(req: NextRequest): boolean {
  const expected = process.env.INGEST_TOKEN
  const presented = bearerToken(req)
  if (!expected || !presented) return false // fail closed if unconfigured
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on length mismatch; guard first (length isn't secret).
  return a.length === b.length && timingSafeEqual(a, b)
}
