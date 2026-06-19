'use server'

import { timingSafeEqual } from 'crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createSessionToken, COOKIE_NAME } from '@/app/lib/session'
import {
  checkLoginRateLimit,
  clearLoginAttempts,
  clientKey,
  recordLoginFailure,
} from '@/app/lib/rate-limit'

export type LoginState = { error: string } | undefined

export async function login(state: LoginState, formData: FormData): Promise<LoginState> {
  const password = (formData.get('password') as string) ?? ''
  const master = process.env.MASTER_PASSWORD ?? ''

  if (!master) return { error: 'Server misconfiguration.' }

  // Throttle brute force before checking the password.
  const key = await clientKey()
  const limit = await checkLoginRateLimit(key)
  if (limit.blocked) {
    const mins = Math.ceil(limit.retryAfterSec / 60)
    return { error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` }
  }

  const passwordBuf = Buffer.from(password)
  const masterBuf = Buffer.from(master)
  const isValid =
    passwordBuf.length === masterBuf.length && timingSafeEqual(passwordBuf, masterBuf)

  if (!isValid) {
    await recordLoginFailure(key)
    return { error: 'Incorrect password.' }
  }

  await clearLoginAttempts(key)
  const token = await createSessionToken()
  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  })

  redirect('/')
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(COOKIE_NAME)
  redirect('/login')
}
