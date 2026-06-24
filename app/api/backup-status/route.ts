import { revalidatePath } from 'next/cache'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { backupRuns } from '@/db/schema'
import { ingestTokenOk } from '@/app/lib/apiToken'

/**
 * Token-authed health endpoint for the database backup job (sync/backup). After
 * each run the backup script POSTs `{ status: 'ok' | 'fail', filename?,
 * sizeBytes?, error? }` here so the dashboard can warn when backups have gone
 * stale (no success in >2 weeks → BackupStatusBanner).
 *
 * Same bearer-token auth as /api/ingest + /api/sync-status (proxy.ts whitelists
 * it). Unlike sync_runs this is append-only history: every run inserts a fresh
 * row, and the dashboard reads the most recent successful one.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!process.env.INGEST_TOKEN) {
    return Response.json({ ok: false, error: 'Endpoint not configured.' }, { status: 503 })
  }
  if (!ingestTokenOk(request)) {
    return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as {
    status?: string
    filename?: string
    sizeBytes?: number
    error?: string
  } | null

  const status = body?.status
  if (status !== 'ok' && status !== 'fail') {
    return Response.json({ ok: false, error: 'status must be "ok" or "fail".' }, { status: 400 })
  }

  const now = new Date()
  const error = status === 'fail' ? (body?.error ?? 'Backup failed.').slice(0, 1000) : null

  await db.insert(backupRuns).values({
    status,
    lastRunAt: now,
    lastSuccessAt: status === 'ok' ? now : null,
    filename: body?.filename ?? null,
    sizeBytes: typeof body?.sizeBytes === 'number' ? body.sizeBytes : null,
    error,
  })

  // Clear/raise the staleness banner without waiting for the next deploy.
  revalidatePath('/')
  return Response.json({ ok: true }, { status: 200 })
}
