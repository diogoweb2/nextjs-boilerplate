import { eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { db } from '@/db'
import { loginAttempts } from '@/db/schema'

/**
 * Brute-force throttle for the login action. The whole app sits behind a single
 * shared password, so without this an attacker could guess at network speed.
 * State is DB-backed (login_attempts) rather than in-memory because the app runs
 * serverless — instances don't share memory, so a per-process counter wouldn't
 * hold. See app/actions/auth.ts for how it's wired.
 */

// After MAX_FAILURES wrong passwords inside WINDOW_MS, lock the IP for LOCKOUT_MS.
const MAX_FAILURES = 5
const WINDOW_MS = 15 * 60 * 1000
const LOCKOUT_MS = 15 * 60 * 1000

// Throttling only matters for the publicly exposed deployment. In local dev it
// just gets in the way, so disable it entirely.
const ENABLED = process.env.NODE_ENV === 'production'

/** Best-effort client identity from proxy headers; falls back to a shared bucket. */
export async function clientKey(): Promise<string> {
  const h = await headers()
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || h.get('x-real-ip') || 'unknown'
}

export type RateLimitState = { blocked: boolean; retryAfterSec: number }

/** Is this client currently locked out? */
export async function checkLoginRateLimit(key: string): Promise<RateLimitState> {
  if (!ENABLED) return { blocked: false, retryAfterSec: 0 }
  const [row] = await db.select().from(loginAttempts).where(eq(loginAttempts.ip, key)).limit(1)
  const lockedMs = row?.lockedUntil ? row.lockedUntil.getTime() - Date.now() : 0
  if (lockedMs > 0) return { blocked: true, retryAfterSec: Math.ceil(lockedMs / 1000) }
  return { blocked: false, retryAfterSec: 0 }
}

/** Record a wrong password; opens/extends the lockout once the threshold is hit. */
export async function recordLoginFailure(key: string): Promise<void> {
  if (!ENABLED) return
  const now = Date.now()
  const [row] = await db.select().from(loginAttempts).where(eq(loginAttempts.ip, key)).limit(1)

  // No row yet, or the previous window has elapsed → start a fresh window.
  if (!row || now - row.windowStart.getTime() > WINDOW_MS) {
    const fresh = { failures: 1, windowStart: new Date(now), lockedUntil: null }
    await db
      .insert(loginAttempts)
      .values({ ip: key, ...fresh })
      .onConflictDoUpdate({ target: loginAttempts.ip, set: fresh })
    return
  }

  const failures = row.failures + 1
  const lockedUntil = failures >= MAX_FAILURES ? new Date(now + LOCKOUT_MS) : null
  await db.update(loginAttempts).set({ failures, lockedUntil }).where(eq(loginAttempts.ip, key))
}

/** Clear all failures for this client (called after a successful login). */
export async function clearLoginAttempts(key: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.ip, key))
}
