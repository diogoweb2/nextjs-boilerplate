import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { monthReportPushes } from '@/db/schema'
import { ingestTokenOk } from '@/app/lib/apiToken'
import { buildDigest } from '@/app/lib/digest'
import { buildMonthReport, buildReportNotification } from '@/app/lib/monthReport'
import { completedReportMonth } from '@/app/lib/reportSchedule'
import { loadAllFlows, anchorMonth, availableMonths } from '@/app/lib/analytics'
import { pushConfigured, sendPushToAll } from '@/app/lib/push'

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
 *                      skips the daily digest.
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

  const month = new URL(request.url).searchParams.get('month')
  if (month) {
    return Response.json(await buildMonthReport(month), { status: 200 })
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

  // The month before the current anchor (latest month with data) is final the
  // moment that newer-month data lands — no pending charge can predate it. So once
  // a completed month exists, push its recap (once) and skip the daily digest.
  // Fires on the first run after new-month data; the per-`ym` dedup row caps it.
  const flows = await loadAllFlows()
  const ym = completedReportMonth(anchorMonth(flows.filter((t) => t.flow === 'expense')))
  if (ym && availableMonths(flows).includes(ym)) {
    const { report } = await buildMonthReport(ym)
    if (report && pushConfigured()) {
      // Insert-if-absent so later runs in the window can't double-send the recap.
      const claimed = await db
        .insert(monthReportPushes)
        .values({ ym })
        .onConflictDoNothing()
        .returning()
      if (claimed.length > 0) {
        const note = buildReportNotification(report)
        const push = await sendPushToAll({ title: note.title, body: note.body, url: note.url })
        return Response.json({ monthReport: true, ym, note, push }, { status: 200 })
      }
    }
    // No data yet, push not configured, or already sent → fall through to the daily digest.
  }

  const digest = await buildDigest(Date.now(), failedSources)
  const hasNewData = digest.newSpend.count > 0
  const push =
    hasNewData && pushConfigured()
      ? await sendPushToAll({ title: digest.title, body: digest.body, url: '/' })
      : { sent: 0, failed: 0, skipped: !hasNewData }

  return Response.json({ ...digest, push }, { status: 200 })
}
