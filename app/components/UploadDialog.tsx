'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { importCsv, type ImportResult } from '@/app/actions/import'
import type { ImportSource } from '@/app/lib/csv'
import { formatMonth } from '@/app/lib/format'

type Status =
  | { state: 'idle' }
  | { state: 'uploading'; name: string }
  | { state: 'done'; result: ImportResult; name: string }

/**
 * Two upload buttons (Master / Amex) plus auto-detection. The chosen source is
 * passed as a hint, but the server validates it against the file's header.
 */
export function UploadDialog() {
  const router = useRouter()
  const masterRef = useRef<HTMLInputElement>(null)
  const amexRef = useRef<HTMLInputElement>(null)
  const tangerineRef = useRef<HTMLInputElement>(null)
  const scotiaRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<Status>({ state: 'idle' })

  async function handleFile(file: File | undefined, source: ImportSource) {
    if (!file) return
    setStatus({ state: 'uploading', name: file.name })
    const fd = new FormData()
    fd.set('file', file)
    fd.set('source', source)
    const result = await importCsv(fd)
    setStatus({ state: 'done', result, name: file.name })
    if (result.ok) router.refresh()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <UploadButton
          label="Upload Master CSV"
          subtitle="RBC / World Elite statement"
          onClick={() => masterRef.current?.click()}
        />
        <UploadButton
          label="Upload Amex CSV"
          subtitle="American Express activity"
          onClick={() => amexRef.current?.click()}
        />
        <UploadButton
          label="Upload Tangerine CSV"
          subtitle="Tangerine chequing export"
          onClick={() => tangerineRef.current?.click()}
        />
        <UploadButton
          label="Upload Scotia CSV"
          subtitle="Scotiabank chequing export"
          onClick={() => scotiaRef.current?.click()}
        />
      </div>

      <input
        ref={masterRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0], 'master')}
      />
      <input
        ref={amexRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0], 'amex')}
      />
      <input
        ref={tangerineRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0], 'tangerine')}
      />
      <input
        ref={scotiaRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0], 'scotia')}
      />

      {status.state === 'uploading' && (
        <p className="animate-in text-sm text-[var(--muted)]">
          Importing <span className="font-medium">{status.name}</span>…
        </p>
      )}

      {status.state === 'done' && status.result.ok && (
        <div className="animate-in rounded-lg border border-[var(--positive)] bg-[color-mix(in_srgb,var(--positive)_10%,transparent)] px-3 py-2 text-sm">
          <span className="font-semibold text-[var(--positive)]">
            {status.result.source.toUpperCase()} imported.
          </span>{' '}
          {status.result.inserted} new transaction{status.result.inserted !== 1 ? 's' : ''}
          {status.result.skipped > 0 && `, ${status.result.skipped} already on file`} ·{' '}
          {formatMonth(status.result.period)}
        </div>
      )}

      {status.state === 'done' && !status.result.ok && (
        <div className="animate-in rounded-lg border border-[var(--negative)] bg-[color-mix(in_srgb,var(--negative)_10%,transparent)] px-3 py-2 text-sm text-[var(--negative)]">
          {status.result.error}
        </div>
      )}
    </div>
  )
}

function UploadButton({
  label,
  subtitle,
  onClick,
}: {
  label: string
  subtitle: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="group flex items-center gap-3 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--surface-2)]"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--surface-2)] text-[var(--accent)] transition-colors group-hover:bg-[var(--accent)] group-hover:text-[var(--accent-fg)]">
        ↑
      </span>
      <span className="flex flex-col">
        <span className="text-sm font-semibold">{label}</span>
        <span className="text-xs text-[var(--muted)]">{subtitle}</span>
      </span>
    </button>
  )
}
