'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { ReportSeries } from '@/db/schema'
import {
  type ReportRange,
  type ComputedReport,
  type ComputedLine,
  REPORT_RANGES,
  SERIES_COLORS,
  nextSeriesColor,
} from '@/app/lib/custom-reports'
import {
  createReport,
  updateReport,
  setReportPinned,
  deleteReport,
  previewReport,
} from '@/app/actions/custom-reports'
import { LineChart } from '@/app/components/charts/LineChart'
import { Card } from '@/app/components/AppShell'
import { formatCurrency, formatMonth } from '@/app/lib/format'

export type CategoryOption = { id: number; name: string; color: string }
export type MerchantOption = { id: number; name: string; total: number }
export type SavedReport = {
  id: number
  name: string
  pinned: boolean
  range: ReportRange
  series: ReportSeries[]
  computed: ComputedReport
}

type DraftLine = ReportSeries
type Draft = { name: string; range: ReportRange; lines: DraftLine[] }

const emptyDraft = (): Draft => ({
  name: '',
  range: '6',
  lines: [{ name: 'Line 1', color: SERIES_COLORS[0], categoryIds: [], merchantIds: [] }],
})

function lineHasSelection(l: DraftLine): boolean {
  return l.categoryIds.length > 0 || l.merchantIds.length > 0
}

export function CustomReports({
  categories,
  merchants,
  reports,
}: {
  categories: CategoryOption[]
  merchants: MerchantOption[]
  reports: SavedReport[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const builderRef = useRef<HTMLDivElement>(null)

  const pinned = reports.filter((r) => r.pinned)
  const unpinned = reports.filter((r) => !r.pinned)

  const run = (fn: () => Promise<void>) =>
    startTransition(async () => {
      await fn()
      router.refresh()
    })

  const resetBuilder = () => {
    setEditingId(null)
    setDraft(emptyDraft())
  }

  const startEdit = (r: SavedReport) => {
    setEditingId(r.id)
    setDraft({ name: r.name, range: r.range, lines: r.series.map((s) => ({ ...s })) })
    builderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const validLines = draft.lines.filter(lineHasSelection)
  const canSave = validLines.length > 0

  const save = (pin?: boolean) => {
    if (!canSave) return
    const payload = { name: draft.name, range: draft.range, series: validLines }
    run(async () => {
      if (editingId != null) await updateReport(editingId, payload)
      else await createReport({ ...payload, pinned: pin ?? false })
      resetBuilder()
    })
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ---- Builder ---- */}
      <div ref={builderRef}>
        <Card
          title={editingId != null ? 'Edit report' : 'Build a report'}
          action={
            editingId != null ? (
              <button
                onClick={resetBuilder}
                className="text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                Cancel
              </button>
            ) : null
          }
        >
          <ReportBuilder
            draft={draft}
            setDraft={setDraft}
            categories={categories}
            merchants={merchants}
          />

          <div className="mt-4 flex flex-col gap-3 border-t border-[var(--border)] pt-4 sm:flex-row sm:items-center">
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Report name (e.g. Supermarkets)"
              className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
            <div className="flex gap-2">
              {editingId != null ? (
                <button
                  onClick={() => save()}
                  disabled={!canSave || pending}
                  className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] disabled:opacity-40"
                >
                  Update
                </button>
              ) : (
                <>
                  <button
                    onClick={() => save(false)}
                    disabled={!canSave || pending}
                    className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--foreground)] disabled:opacity-40 hover:bg-[var(--surface-2)]"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => save(true)}
                    disabled={!canSave || pending}
                    className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] disabled:opacity-40"
                  >
                    Save &amp; pin
                  </button>
                </>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* ---- Pinned reports (always shown as charts) ---- */}
      {pinned.map((r) => (
        <ReportCard
          key={r.id}
          report={r}
          onEdit={() => startEdit(r)}
          onPinToggle={() => run(() => setReportPinned(r.id, false))}
          onDelete={() => run(() => deleteReport(r.id))}
          onRangeChange={(range) => run(() => updateReport(r.id, { range }))}
          busy={pending}
        />
      ))}

      {/* ---- Saved (unpinned) reports ---- */}
      {unpinned.length > 0 && (
        <Card title="Saved reports">
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {unpinned.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex shrink-0 -space-x-1">
                    {r.series.slice(0, 4).map((s, i) => (
                      <span
                        key={i}
                        className="h-2.5 w-2.5 rounded-full ring-1 ring-[var(--surface)]"
                        style={{ background: s.color }}
                      />
                    ))}
                  </div>
                  <span className="truncate text-sm font-medium">{r.name}</span>
                  <span className="shrink-0 text-xs text-[var(--muted)]">
                    {r.series.length} line{r.series.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1 text-xs">
                  <button
                    onClick={() => run(() => setReportPinned(r.id, true))}
                    disabled={pending}
                    className="rounded-md px-2 py-1 font-medium text-[var(--accent)] hover:bg-[var(--surface-2)]"
                  >
                    Pin
                  </button>
                  <button
                    onClick={() => startEdit(r)}
                    className="rounded-md px-2 py-1 font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => run(() => deleteReport(r.id))}
                    disabled={pending}
                    className="rounded-md px-2 py-1 font-medium text-[var(--muted)] hover:text-[var(--negative)]"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Builder: edit lines + live preview
// ---------------------------------------------------------------------------

function ReportBuilder({
  draft,
  setDraft,
  categories,
  merchants,
}: {
  draft: Draft
  setDraft: React.Dispatch<React.SetStateAction<Draft>>
  categories: CategoryOption[]
  merchants: MerchantOption[]
}) {
  const setLine = (idx: number, patch: Partial<DraftLine>) =>
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
    }))

  const addLine = () =>
    setDraft((d) => ({
      ...d,
      lines: [
        ...d.lines,
        {
          name: `Line ${d.lines.length + 1}`,
          color: nextSeriesColor(d.lines.length),
          categoryIds: [],
          merchantIds: [],
        },
      ],
    }))

  const removeLine = (idx: number) =>
    setDraft((d) => ({ ...d, lines: d.lines.filter((_, i) => i !== idx) }))

  return (
    <div className="flex flex-col gap-4">
      {draft.lines.map((line, idx) => (
        <LineEditor
          key={idx}
          line={line}
          index={idx}
          canRemove={draft.lines.length > 1}
          categories={categories}
          merchants={merchants}
          onChange={(patch) => setLine(idx, patch)}
          onRemove={() => removeLine(idx)}
        />
      ))}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={addLine}
          className="rounded-lg border border-dashed border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          + Add line
        </button>
        <RangeToggle value={draft.range} onChange={(range) => setDraft((d) => ({ ...d, range }))} />
      </div>

      <BuilderPreview lines={draft.lines.filter(lineHasSelection)} range={draft.range} />
    </div>
  )
}

function LineEditor({
  line,
  index,
  canRemove,
  categories,
  merchants,
  onChange,
  onRemove,
}: {
  line: DraftLine
  index: number
  canRemove: boolean
  categories: CategoryOption[]
  merchants: MerchantOption[]
  onChange: (patch: Partial<DraftLine>) => void
  onRemove: () => void
}) {
  const toggle = (key: 'categoryIds' | 'merchantIds', id: number) => {
    const set = new Set(line[key])
    if (set.has(id)) set.delete(id)
    else set.add(id)
    onChange({ [key]: [...set] } as Partial<DraftLine>)
  }

  return (
    <div className="rounded-xl border border-[var(--border)] p-3">
      <div className="mb-3 flex items-center gap-2">
        <ColorPicker value={line.color} onChange={(color) => onChange({ color })} />
        <input
          value={line.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={`Line ${index + 1}`}
          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
        />
        {canRemove && (
          <button
            onClick={onRemove}
            className="rounded-md px-2 py-1 text-xs font-medium text-[var(--muted)] hover:text-[var(--negative)]"
            title="Remove line"
          >
            ✕
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Categories
          </p>
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c) => {
              const on = line.categoryIds.includes(c.id)
              return (
                <button
                  key={c.id}
                  onClick={() => toggle('categoryIds', c.id)}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                    on
                      ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--foreground)]'
                      : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]'
                  }`}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: c.color }} />
                  {c.name}
                </button>
              )
            })}
          </div>
        </div>

        <MerchantPicker
          merchants={merchants}
          selected={line.merchantIds}
          onToggle={(id) => toggle('merchantIds', id)}
        />
      </div>
    </div>
  )
}

function MerchantPicker({
  merchants,
  selected,
  onToggle,
}: {
  merchants: MerchantOption[]
  selected: number[]
  onToggle: (id: number) => void
}) {
  const [query, setQuery] = useState('')
  const selectedSet = new Set(selected)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = merchants.filter((m) => !q || m.name.toLowerCase().includes(q))
    // Selected first, then by spend (merchants already arrive sorted by spend).
    return matches
      .slice()
      .sort((a, b) => Number(selectedSet.has(b.id)) - Number(selectedSet.has(a.id)))
      .slice(0, 40)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchants, query, selected])

  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
        Merchants {selected.length > 0 && `(${selected.length})`}
      </p>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search merchants…"
        className="mb-1.5 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
      />
      <div className="max-h-32 overflow-y-auto rounded-lg border border-[var(--border)]">
        {filtered.map((m) => {
          const on = selectedSet.has(m.id)
          return (
            <button
              key={m.id}
              onClick={() => onToggle(m.id)}
              className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs ${
                on ? 'bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]' : 'hover:bg-[var(--surface-2)]'
              }`}
            >
              <span className="flex items-center gap-2 truncate">
                <span
                  className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded border text-[8px] ${
                    on ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]' : 'border-[var(--border)]'
                  }`}
                >
                  {on ? '✓' : ''}
                </span>
                <span className="truncate">{m.name}</span>
              </span>
              <span className="shrink-0 tabular-nums text-[var(--muted)]">
                {formatCurrency(m.total)}
              </span>
            </button>
          )
        })}
        {filtered.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-[var(--muted)]">No merchants match.</p>
        )}
      </div>
    </div>
  )
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="h-7 w-7 rounded-lg border border-[var(--border)]"
        style={{ background: value }}
        title="Line colour"
      />
      {open && (
        <div className="absolute left-0 top-9 z-10 grid grid-cols-5 gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 shadow-lg">
          {SERIES_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => {
                onChange(c)
                setOpen(false)
              }}
              className="h-5 w-5 rounded-md ring-1 ring-[var(--border)]"
              style={{ background: c }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function RangeToggle({
  value,
  onChange,
}: {
  value: ReportRange
  onChange: (r: ReportRange) => void
}) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-[var(--border)] bg-[var(--surface)] p-0.5">
      {REPORT_RANGES.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            value === o.value
              ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
              : 'text-[var(--muted)] hover:text-[var(--foreground)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Live preview that recomputes on the server (debounced) as the draft changes. */
function BuilderPreview({ lines, range }: { lines: DraftLine[]; range: ReportRange }) {
  const [data, setData] = useState<ComputedReport | null>(null)
  const [loading, setLoading] = useState(false)
  const key = JSON.stringify({ lines, range })

  useEffect(() => {
    if (lines.length === 0) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const result = await previewReport(lines, range)
        if (!cancelled) setData(result)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (lines.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] py-10 text-center text-sm text-[var(--muted)]">
        Pick a category or merchant to preview your chart.
      </div>
    )
  }

  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      {data ? <ReportChart data={data} /> : <div className="py-10" />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chart + legend (shared by preview and saved/pinned cards)
// ---------------------------------------------------------------------------

function ReportChart({ data }: { data: ComputedReport }) {
  if (data.labels.length === 0) {
    return <p className="py-8 text-center text-sm text-[var(--muted)]">No data in this range.</p>
  }
  const currentLabel = data.labels[data.labels.length - 1]
  return (
    <div className="flex flex-col gap-3">
      <LineChart
        labels={data.labels}
        area={data.lines.length === 1}
        series={data.lines.map((l) => ({ color: l.color, values: l.values, name: l.name }))}
      />
      <ul className="flex flex-col gap-2">
        {data.lines.map((l, i) => (
          <LineLegend key={i} line={l} currentLabel={currentLabel} />
        ))}
      </ul>
    </div>
  )
}

function LineLegend({ line, currentLabel }: { line: ComputedLine; currentLabel: string }) {
  const overTarget = line.target != null && line.current > line.target
  return (
    <li className="flex flex-col gap-0.5 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span className="flex items-center gap-2 font-medium">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: line.color }} />
        {line.name}
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--muted)]">
        <span>
          avg <span className="font-semibold text-[var(--foreground)]">{formatCurrency(line.average)}</span>/mo
        </span>
        {line.target != null && (
          <span title={`Median of complete months in range`}>
            target <span className="font-semibold text-[var(--foreground)]">{formatCurrency(line.target)}</span>
          </span>
        )}
        <span>
          {formatMonth(currentLabel)} so far{' '}
          <span
            className={`font-semibold ${
              line.target == null
                ? 'text-[var(--foreground)]'
                : overTarget
                  ? 'text-[var(--negative)]'
                  : 'text-[var(--positive)]'
            }`}
          >
            {formatCurrency(line.current)}
          </span>
          {line.target != null &&
            (overTarget
              ? ` · ${formatCurrency(line.current - line.target)} over target`
              : ` · on track`)}
        </span>
      </span>
    </li>
  )
}

function ReportCard({
  report,
  onEdit,
  onPinToggle,
  onDelete,
  onRangeChange,
  busy,
}: {
  report: SavedReport
  onEdit: () => void
  onPinToggle: () => void
  onDelete: () => void
  onRangeChange: (range: ReportRange) => void
  busy: boolean
}) {
  return (
    <Card
      title={report.name}
      action={
        <div className="flex items-center gap-1 text-xs">
          <RangeToggle value={report.range} onChange={onRangeChange} />
          <button
            onClick={onEdit}
            className="rounded-md px-2 py-1 font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            Edit
          </button>
          <button
            onClick={onPinToggle}
            disabled={busy}
            className="rounded-md px-2 py-1 font-medium text-[var(--accent)] hover:bg-[var(--surface-2)]"
            title="Unpin"
          >
            ★
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="rounded-md px-2 py-1 font-medium text-[var(--muted)] hover:text-[var(--negative)]"
          >
            Delete
          </button>
        </div>
      }
    >
      <ReportChart data={report.computed} />
    </Card>
  )
}
