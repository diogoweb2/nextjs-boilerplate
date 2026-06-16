import { revalidatePath } from 'next/cache'
import { timingSafeEqual } from 'crypto'
import type { NextRequest } from 'next/server'
import { ingestStatement } from '@/app/actions/import'
import type { ImportSource } from '@/app/lib/csv'

/**
 * Token-authed ingest endpoint for the budget-sync runner (AUTO_SYNC_PLAN.md §9).
 *
 * The sync runner on the Mac downloads a bank/card CSV and POSTs it here instead
 * of clicking the upload UI. It reuses `ingestStatement` — the exact same parse,
 * merchant/category resolution, and **dedup** path as the manual upload — so
 * re-posting the same CSV (e.g. several runs in one day) inserts 0 duplicates:
 * `ingestStatement` ends in `onConflictDoNothing({ target: externalId })`.
 *
 * Auth is a bearer token (NOT the session cookie), so `proxy.ts` whitelists this
 * route. The token lives only in `process.env.INGEST_TOKEN` (set at server
 * startup) and in the runner's Keychain — never in the repo.
 */

const IMPORT_SOURCES: ImportSource[] = ['master', 'amex', 'tangerine', 'scotia']

function tokenOk(presented: string | null): boolean {
  const expected = process.env.INGEST_TOKEN
  if (!expected || !presented) return false // fail closed if unconfigured
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on length mismatch; guard first (length isn't secret).
  return a.length === b.length && timingSafeEqual(a, b)
}

function bearer(req: NextRequest): string | null {
  const header = req.headers.get('authorization')
  if (header?.startsWith('Bearer ')) return header.slice(7)
  return req.headers.get('x-ingest-token')
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!process.env.INGEST_TOKEN) {
    return Response.json({ ok: false, error: 'Ingest endpoint not configured.' }, { status: 503 })
  }
  if (!tokenOk(bearer(request))) {
    return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 })
  }

  // Optional source hint (?source=master); ingestStatement also auto-detects and
  // errors loudly on a mismatch.
  const hint = request.nextUrl.searchParams.get('source')
  const expected =
    hint && IMPORT_SOURCES.includes(hint as ImportSource) ? (hint as ImportSource) : undefined
  const filename = request.headers.get('x-filename') ?? 'sync-upload.csv'

  const text = await request.text()
  if (!text.trim()) {
    return Response.json({ ok: false, error: 'Empty body.' }, { status: 400 })
  }

  const result = await ingestStatement(text, filename, expected)
  if (!result.ok) {
    return Response.json(result, { status: 400 })
  }

  // Same cache invalidation the manual upload triggers, so the UI reflects new rows.
  for (const path of ['/', '/trends', '/income', '/merchants', '/transactions']) {
    revalidatePath(path)
  }
  return Response.json(result, { status: 200 })
}
