'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'

const OPTIONS = [
  { months: 1, label: '1M' },
  { months: 3, label: '3M' },
  { months: 6, label: '6M' },
  { months: 12, label: '12M' },
]

/** URL-driven period + "exclude special purchases" controls. */
export function PeriodSelector({ showSpecialToggle = true }: { showSpecialToggle?: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()

  const months = Number(params.get('months')) || 3
  const excludeSpecial = params.get('special') === '0'

  const update = (next: Record<string, string>) => {
    const sp = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(next)) sp.set(k, v)
    startTransition(() => router.replace(`${pathname}?${sp.toString()}`, { scroll: false }))
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${pending ? 'opacity-70' : ''}`}>
      <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface)] p-0.5">
        {OPTIONS.map((o) => (
          <button
            key={o.months}
            onClick={() => update({ months: String(o.months) })}
            className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
              months === o.months
                ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                : 'text-[var(--muted)] hover:text-[var(--foreground)]'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      {showSpecialToggle && (
        <button
          onClick={() => update({ special: excludeSpecial ? '1' : '0' })}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            excludeSpecial
              ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)]'
              : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]'
          }`}
          title="Hide one-off / reimbursable purchases from the charts"
        >
          {excludeSpecial ? '✓ ' : ''}Exclude special
        </button>
      )}
    </div>
  )
}
