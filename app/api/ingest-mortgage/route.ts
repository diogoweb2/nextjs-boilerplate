import type { NextRequest } from 'next/server'
import { ingestMortgageBalance, setMortgageRate } from '@/app/actions/goals'
import { ingestTokenOk } from '@/app/lib/apiToken'

/**
 * Token-authed endpoint for the Scotia sync's mortgage figures scraped off the
 * account pages:
 *   ?balance=<amount>  the daily home-page balance (idempotent per day)
 *   ?rate=<fraction>   the monthly interest rate, e.g. 0.0355 (overrides the
 *                      back-solved estimate)
 * At least one is required; both may be sent together.
 *
 * Auth is the same bearer token as /api/ingest (proxy.ts whitelists `/api/ingest*`,
 * which covers this path). Distinct from /api/ingest (transaction statements) and
 * /api/ingest-holdings (portfolio snapshots) — this carries single numbers.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!process.env.INGEST_TOKEN) {
    return Response.json({ ok: false, error: 'Ingest endpoint not configured.' }, { status: 503 })
  }
  if (!ingestTokenOk(request)) {
    return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 })
  }

  const params = request.nextUrl.searchParams
  const balanceRaw = params.get('balance')?.trim()
  const rateRaw = params.get('rate')?.trim()
  if (!balanceRaw && !rateRaw) {
    return Response.json({ ok: false, error: 'Provide ?balance= and/or ?rate=.' }, { status: 400 })
  }

  const result: Record<string, unknown> = { ok: true }

  if (balanceRaw) {
    const balance = Number(balanceRaw)
    if (!Number.isFinite(balance)) {
      return Response.json({ ok: false, error: 'Invalid ?balance=<amount>.' }, { status: 400 })
    }
    result.balance = await ingestMortgageBalance(balance)
  }

  if (rateRaw) {
    const rate = Number(rateRaw)
    if (!Number.isFinite(rate)) {
      return Response.json({ ok: false, error: 'Invalid ?rate=<fraction>.' }, { status: 400 })
    }
    result.rate = await setMortgageRate(rate)
  }

  return Response.json(result, { status: 200 })
}
