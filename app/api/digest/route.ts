import type { NextRequest } from 'next/server'
import { ingestTokenOk } from '@/app/lib/apiToken'
import { buildDigest } from '@/app/lib/digest'

/**
 * Token-authed daily-digest endpoint for the budget-sync runner.
 *
 * The local `sync/digest.ts` job (launchd, just after the day's card syncs) GETs
 * this and fires a native macOS notification with `title`/`body` — a glanceable
 * "go check the site" nudge that works with no browser open. Auth is the same
 * bearer token as /api/ingest (shared Keychain item), so `proxy.ts` whitelists it.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<Response> {
  if (!process.env.INGEST_TOKEN) {
    return Response.json({ error: 'Digest endpoint not configured.' }, { status: 503 })
  }
  if (!ingestTokenOk(request)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const digest = await buildDigest()
  return Response.json(digest, { status: 200 })
}
