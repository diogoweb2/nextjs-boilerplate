'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createCategory, updateCategory, updateCategoryBucket, deleteCategory } from '@/app/actions/categories'

export type CategoryBucket = 'needs' | 'wants' | 'savings' | 'none'
export type CategoryManageRow = {
  id: number
  name: string
  color: string
  count: number
  bucket: CategoryBucket
}

const BUCKET_OPTIONS: { value: CategoryBucket; label: string }[] = [
  { value: 'needs', label: 'Needs' },
  { value: 'wants', label: 'Wants' },
  { value: 'savings', label: 'Savings' },
  { value: 'none', label: '—' },
]

const PALETTE = [
  '#16a34a', '#f97316', '#0ea5e9', '#eab308', '#8b5cf6', '#ef4444',
  '#6366f1', '#14b8a6', '#64748b', '#ec4899', '#06b6d4', '#a855f7', '#94a3b8',
]

export function CategoriesManager({ categories }: { categories: CategoryManageRow[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(PALETTE[4])

  const run = (fn: () => Promise<void>) =>
    startTransition(async () => {
      await fn()
      router.refresh()
    })

  return (
    <div className={pending ? 'opacity-70 transition-opacity' : ''}>
      <div className="card mb-3 flex flex-wrap items-center gap-2 p-3">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New category…"
          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
        <input
          type="color"
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
          className="h-9 w-10 cursor-pointer rounded border border-[var(--border)] bg-transparent"
        />
        <button
          onClick={() =>
            newName.trim() &&
            run(async () => {
              await createCategory(newName, newColor)
              setNewName('')
            })
          }
          className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent-fg)]"
        >
          Add
        </button>
      </div>

      <div className="card divide-y divide-[var(--border)] overflow-hidden">
        {categories.map((c) => (
          <CategoryRow
            key={c.id}
            c={c}
            onName={(name) => run(() => updateCategory(c.id, { name }))}
            onColor={(color) => run(() => updateCategory(c.id, { color }))}
            onBucket={(bucket) => run(() => updateCategoryBucket(c.id, bucket))}
            onDelete={() => run(() => deleteCategory(c.id))}
          />
        ))}
      </div>
    </div>
  )
}

function CategoryRow({
  c,
  onName,
  onColor,
  onBucket,
  onDelete,
}: {
  c: CategoryManageRow
  onName: (name: string) => void
  onColor: (color: string) => void
  onBucket: (bucket: CategoryBucket) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(c.name)
  return (
    <div className="flex items-center gap-2 p-3">
      <input
        type="color"
        value={c.color}
        onChange={(e) => onColor(e.target.value)}
        className="h-7 w-8 shrink-0 cursor-pointer rounded border border-[var(--border)] bg-transparent"
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== c.name && onName(name)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-sm font-medium outline-none hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)]"
      />
      <select
        value={c.bucket}
        onChange={(e) => onBucket(e.target.value as CategoryBucket)}
        title="50/30/20 bucket"
        className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1 text-xs text-[var(--muted)] outline-none focus:border-[var(--accent)]"
      >
        {BUCKET_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="hidden w-16 text-right text-xs tabular-nums text-[var(--muted)] sm:inline">
        {c.count} txn
      </span>
      <button
        onClick={onDelete}
        className="rounded-md px-2 py-1 text-xs text-[var(--muted)] hover:bg-[color-mix(in_srgb,var(--negative)_12%,transparent)] hover:text-[var(--negative)]"
        title="Delete category (transactions become uncategorized)"
      >
        Delete
      </button>
    </div>
  )
}
