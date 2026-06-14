import { cookies } from 'next/headers'
import { verifySessionToken, COOKIE_NAME } from '@/app/lib/session'

/**
 * Defense-in-depth auth check for Server Actions. proxy.ts already gates page
 * navigations, but Server Actions are reachable via direct POST, so every
 * mutating action calls this first.
 */
export async function requireAuth(): Promise<void> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  if (!token || !(await verifySessionToken(token))) {
    throw new Error('Unauthorized')
  }
}
