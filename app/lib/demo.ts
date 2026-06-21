import { cookies } from 'next/headers'
import { readSessionToken, COOKIE_NAME } from '@/app/lib/session'

/**
 * True when the current request belongs to a read-only DEMO session (started via
 * the "DEMO" button on the login page). Loaders branch on this to serve the
 * synthetic dataset (app/lib/demo-data.ts) instead of the real database, and
 * requireAuth() uses it to block every write. So a visitor sees every feature
 * with believable fake numbers and can't touch — or see — real data.
 */
export async function isDemoSession(): Promise<boolean> {
  const token = (await cookies()).get(COOKIE_NAME)?.value
  if (!token) return false
  const payload = await readSessionToken(token)
  return payload?.demo === true
}
