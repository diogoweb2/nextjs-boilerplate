import type { NextRequest } from 'next/server'
import { ingestLiveBalance } from '@/app/actions/emergency'
import { ingestTokenOk } from '@/app/lib/apiToken'

/**
 * Token-authed endpoint for the daily sync's scraped account balances:
 *   ?source=<master|amex|tangerine|scotia>&balance=<amount>
 *
 * Cards (master/amex): the site's "Current balance" becomes the authoritative
 * outstanding balance (transaction-derived estimate stays as the fallback).
 * Banks (tangerine/scotia): also re-anchors the emergency-fund snapshot model.
 * See ingestLiveBalance (app/actions/emergency.ts).
 *
 * Auth is the same bearer token as /api/ingest (proxy.ts whitelists
 * `/api/ingest*`, which covers this path).
 */
const SOURCES = ['master', 'amex', 'tangerine', 'scotia'] as const
type Source = (typeof SOURCES)[number]

export async function POST(request: NextRequest): Promise<Response> {
  if (!process.env.INGEST_TOKEN) {
    return Response.json({ ok: false, error: 'Ingest endpoint not configured.' }, { status: 503 })
  }
  if (!ingestTokenOk(request)) {
    return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 })
  }

  const params = request.nextUrl.searchParams
  const source = params.get('source')?.trim()
  const balanceRaw = params.get('balance')?.trim()
  if (!source || !SOURCES.includes(source as Source)) {
    return Response.json({ ok: false, error: 'Unknown or missing ?source=.' }, { status: 400 })
  }
  const balance = Number(balanceRaw)
  if (!balanceRaw || !Number.isFinite(balance)) {
    return Response.json({ ok: false, error: 'Invalid ?balance=<amount>.' }, { status: 400 })
  }

  const result = await ingestLiveBalance(source as Source, balance)
  return Response.json({ ok: result.ok, balance: result }, { status: result.ok ? 200 : 400 })
}
