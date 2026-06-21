import { revalidatePath } from 'next/cache'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { syncRuns } from '@/db/schema'
import { ingestTokenOk } from '@/app/lib/apiToken'

/**
 * Token-authed health endpoint for the budget-sync runner. After every run the
 * runner POSTs `{ source, status: 'ok' | 'fail', error? }` here so the dashboard
 * can show *which* bank failed and when it last worked — instead of inferring it
 * 3 days later from import staleness.
 *
 * Same bearer-token auth as /api/ingest (proxy.ts whitelists it). Upserts the
 * single row per source: on 'ok' we stamp lastSuccessAt and clear the error/
 * counter; on 'fail' we keep the prior lastSuccessAt and bump failureCount.
 */
const SOURCES = ['master', 'amex', 'tangerine', 'scotia'] as const
type Source = (typeof SOURCES)[number]

export async function POST(request: NextRequest): Promise<Response> {
  if (!process.env.INGEST_TOKEN) {
    return Response.json({ ok: false, error: 'Endpoint not configured.' }, { status: 503 })
  }
  if (!ingestTokenOk(request)) {
    return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as {
    source?: string
    status?: string
    error?: string
  } | null

  const source = body?.source
  const status = body?.status
  if (!source || !SOURCES.includes(source as Source)) {
    return Response.json({ ok: false, error: 'Unknown or missing source.' }, { status: 400 })
  }
  if (status !== 'ok' && status !== 'fail') {
    return Response.json({ ok: false, error: 'status must be "ok" or "fail".' }, { status: 400 })
  }

  const now = new Date()
  const error = status === 'fail' ? (body?.error ?? 'Sync failed.').slice(0, 1000) : null

  await db
    .insert(syncRuns)
    .values({
      source: source as Source,
      status,
      lastRunAt: now,
      lastSuccessAt: status === 'ok' ? now : null,
      error,
      failureCount: status === 'fail' ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: syncRuns.source,
      set: {
        status,
        lastRunAt: now,
        // Preserve the prior success time on failure; stamp it fresh on success.
        lastSuccessAt: status === 'ok' ? now : syncRuns.lastSuccessAt,
        error,
        failureCount:
          status === 'ok' ? sql`0` : sql`${syncRuns.failureCount} + 1`,
      },
    })

  // Reflect the new health on the dashboard without waiting for the next deploy.
  revalidatePath('/')
  return Response.json({ ok: true }, { status: 200 })
}
