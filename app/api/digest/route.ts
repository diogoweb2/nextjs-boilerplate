import type { NextRequest } from 'next/server'
import { ingestTokenOk } from '@/app/lib/apiToken'
import { buildDigest } from '@/app/lib/digest'
import { pushConfigured, sendPushToAll } from '@/app/lib/push'

/**
 * Token-authed daily-digest endpoint for the budget-sync runner.
 *
 * The local `sync/digest.ts` job (launchd, just after the day's card syncs) hits
 * this just after the day's card syncs. Auth is the same bearer token as
 * /api/ingest (shared Keychain item), so `proxy.ts` whitelists it.
 *
 *  - GET  → compute and return the digest (handy for a dry-run / debugging).
 *  - POST → compute it AND Web Push it to every subscribed device (the daily job).
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

  const digest = await buildDigest()
  return Response.json(digest, { status: 200 })
}

export async function POST(request: NextRequest): Promise<Response> {
  const problem = authProblem(request)
  if (problem) return problem

  const digest = await buildDigest()
  const hasNewData = digest.newSpend.count > 0
  const push =
    hasNewData && pushConfigured()
      ? await sendPushToAll({ title: digest.title, body: digest.body, url: '/' })
      : { sent: 0, failed: 0, skipped: !hasNewData }

  return Response.json({ ...digest, push }, { status: 200 })
}
