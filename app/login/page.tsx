'use client'

import { useActionState, useState } from 'react'
import { login, enterDemo, type LoginState } from '@/app/actions/auth'
import { LogoMark, LogoWordmark } from '@/app/components/Logo'

// One per day, deterministically — the family's daily dose of financial realism.
const TAGLINES = [
  'The money was right here a minute ago.',
  'Tracking every dollar on its way out.',
  'Where the Pereira Lopes fortune goes to say goodbye.',
  'Our net worth, live and unflinching.',
  'Spoiler: it was groceries again.',
  'Money can fly. We have charts to prove it.',
  'A loving home for brief visits from our salary.',
]

export default function LoginPage() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, undefined)
  const [showPassword, setShowPassword] = useState(false)
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000
  )
  const tagline = TAGLINES[dayOfYear % TAGLINES.length]

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="logo-hover card w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoMark className="h-16 w-20" />
          <h1 className="mt-2 text-2xl text-[var(--foreground)]">
            <LogoWordmark />
          </h1>
          <p className="mt-1 text-xs text-[var(--muted)]">{tagline}</p>
        </div>
        <form action={action} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="password"
              className="text-sm font-medium text-[var(--foreground)]"
            >
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 pr-10 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                {showPassword ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                    <line x1="2" x2="22" y1="2" y2="22" />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          {state?.error && (
            <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>
          )}
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Opening the vault…' : 'Open the vault'}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3 text-xs text-[var(--muted)]">
          <span className="h-px flex-1 bg-[var(--border)]" />
          or
          <span className="h-px flex-1 bg-[var(--border)]" />
        </div>

        <form action={enterDemo}>
          <button
            type="submit"
            className="w-full rounded-lg border border-dashed border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--surface-2)]"
          >
            🔍 Explore the demo
          </button>
          <p className="mt-2 text-center text-xs text-[var(--muted)]">
            Sample data, no sign-in — view every feature, nothing is editable.
          </p>
        </form>
      </div>
    </div>
  )
}
