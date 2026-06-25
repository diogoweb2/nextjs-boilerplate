import { revalidatePath } from 'next/cache'
import type { NextRequest } from 'next/server'
import { ingestHoldings } from '@/app/actions/investments'
import { ingestTokenOk } from '@/app/lib/apiToken'

/**
 * Token-authed endpoint for the monthly iTrade HOLDINGS sync (BUSINESS_RULES §16).
 *
 * The Mac-side sync downloads each registered account's portfolio CSV from iTrade
 * and POSTs it here with `?account=<brokerage number>` so the snapshot lands in
 * the right account. Reuses `ingestHoldings` — the same parse, FX-to-CAD and
 * snapshot insert as the manual upload on /investments.
 *
 * Auth is the same bearer token as /api/ingest (proxy.ts whitelists `/api/ingest*`,
 * which covers this path). Distinct from /api/ingest, which ingests transaction
 * statements; holdings are a different shape entirely.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!process.env.INGEST_TOKEN) {
    return Response.json({ ok: false, error: 'Ingest endpoint not configured.' }, { status: 503 })
  }
  if (!ingestTokenOk(request)) {
    return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 })
  }

  const account = request.nextUrl.searchParams.get('account')?.trim()
  if (!account) {
    return Response.json({ ok: false, error: 'Missing ?account=<brokerage number>.' }, { status: 400 })
  }
  const filename = request.headers.get('x-filename') ?? 'holdings.csv'
  const fxRaw = request.nextUrl.searchParams.get('fx')
  const fxOverride = fxRaw ? Number(fxRaw) : null

  const text = await request.text()
  if (!text.trim()) {
    return Response.json({ ok: false, error: 'Empty body.' }, { status: 400 })
  }

  const result = await ingestHoldings({ text, brokerageAccountNo: account, fxOverride, filename })
  if (!result.ok) {
    return Response.json(result, { status: 400 })
  }

  revalidatePath('/investments')
  revalidatePath('/')
  return Response.json(result, { status: 200 })
}
