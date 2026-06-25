'use client'

import { useCallback, useEffect, useState } from 'react'
import { ProjectionSettings } from './ProjectionSettings'
import { loadProjectionPanel } from '@/app/actions/projection'

type Panel = Awaited<ReturnType<typeof loadProjectionPanel>>

/**
 * Dashboard modal over the unavoidable-spend editor. Lazy-loads the panel on
 * open (so the dashboard render stays cheap) and re-fetches after each edit so
 * the list reflects changes that also ripple to the trajectory cards/digest.
 */
export function UnavoidableModal({ onClose }: { onClose: () => void }) {
  const [panel, setPanel] = useState<Panel | null>(null)
  const refetch = useCallback(() => {
    loadProjectionPanel().then(setPanel)
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:py-10"
      role="dialog"
      aria-modal="true"
      aria-label="Unavoidable spend"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-[var(--border)] text-[var(--foreground)] shadow-xl"
        style={{ background: 'var(--surface)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div>
            <div className="text-sm font-semibold">Unavoidable spend</div>
            <div className="text-xs text-[var(--muted)]">
              Excluded from the discretionary curve. Edits also affect the digest, Budget &amp; cashflow.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-lg leading-none text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="p-4">
          {panel ? (
            <ProjectionSettings
              active={panel.active}
              suggestions={panel.suggestions}
              unavoidable={panel.unavoidable}
              addableMerchants={panel.addableMerchants}
              onMutated={refetch}
            />
          ) : (
            <div className="py-10 text-center text-sm text-[var(--muted)]">Loading…</div>
          )}
        </div>
      </div>
    </div>
  )
}
