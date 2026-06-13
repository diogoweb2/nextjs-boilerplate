const COOKIE_NAME = 'auth_session'
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000

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

export async function createSessionToken(): Promise<string> {
  const payload = btoa(JSON.stringify({ ok: true, exp: Date.now() + SESSION_DURATION_MS }))
  const key = await getKey()
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${b64encode(sig)}`
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    const [payload, sig] = token.split('.')
    if (!payload || !sig) return false
    const key = await getKey()
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      b64decode(sig).buffer as ArrayBuffer,
      new TextEncoder().encode(payload)
    )
    if (!valid) return false
    const { exp } = JSON.parse(atob(payload))
    return typeof exp === 'number' && exp > Date.now()
  } catch {
    return false
  }
}

export { COOKIE_NAME }
