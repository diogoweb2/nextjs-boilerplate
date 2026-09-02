'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  suggestMerchantName,
  suggestNewMerchantNames,
  applyMerchantNames,
  type NameProposal,
} from '@/app/actions/merchant-names-ai'

/** Small inline spinner — shared by the row button and the batch panel. */
export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
    />
  )
}

/**
 * One merchant, on demand. Suggests a cleaner name and shows it as a chip; nothing
 * is written until "Use" is clicked, and the suggestion never moves the batch
 * watermark (that belongs to the panel below).
 */
export function SuggestNameButton({
  merchantId,
  currentName,
}: {
  merchantId: number
  currentName: string
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [proposal, setProposal] = useState<NameProposal | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const ask = async () => {
    setLoading(true)
    setMessage(null)
    setProposal(null)
    try {
      const res = await suggestMerchantName(merchantId)
      if (!res.ok) setMessage(res.error)
      else if (!res.proposal) setMessage('Looks fine as it is')
      else setProposal(res.proposal)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Suggestion failed')
    } finally {
      setLoading(false)
    }
  }

  const use = () => {
    if (!proposal) return
    const name = proposal.newName
    setProposal(null)
    setMessage(name)
    startTransition(async () => {
      await applyMerchantNames([{ id: merchantId, name }])
      router.refresh()
    })
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={ask}
        disabled={loading}
        title={`Suggest a cleaner name for "${currentName}"`}
        aria-label={`Suggest a cleaner name for ${currentName}`}
        className="shrink-0 rounded-md px-1.5 py-1 text-xs text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--accent)] disabled:opacity-60"
      >
        {loading ? <Spinner /> : '✨'}
      </button>
      {proposal && (
        <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-[var(--surface-2)] px-2 py-0.5 text-xs">
          <span className="truncate font-medium text-[var(--accent)]">{proposal.newName}</span>
          {proposal.why && <span className="hidden truncate text-[var(--muted)] sm:inline">{proposal.why}</span>}
          <button type="button" onClick={use} className="shrink-0 font-medium text-[var(--accent)] hover:underline">
            Use
          </button>
          <button
            type="button"
            onClick={() => setProposal(null)}
            className="shrink-0 text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            ✕
          </button>
        </span>
      )}
      {message && !proposal && (
        <span className="truncate text-xs text-[var(--muted)]">{message}</span>
      )}
    </span>
  )
}

/**
 * Batch review of merchants first seen since the last batch run. The count comes
 * from the server (the watermark in `merchant_name_runs`), so a monthly click only
 * ever looks at what the latest imports brought in. Applying stamps a new
 * watermark — even if you reject every proposal, the run counts as reviewed.
 */
export function SuggestNewNamesPanel({
  newCount,
  since,
}: {
  newCount: number
  since: string | null
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [proposals, setProposals] = useState<NameProposal[] | null>(null)
  const [reviewed, setReviewed] = useState(0)
  const [rejected, setRejected] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [saving, startTransition] = useTransition()

  const run = async () => {
    setLoading(true)
    setError(null)
    setProposals(null)
    setRejected(new Set())
    try {
      const res = await suggestNewMerchantNames()
      if (!res.ok) setError(res.error)
      else {
        setProposals(res.proposals)
        setReviewed(res.reviewed)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Suggestion failed')
    } finally {
      setLoading(false)
    }
  }

  const accepted = (proposals ?? []).filter((p) => !rejected.has(p.merchantId))

  const applyAccepted = () => {
    startTransition(async () => {
      await applyMerchantNames(
        accepted.map((p) => ({ id: p.merchantId, name: p.newName })),
        { recordRun: true, reviewed }
      )
      setProposals(null)
      router.refresh()
    })
  }

  const sinceLabel = since ? `since ${since.slice(0, 10)}` : 'never reviewed'

  return (
    <div className="card mb-3 flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Clean up new merchant names</p>
          <p className="text-xs text-[var(--muted)]">
            {newCount === 0
              ? `Nothing new ${sinceLabel}.`
              : `${newCount} merchant${newCount === 1 ? '' : 's'} first seen ${sinceLabel}.`}
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={loading || newCount === 0}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--accent)] hover:bg-[var(--surface-2)] disabled:opacity-50"
        >
          {loading && <Spinner />}
          {loading ? 'Reviewing…' : 'Suggest names'}
        </button>
      </div>

      {error && <p className="text-xs text-[var(--negative)]">Suggestions failed: {error}</p>}

      {proposals !== null && (
        <div className="flex flex-col gap-2">
          {proposals.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">
              Reviewed {reviewed} — no name needed changing.
            </p>
          ) : (
            <>
              <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
                {proposals.map((p) => {
                  const off = rejected.has(p.merchantId)
                  return (
                    <label
                      key={p.merchantId}
                      className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${off ? 'opacity-40' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={!off}
                        onChange={() =>
                          setRejected((prev) => {
                            const next = new Set(prev)
                            if (next.has(p.merchantId)) next.delete(p.merchantId)
                            else next.add(p.merchantId)
                            return next
                          })
                        }
                        className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                      />
                      <span className="truncate text-[var(--muted)] line-through">{p.current}</span>
                      <span className="shrink-0 text-[var(--muted)]">→</span>
                      <span className="truncate font-medium">{p.newName}</span>
                      <span className="ml-auto hidden shrink-0 text-xs text-[var(--muted)] sm:inline">
                        {p.why} · {p.txns} txn
                      </span>
                    </label>
                  )
                })}
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={applyAccepted}
                  disabled={saving}
                  className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[var(--accent-fg)] disabled:opacity-60"
                >
                  {saving ? 'Applying…' : `Apply ${accepted.length}`}
                </button>
                <button
                  type="button"
                  onClick={() => setProposals(null)}
                  className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  Cancel
                </button>
                <span className="text-xs text-[var(--muted)]">
                  Reviewed {reviewed} · applying marks them all as reviewed.
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
