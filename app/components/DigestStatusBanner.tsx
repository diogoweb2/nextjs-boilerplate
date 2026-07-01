'use client'

import { useState, useTransition } from 'react'
import { formatSyncAge } from '@/app/lib/sync'
import { retryDailyDigest } from '@/app/actions/digest'

type Props = { lastRunAt: string; error: string | null }

/**
 * Dashboard alert shown when the last daily-digest run (POST /api/digest,
 * fired by the local launchd job right after the card syncs) failed — e.g. a
 * 500 from a DB hiccup — so a silent notification pipeline doesn't go
 * unnoticed. Retry re-runs the exact same push logic from the browser
 * (session-authed, no ingest token needed) and, per runDailyDigestJob's own
 * "previous run failed" override, forces the notification through even with
 * no new spend today. Clears once that retry (or the next automated run)
 * succeeds and revalidates `/`.
 */
export function DigestStatusBanner({ lastRunAt, error }: Props) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const retry = () => {
    setResult(null)
    startTransition(async () => {
      setResult(await retryDailyDigest())
    })
  }

  return (
    <div
      role="alert"
      className="rounded-lg border border-[var(--negative)]/40 bg-[var(--negative)]/10 px-4 py-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[var(--negative)]">⚠️ Daily digest failed</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Last attempt{' '}
            <span
              className="font-medium text-[var(--foreground)]"
              title={new Date(lastRunAt).toLocaleString()}
            >
              {formatSyncAge(lastRunAt)} ago
            </span>{' '}
            failed{error ? ':' : '.'}
          </p>
          {error && <p className="mt-1 text-xs text-[var(--muted)]/80">{error}</p>}
        </div>
        <button
          onClick={retry}
          disabled={pending}
          className="shrink-0 rounded-lg border border-[var(--negative)]/40 px-3 py-1.5 text-xs font-medium text-[var(--negative)] transition-colors hover:bg-[var(--negative)]/10 disabled:opacity-50"
        >
          {pending ? 'Retrying…' : 'Retry'}
        </button>
      </div>
      {result && (
        <p className={`mt-2 text-xs ${result.ok ? 'text-[var(--muted)]' : 'text-[var(--negative)]'}`}>
          {result.message}
        </p>
      )}
    </div>
  )
}
