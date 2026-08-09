import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { aparecidaImports } from '@/db/schema'

/**
 * Serves the original statement PDF for a given import (looked up by
 * filename, e.g. "fatura Junho.pdf"). Not whitelisted in proxy.ts, so it
 * requires the normal session cookie like every other page/route.
 * ?download=1 forces a save-as instead of opening inline.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
): Promise<Response> {
  const { filename } = await params
  const [row] = await db
    .select({ pdfBase64: aparecidaImports.pdfBase64 })
    .from(aparecidaImports)
    .where(eq(aparecidaImports.filename, decodeURIComponent(filename)))
    .limit(1)

  if (!row?.pdfBase64) {
    return new Response('Statement PDF not found.', { status: 404 })
  }

  const download = request.nextUrl.searchParams.get('download') === '1'
  const bytes = Buffer.from(row.pdfBase64, 'base64')
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${decodeURIComponent(filename)}"`,
      'Content-Length': String(bytes.length),
    },
  })
}
