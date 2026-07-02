'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deleteBatch } from '@/app/actions/import'
import { formatMonth } from '@/app/lib/format'

export type BatchRow = {
  id: number
  source: 'master' | 'amex' | 'tangerine' | 'scotia' | 'manual'
  filename: string
  periodLabel: string
  insertedCount: number
  createdAt: string
}

export function BatchList({ batches }: { batches: BatchRow[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  if (batches.length === 0) {
    return <p className="text-sm text-[var(--muted)]">No imports yet.</p>
  }

  const remove = (id: number) =>
    startTransition(async () => {
      await deleteBatch(id)
      router.refresh()
    })

  return (
    <ul className={`flex flex-col gap-2 ${pending ? 'opacity-70' : ''}`}>
      {batches.map((b) => (
        <li
          key={b.id}
          className="flex items-center justify-between gap-3 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm"
        >
          <div className="min-w-0">
            <span className="font-medium">{b.source.toUpperCase()}</span>{' '}
            <span className="text-[var(--muted)]">· {formatMonth(b.periodLabel)}</span>
            <span className="block truncate text-xs text-[var(--muted)]">
              {b.filename} · {b.insertedCount} rows
            </span>
          </div>
          <button
            onClick={() => remove(b.id)}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-[var(--muted)] hover:bg-[color-mix(in_srgb,var(--negative)_12%,transparent)] hover:text-[var(--negative)]"
          >
            Undo
          </button>
        </li>
      ))}
    </ul>
  )
}
