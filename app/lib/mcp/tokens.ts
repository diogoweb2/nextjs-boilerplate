import { createHash, createHmac, timingSafeEqual } from 'crypto'

/**
 * Stateless signed tokens for the MCP connector's OAuth flow (BUSINESS_RULES §28).
 *
 * Everything the OAuth server hands out — the dynamically-registered client_id,
 * the short-lived authorization code, the access token and the refresh token — is
 * a `<base64url(json)>.<base64url(hmac)>` blob, so no table is needed.
 *
 * The HMAC key is DERIVED from SESSION_SECRET with a domain label, never the raw
 * secret: session cookies and MCP tokens can therefore never be swapped for one
 * another (readSessionToken only checks `exp`, so sharing a key would let an MCP
 * token log into the web app). Bumping MCP_TOKEN_VERSION (env) changes the label
 * and revokes every MCP client, code and token at once — the "disconnect
 * everything" switch.
 */

export type McpTokenType = 'client' | 'code' | 'access' | 'refresh'

type Claims = { typ: McpTokenType; exp?: number; [k: string]: unknown }

export const ACCESS_TTL_SEC = 60 * 60 // 1 hour
export const REFRESH_TTL_SEC = 365 * 24 * 60 * 60 // 1 year, rotated on every refresh
export const CODE_TTL_SEC = 120 // authorization code: 2 minutes

function key(): Buffer {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET env var is not set')
  const version = process.env.MCP_TOKEN_VERSION ?? '1'
  return createHmac('sha256', secret).update(`mcp-oauth-v${version}`).digest()
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url')

export function signMcpToken(claims: Claims, ttlSec?: number): string {
  const body: Claims = ttlSec ? { ...claims, exp: Math.floor(Date.now() / 1000) + ttlSec } : claims
  const payload = b64url(JSON.stringify(body))
  const sig = createHmac('sha256', key()).update(payload).digest()
  return `${payload}.${b64url(sig)}`
}

/** Verify signature, type and expiry; returns the claims or null. */
export function verifyMcpToken<T extends Claims = Claims>(token: string | null | undefined, typ: McpTokenType): T | null {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  try {
    const expected = createHmac('sha256', key()).update(payload).digest()
    const given = Buffer.from(sig, 'base64url')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T
    if (claims.typ !== typ) return null
    if (typeof claims.exp === 'number' && claims.exp <= Math.floor(Date.now() / 1000)) return null
    return claims
  } catch {
    return null
  }
}

/** PKCE S256: base64url(sha256(verifier)) must equal the stored challenge. */
export function pkceOk(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false
  const digest = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const want = Buffer.from(challenge)
  return digest.length === want.length && timingSafeEqual(digest, want)
}

/**
 * Only Claude's own OAuth callbacks may receive codes (plus localhost outside
 * production, for the MCP Inspector). Without this, anyone could register a
 * client pointing at their own server and phish a code via a crafted link.
 */
export function redirectUriAllowed(uri: string): boolean {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.protocol === 'https:' && (u.hostname === 'claude.ai' || u.hostname === 'claude.com')) {
    return u.pathname === '/api/mcp/auth_callback'
  }
  if (process.env.NODE_ENV !== 'production') {
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
  }
  return false
}

export type ClientClaims = Claims & { typ: 'client'; r: string[]; n?: string }
export type CodeClaims = Claims & { typ: 'code'; c: string; r: string; cc: string; s?: string }
export type GrantClaims = Claims & { typ: 'access' | 'refresh'; c: string; s?: string }

/** Mint the access + refresh pair returned by the token endpoint. */
export function issueTokens(clientId: string, scope: string) {
  return {
    access_token: signMcpToken({ typ: 'access', c: clientId, s: scope }, ACCESS_TTL_SEC),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SEC,
    refresh_token: signMcpToken({ typ: 'refresh', c: clientId, s: scope }, REFRESH_TTL_SEC),
    scope,
  }
}

export const MCP_SCOPE = 'budget:read'
