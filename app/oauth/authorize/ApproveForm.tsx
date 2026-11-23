'use client'

import { useActionState } from 'react'
import { approveMcpConnector, type ApproveState } from '@/app/actions/oauth'

const HIDDEN = ['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method'] as const

export function ApproveForm({ params }: { params: Record<string, string | undefined> }) {
  const [state, action, pending] = useActionState<ApproveState, FormData>(approveMcpConnector, undefined)
  return (
    <form action={action} className="flex flex-col gap-4">
      {HIDDEN.map((name) => (
        <input key={name} type="hidden" name={name} value={params[name] ?? ''} />
      ))}
      <div className="flex flex-col gap-1">
        <label htmlFor="password" className="text-sm font-medium text-[var(--foreground)]">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoFocus
          autoComplete="current-password"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
        />
      </div>
      {state?.error && <p className="text-sm text-[var(--negative,#dc2626)]">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? 'Connecting…' : 'Allow read-only access'}
      </button>
    </form>
  )
}
