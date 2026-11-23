import { verifyMcpToken, MCP_SCOPE, type ClientClaims } from '@/app/lib/mcp/tokens'

/** The OAuth /authorize parameters after validation. */
export type AuthorizeRequest = {
  clientId: string
  clientName: string
  redirectUri: string
  state: string
  codeChallenge: string
  scope: string
}

/**
 * Validate an /authorize request (BUSINESS_RULES §28). Shared by the consent page
 * (GET) and the approve server action (POST) so the form's hidden fields can't be
 * tampered into something the page wouldn't have shown. Returns an error string
 * for anything unsafe to redirect back to (bad client / redirect_uri).
 */
export function validateAuthorize(p: Record<string, string | undefined>): AuthorizeRequest | string {
  const client = verifyMcpToken<ClientClaims>(p.client_id, 'client')
  if (!client) return 'Unknown client. Remove the connector in Claude and add it again.'
  const redirectUri = p.redirect_uri ?? ''
  if (!client.r.includes(redirectUri)) return 'redirect_uri does not match the registered client.'
  if (p.response_type !== 'code') return 'Only response_type=code is supported.'
  if (!p.code_challenge || p.code_challenge_method !== 'S256') return 'PKCE (S256) is required.'
  return {
    clientId: p.client_id!,
    clientName: client.n ?? 'Claude',
    redirectUri,
    state: p.state ?? '',
    codeChallenge: p.code_challenge,
    scope: MCP_SCOPE,
  }
}
