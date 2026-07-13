import type { NextRequest } from 'next/server'
import { ingestTokenOk } from '@/app/lib/apiToken'
import { buildDigest, runDailyDigestJob } from '@/app/lib/digest'
import { buildMonthReport } from '@/app/lib/monthReport'
import { buildYearReport } from '@/app/lib/yearReport'

/**
 * Token-authed daily-digest endpoint for the budget-sync runner.
 *
 * The local `sync/digest.ts` job (launchd, just after the day's card syncs) hits
 * this. Auth is the same bearer token as /api/ingest (shared Keychain item), so
 * `proxy.ts` whitelists it.
 *
 *  - GET             → compute and return the daily digest (dry-run / debugging).
 *  - GET ?month=YYYY-MM → return the monthly recap JSON for that month (preview, no push).
 *  - POST            → daily push. Once a newer month has transactions (so the
 *                      prior month is final — no pending charges can predate them)
 *                      it instead pushes that month's recap (once, deduped) and
 *                      skips the daily digest. Every attempt (success or failure)
 *                      is recorded to `digest_runs` — see runDailyDigestJob — so a
 *                      500 here surfaces on the dashboard (NotificationBell)
 *                      instead of only in the local launchd log.
 */
export const dynamic = 'force-dynamic'

function authProblem(request: NextRequest): Response | null {
  if (!process.env.INGEST_TOKEN) {
    return Response.json({ error: 'Digest endpoint not configured.' }, { status: 503 })
  }
  if (!ingestTokenOk(request)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  return null
}

export async function GET(request: NextRequest): Promise<Response> {
  const problem = authProblem(request)
  if (problem) return problem

  const params = new URL(request.url).searchParams
  const month = params.get('month')
  if (month) {
    return Response.json(await buildMonthReport(month), { status: 200 })
  }
  const year = params.get('year')
  if (year) {
    return Response.json(await buildYearReport(year), { status: 200 })
  }

  const digest = await buildDigest()
  return Response.json(digest, { status: 200 })
}

export async function POST(request: NextRequest): Promise<Response> {
  const problem = authProblem(request)
  if (problem) return problem

  const body = (await request.json().catch(() => ({}))) as { failedSources?: unknown }
  const failedSources = Array.isArray(body.failedSources)
    ? (body.failedSources as unknown[]).filter((s): s is string => typeof s === 'string')
    : []

  try {
    const result = await runDailyDigestJob(failedSources)
    return Response.json(result, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Digest failed.'
    return Response.json({ error: message }, { status: 500 })
  }
}
