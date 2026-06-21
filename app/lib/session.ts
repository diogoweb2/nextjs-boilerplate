const COOKIE_NAME = 'auth_session'
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000

type SessionPayload = { ok: true; exp: number; demo?: boolean }

async function getKey(): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET env var is not set')
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

function b64encode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

function b64decode(str: string): Uint8Array {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0))
}

/**
 * Mint a signed session token. `demo` marks a read-only demo session (set by the
 * "DEMO" button on the login page) — it authenticates like a normal session for
 * navigation, but writes are blocked and pages serve synthetic data. See
 * app/lib/demo.ts.
 */
export async function createSessionToken(opts?: { demo?: boolean }): Promise<string> {
  const data: SessionPayload = { ok: true, exp: Date.now() + SESSION_DURATION_MS }
  if (opts?.demo) data.demo = true
  const payload = btoa(JSON.stringify(data))
  const key = await getKey()
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${b64encode(sig)}`
}

/** Verify the signature + expiry and return the decoded payload, or null. */
export async function readSessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const [payload, sig] = token.split('.')
    if (!payload || !sig) return null
    const key = await getKey()
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      b64decode(sig).buffer as ArrayBuffer,
      new TextEncoder().encode(payload)
    )
    if (!valid) return null
    const data = JSON.parse(atob(payload)) as SessionPayload
    if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null
    return data
  } catch {
    return null
  }
}

export async function verifySessionToken(token: string): Promise<boolean> {
  return (await readSessionToken(token)) !== null
}

export { COOKIE_NAME }
