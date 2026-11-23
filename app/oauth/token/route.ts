import {
  verifyMcpToken,
  pkceOk,
  issueTokens,
  MCP_SCOPE,
  type ClientClaims,
  type CodeClaims,
  type GrantClaims,
} from '@/app/lib/mcp/tokens'

/**
 * OAuth token endpoint for the MCP connector (BUSINESS_RULES §28): exchanges an
 * authorization code (+ PKCE verifier) or a refresh token for a fresh
 * access/refresh pair. Public client — no client secret; PKCE is mandatory.
 */
async function readParams(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    const j = (await req.json().catch(() => ({}))) as Record<string, unknown>
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? '')]))
  }
  const form = await req.formData().catch(() => null)
  const out: Record<string, string> = {}
  form?.forEach((v, k) => (out[k] = String(v)))
  return out
}

const bad = (error: string, description: string, status = 400) =>
  Response.json({ error, error_description: description }, { status, headers: { 'Cache-Control': 'no-store' } })

export async function POST(req: Request): Promise<Response> {
  const p = await readParams(req)

  if (p.grant_type === 'authorization_code') {
    const code = verifyMcpToken<CodeClaims>(p.code, 'code')
    if (!code) return bad('invalid_grant', 'authorization code is invalid or expired')
    if (p.client_id && p.client_id !== code.c) return bad('invalid_grant', 'client mismatch')
    if (p.redirect_uri !== code.r) return bad('invalid_grant', 'redirect_uri mismatch')
    if (!pkceOk(p.code_verifier ?? '', code.cc)) return bad('invalid_grant', 'PKCE verification failed')
    if (!verifyMcpToken<ClientClaims>(code.c, 'client')) return bad('invalid_client', 'unknown client', 401)
    return Response.json(issueTokens(code.c, code.s ?? MCP_SCOPE), { headers: { 'Cache-Control': 'no-store' } })
  }

  if (p.grant_type === 'refresh_token') {
    const grant = verifyMcpToken<GrantClaims>(p.refresh_token, 'refresh')
    if (!grant) return bad('invalid_grant', 'refresh token is invalid or expired')
    if (p.client_id && p.client_id !== grant.c) return bad('invalid_grant', 'client mismatch')
    return Response.json(issueTokens(grant.c, grant.s ?? MCP_SCOPE), { headers: { 'Cache-Control': 'no-store' } })
  }

  return bad('unsupported_grant_type', 'use authorization_code or refresh_token')
}
