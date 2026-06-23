'use client'

import { useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'
import { LineChart, type LineSeries } from '@/app/components/charts/LineChart'
import { type IncomeData } from '@/app/lib/income'
import { REPORT_RANGES, type ReportRange } from '@/app/lib/custom-reports'
import { formatCurrency, formatCurrencyCompact, formatMonth } from '@/app/lib/format'

const ACCOUNTS: { value: string; label: string }[] = [
  { value: 'all', label: 'Both' },
  { value: 'tangerine', label: 'Tangerine' },
  { value: 'scotia', label: 'Scotia' },
]

/**
 * Income vs spending visuals. Range / account / special filters are URL-driven
 * (server recomputes); line visibility is local UI state. The Total-income and
 * Spending lines are emphasized; per-source income lines can be toggled.
 */
export function IncomeCharts({
  data,
  range,
  account,
  excludeSpecial,
}: {
  data: IncomeData
  range: ReportRange
  account: string
  excludeSpecial: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()

  // All toggleable lines: per-source income + Total income + Spending.
  const allLines = [
    ...data.incomeLines.map((l) => ({ key: l.name, color: l.color, values: l.values, dashed: false, width: 2 })),
    { key: data.totalIncome.name, color: data.totalIncome.color, values: data.totalIncome.values, dashed: false, width: 3 },
    { key: data.spending.name, color: data.spending.color, values: data.spending.values, dashed: true, width: 2.5 },
  ]
  // Default view: only Total income vs Spending. Per-source income lines start
  // hidden and can be toggled on via the legend.
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(data.incomeLines.map((l) => l.name)),
  )
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const series: LineSeries[] = allLines
    .filter((l) => !hidden.has(l.key))
    .map((l) => ({ name: l.key, color: l.color, values: l.values }))

  const update = (next: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(next)) {
      if (v === null) sp.delete(k)
      else sp.set(k, v)
    }
    startTransition(() => router.replace(`${pathname}?${sp.toString()}`, { scroll: false }))
  }

  const fmtLabels = data.labels.map(formatMonth)

  return (
    <div className={`flex flex-col gap-5 ${pending ? 'opacity-70' : ''}`}>
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface)] p-0.5">
          {REPORT_RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => update({ range: r.value })}
              className={`rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                range === r.value
                  ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                  : 'text-[var(--muted)] hover:text-[var(--foreground)]'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface)] p-0.5">
          {ACCOUNTS.map((a) => (
            <button
              key={a.value}
              onClick={() => update({ account: a.value === 'all' ? null : a.value })}
              className={`rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                account === a.value
                  ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                  : 'text-[var(--muted)] hover:text-[var(--foreground)]'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>

        <button
          onClick={() => update({ special: excludeSpecial ? '1' : '0' })}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            excludeSpecial
              ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)]'
              : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]'
          }`}
        >
          {excludeSpecial ? '✓ ' : ''}Exclude special
        </button>
      </div>

      {/* Income & spending line chart */}
      <div className="card p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Income vs spending</h2>
        </div>
        {series.length > 0 && data.labels.length > 0 ? (
          <LineChart labels={fmtLabels} series={series} area={false} height={240} />
        ) : (
          <p className="py-8 text-center text-sm text-[var(--muted)]">Nothing to plot.</p>
        )}
        {/* Legend / toggles */}
        <div className="mt-3 flex flex-wrap gap-2">
          {allLines.map((l) => {
            const off = hidden.has(l.key)
            return (
              <button
                key={l.key}
                onClick={() => toggle(l.key)}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-opacity ${
                  off ? 'opacity-40' : ''
                } border-[var(--border)] hover:bg-[var(--surface-2)]`}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />
                {l.key}
              </button>
            )
          })}
        </div>
      </div>

      {/* Net (income − spending) per month */}
      <div className="card p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Net per month (income − spending)</h2>
          <span className="text-xs text-[var(--muted)]">green = ahead · red = behind</span>
        </div>
        <NetBars labels={fmtLabels} values={data.net.values} />
      </div>
    </div>
  )
}

/** Simple diverging bar chart for monthly net (handles negatives). */
function NetBars({ labels, values }: { labels: string[]; values: number[] }) {
  const max = Math.max(1, ...values.map((v) => Math.abs(v)))
  return (
    <div className="flex items-stretch gap-1" style={{ height: 180 }}>
      {values.map((v, i) => {
        const pct = (Math.abs(v) / max) * 50 // half-height for each direction
        const positive = v >= 0
        return (
          <div key={i} className="group relative flex flex-1 flex-col items-center justify-center">
            <div className="flex h-full w-full flex-col">
              {/* top half (positive) */}
              <div className="flex flex-1 flex-col justify-end">
                {positive && (
                  <div
                    className="w-full rounded-t-sm bg-[var(--positive)]"
                    style={{ height: `${pct * 2}%` }}
                  />
                )}
              </div>
              {/* bottom half (negative) */}
              <div className="flex flex-1 flex-col justify-start">
                {!positive && (
                  <div
                    className="w-full rounded-b-sm bg-[var(--negative)]"
                    style={{ height: `${pct * 2}%` }}
                  />
                )}
              </div>
            </div>
            <span className="pointer-events-none absolute -top-1 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-[var(--foreground)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--background)] opacity-0 group-hover:opacity-100">
              {labels[i]}: {formatCurrency(v)}
            </span>
            <span className="mt-1 w-full truncate text-center text-[9px] text-[var(--muted)]">
              {formatCurrencyCompact(v)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
