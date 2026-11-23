'use server'

import { timingSafeEqual } from 'crypto'
import { redirect } from 'next/navigation'
import { checkLoginRateLimit, clearLoginAttempts, clientKey, recordLoginFailure } from '@/app/lib/rate-limit'
import { signMcpToken, CODE_TTL_SEC } from '@/app/lib/mcp/tokens'
import { validateAuthorize } from '@/app/lib/mcp/authorize'

export type ApproveState = { error: string } | undefined

const FIELDS = ['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method'] as const

/**
 * Approve the MCP connector (BUSINESS_RULES §28). Granting read access to all the
 * budget data requires the master password — even with a valid session cookie —
 * and shares the login brute-force throttle. On success, redirect back to
 * Claude's callback with a short-lived signed authorization code.
 */
export async function approveMcpConnector(state: ApproveState, formData: FormData): Promise<ApproveState> {
  const params: Record<string, string> = {}
  for (const f of FIELDS) params[f] = String(formData.get(f) ?? '')
  const req = validateAuthorize(params)
  if (typeof req === 'string') return { error: req }

  const master = process.env.MASTER_PASSWORD ?? ''
  if (!master) return { error: 'Server misconfiguration.' }

  const key = await clientKey()
  const limit = await checkLoginRateLimit(key)
  if (limit.blocked) {
    const mins = Math.ceil(limit.retryAfterSec / 60)
    return { error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` }
  }

  const given = Buffer.from(String(formData.get('password') ?? ''))
  const want = Buffer.from(master)
  if (!(given.length === want.length && timingSafeEqual(given, want))) {
    await recordLoginFailure(key)
    return { error: 'Incorrect password.' }
  }
  await clearLoginAttempts(key)

  const code = signMcpToken(
    { typ: 'code', c: req.clientId, r: req.redirectUri, cc: req.codeChallenge, s: req.scope },
    CODE_TTL_SEC
  )
  const back = new URL(req.redirectUri)
  back.searchParams.set('code', code)
  if (req.state) back.searchParams.set('state', req.state)
  redirect(back.toString())
}
