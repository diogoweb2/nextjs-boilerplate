import { cookies } from 'next/headers'
import { readSessionToken, COOKIE_NAME } from '@/app/lib/session'

/**
 * Defense-in-depth auth check for Server Actions. proxy.ts already gates page
 * navigations, but Server Actions are reachable via direct POST, so every
 * mutating action calls this first.
 *
 * A read-only DEMO session is a valid signed token (so it can browse), but every
 * mutating action calls this, so throwing here blocks all writes in demo mode
 * with a single check. Read loaders never call requireAuth, so demo reads work.
 */
export async function requireAuth(): Promise<void> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  const payload = token ? await readSessionToken(token) : null
  if (!payload) {
    throw new Error('Unauthorized')
  }
  if (payload.demo) {
    throw new Error('This is a read-only demo — changes are disabled.')
  }
}
