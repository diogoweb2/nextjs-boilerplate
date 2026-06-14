'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'

const DEFAULT_OPTIONS = [
  { months: 1, label: '1M' },
  { months: 3, label: '3M' },
  { months: 6, label: '6M' },
  { months: 12, label: '12M' },
]

function buildOptions(values?: number[]) {
  if (!values) return DEFAULT_OPTIONS
  return values.map((m) => ({ months: m, label: `${m}M` }))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m) return ym
  return `${MONTHS[m - 1]} ${y}`
}

/** URL-driven period + "exclude special purchases" controls. */
export function PeriodSelector({
  showSpecialToggle = true,
  availableMonths,
  periodOptions,
}: {
  showSpecialToggle?: boolean
  availableMonths?: string[]
  periodOptions?: number[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()

  const months = Number(params.get('months')) || 3
  const excludeSpecial = params.get('special') === '0'
  const selectedMonth = params.get('month') ?? ''

  const update = (next: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(next)) {
      if (v === null) sp.delete(k)
      else sp.set(k, v)
    }
    startTransition(() => router.replace(`${pathname}?${sp.toString()}`, { scroll: false }))
  }

  const hasExactMonth = Boolean(selectedMonth)

  return (
    <div className={`flex flex-wrap items-center gap-2 ${pending ? 'opacity-70' : ''}`}>
      {availableMonths && availableMonths.length > 0 && (
        <select
          value={selectedMonth}
          onChange={(e) =>
            e.target.value
              ? update({ month: e.target.value, months: null })
              : update({ month: null })
          }
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm font-medium text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
        >
          <option value="">All</option>
          {availableMonths.map((ym) => (
            <option key={ym} value={ym}>
              {formatMonthLabel(ym)}
            </option>
          ))}
        </select>
      )}

      <div
        className={`inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface)] p-0.5 transition-opacity ${
          hasExactMonth ? 'opacity-40' : ''
        }`}
      >
        {buildOptions(periodOptions).map((o) => (
          <button
            key={o.months}
            onClick={() => update({ months: String(o.months), month: null })}
            className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
              !hasExactMonth && months === o.months
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
