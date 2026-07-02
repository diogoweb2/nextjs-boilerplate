'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'
import { SankeyChart } from '@/app/components/charts/SankeyChart'
import type { CashflowSankeyData } from '@/app/lib/cashflow-sankey'
import { REPORT_RANGES, type ReportRange } from '@/app/lib/custom-reports'
import { formatMonth } from '@/app/lib/format'

/**
 * Cash-flow Sankey with URL-driven range / exclude-special filters (server
 * recomputes, same pattern as IncomeCharts).
 */
export function CashflowCharts({
  data,
  range,
  month,
  monthOptions,
  excludeSpecial,
}: {
  data: CashflowSankeyData
  range: ReportRange
  /** Exact month (YYYY-MM) override; null = the range window is active. */
  month: string | null
  monthOptions: string[]
  excludeSpecial: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()

  const update = (next: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(next)) {
      if (v === null) sp.delete(k)
      else sp.set(k, v)
    }
    startTransition(() => router.replace(`${pathname}?${sp.toString()}`, { scroll: false }))
  }

  return (
    <div className={`flex flex-col gap-4 ${pending ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface)] p-0.5">
          {REPORT_RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => update({ range: r.value, month: null })}
              className={`rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                month === null && range === r.value
                  ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                  : 'text-[var(--muted)] hover:text-[var(--foreground)]'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        <select
          value={month ?? ''}
          onChange={(e) => update({ month: e.target.value || null })}
          className={`rounded-lg border px-2.5 py-1.5 text-sm font-medium transition-colors ${
            month !== null
              ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]'
              : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)]'
          }`}
        >
          <option value="">Exact month…</option>
          {monthOptions.map((m) => (
            <option key={m} value={m}>
              {formatMonth(m)}
            </option>
          ))}
        </select>

        <button
          onClick={() => update({ special: excludeSpecial ? '1' : '0' })}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            excludeSpecial
              ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]'
              : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--foreground)]'
          }`}
        >
          Exclude special
        </button>
      </div>

      <SankeyChart data={data} />
    </div>
  )
}
