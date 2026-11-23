import { signMcpToken, redirectUriAllowed } from '@/app/lib/mcp/tokens'

/**
 * RFC 7591 dynamic client registration for the MCP connector (BUSINESS_RULES §28).
 * Stateless: the client_id IS a signed blob of the redirect URIs, so /authorize
 * can check them without a table. Only Claude's callback URLs are accepted.
 */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : []
  if (uris.length === 0 || uris.length > 5) {
    return Response.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' }, { status: 400 })
  }
  const bad = uris.find((u) => !redirectUriAllowed(u))
  if (bad) {
    return Response.json({ error: 'invalid_redirect_uri', error_description: `redirect URI not allowed: ${bad}` }, { status: 400 })
  }
  const name = typeof body?.client_name === 'string' ? body.client_name.slice(0, 80) : 'MCP client'
  const clientId = signMcpToken({ typ: 'client', r: uris, n: name })
  return Response.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    { status: 201 }
  )
}
