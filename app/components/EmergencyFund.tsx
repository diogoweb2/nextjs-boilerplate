'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card, EmptyHint } from '@/app/components/AppShell'
import { LineChart } from '@/app/components/charts/LineChart'
import {
  recordBalance,
  setEmergencyTfsaMode,
  setEmergencyTfsaHaircut,
  type EmergencyFundData,
} from '@/app/actions/emergency'
import { ACCOUNT_SOURCES, type FundSource } from '@/app/lib/emergency'
import type { TfsaEmergencyMode } from '@/db/schema'
import { formatCurrency } from '@/app/lib/format'

const TFSA_MODE_LABELS: Record<TfsaEmergencyMode, string> = {
  crash_adjusted: 'Crash-adj.',
  cash_equivalent: 'Cash reserve',
  whole: 'Whole',
}

/**
 * Emergency Fund card on the Goals page: total cash across Tangerine + Scotia,
 * tracked automatically from imported bank flows, with a manual "update balance"
 * per account and a history line chart. See BUSINESS_RULES.md §12.
 */
export function EmergencyFund({ data }: { data: EmergencyFundData }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState<FundSource | null>(null)

  const save = (source: FundSource, balance: number, occurredAt: string) =>
    startTransition(async () => {
      await recordBalance({ source, balance, occurredAt })
      setEditing(null)
      router.refresh()
    })

  const setMode = (mode: TfsaEmergencyMode) =>
    startTransition(async () => {
      await setEmergencyTfsaMode(mode)
      router.refresh()
    })

  const setHaircut = (pct: number) =>
    startTransition(async () => {
      await setEmergencyTfsaHaircut(pct)
      router.refresh()
    })

  const bySource = new Map(data.accounts.map((a) => [a.source, a]))

  return (
    <Card title="Emergency Fund">
      <div className={pending ? 'opacity-70 transition-opacity' : ''}>
        {!data.hasData && (
          <EmptyHint>
            Enter the current balance of each account below to start tracking your emergency fund.
            The chequing accounts then update themselves from imported bank statements; the TFSA line
            is tracked automatically from your iTrade holdings.
          </EmptyHint>
        )}

        {data.hasData && (
          <div className="mb-4">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Total emergency fund</p>
            <p className="text-3xl font-bold tabular-nums">{formatCurrency(data.total)}</p>
          </div>
        )}

        <div className="flex flex-col divide-y divide-[var(--border)]">
          {ACCOUNT_SOURCES.map(({ source, label, autoTracked, derived }) => {
            const acct = bySource.get(source)
            const isEditing = !derived && (editing === source || !acct)
            return (
              <div key={source} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <span className="font-medium">{label}</span>
                  {!autoTracked && (
                    <span className="ml-2 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                      manual
                    </span>
                  )}
                  {acct ? (
                    <span className="ml-2 tabular-nums">{formatCurrency(acct.balance)}</span>
                  ) : (
                    <span className="ml-2 text-xs text-[var(--muted)]">
                      {derived ? 'no TFSA holdings yet' : 'not set up'}
                    </span>
                  )}
                  {acct && (
                    <span className="ml-2 text-xs text-[var(--muted)]">
                      {autoTracked ? 'since' : 'as of'} {acct.since}
                    </span>
                  )}
                </div>
                {derived ? (
                  <div className="flex items-center gap-1">
                    {(['crash_adjusted', 'cash_equivalent', 'whole'] as const).map((m) => {
                      const active = data.effectiveTfsaMode === m
                      const locked = m === 'cash_equivalent' && !data.cashReserveAvailable
                      return (
                        <button
                          key={m}
                          disabled={locked || pending}
                          title={locked ? data.tfsaModeReason ?? undefined : undefined}
                          onClick={() => setMode(m)}
                          className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                            active
                              ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                              : 'text-[var(--muted)] hover:text-[var(--foreground)]'
                          } ${locked ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          {locked ? '🔒 ' : ''}
                          {TFSA_MODE_LABELS[m]}
                        </button>
                      )
                    })}
                  </div>
                ) : isEditing ? (
                  <BalanceEditor
                    source={source}
                    onSave={save}
                    onCancel={acct ? () => setEditing(null) : undefined}
                    cta={acct ? 'Update' : 'Set starting balance'}
                  />
                ) : (
                  <button
                    onClick={() => setEditing(source)}
                    className="rounded-md px-2 py-1 text-xs text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]"
                  >
                    Update balance
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {data.effectiveTfsaMode === 'crash_adjusted' && (
          <HaircutEditor key={data.tfsaHaircutPct} pct={data.tfsaHaircutPct} pending={pending} onSave={setHaircut} />
        )}

        {data.tfsaModeReason && (
          <p className="mt-2 rounded-lg bg-[var(--surface-2)] px-2.5 py-1.5 text-[11px] text-[var(--muted)]">
            🔒 {data.tfsaModeReason}
          </p>
        )}

        {data.series.length > 1 && (
          <div className="mt-5 border-t border-[var(--border)] pt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              History
            </h3>
            <LineChart
              labels={data.series.map((p) => p.ym)}
              series={[{ color: '#0ea5e9', values: data.series.map((p) => p.total), name: 'Emergency fund' }]}
            />
            <p className="mt-2 text-xs text-[var(--muted)]">
              Watch for a steady climb — a good cue to move surplus cash into investments.
            </p>
          </div>
        )}
      </div>
    </Card>
  )
}

/** Inline editor for the crash haircut %, shown when crash-adjusted mode is active.
 *  Seeded from the saved value (the parent keys it by pct so it resets on save). */
function HaircutEditor({
  pct,
  pending,
  onSave,
}: {
  pct: number
  pending: boolean
  onSave: (pct: number) => void
}) {
  const [value, setValue] = useState(String(pct))
  const submit = () => {
    const n = Number(value)
    if (Number.isFinite(n) && n !== pct) onSave(n)
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-[var(--surface-2)] px-2.5 py-1.5 text-[11px] text-[var(--muted)]">
      <span>Crash haircut</span>
      <span className="inline-flex items-center">
        <input
          type="number"
          inputMode="numeric"
          value={value}
          disabled={pending}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          onBlur={submit}
          className="w-12 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-right tabular-nums outline-none focus:border-[var(--accent)]"
        />
        <span className="ml-0.5">%</span>
      </span>
      <span>
        — counts {Math.max(0, 100 - pct)}% of your TFSA, the assumed value left after a market crash
        (≈30% for an 80/20 ETF like XGRO).
      </span>
    </div>
  )
}

function BalanceEditor({
  source,
  onSave,
  onCancel,
  cta,
}: {
  source: FundSource
  onSave: (source: FundSource, balance: number, occurredAt: string) => void
  onCancel?: () => void
  cta: string
}) {
  const [value, setValue] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const submit = () => {
    const n = Number(value)
    if (Number.isFinite(n) && n >= 0 && value.trim() !== '') onSave(source, n, date)
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="Balance"
        className="w-28 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
      />
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
      />
      <button
        onClick={submit}
        className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[var(--accent-fg)]"
      >
        {cta}
      </button>
      {onCancel && (
        <button
          onClick={onCancel}
          className="rounded-md px-2 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          Cancel
        </button>
      )}
    </div>
  )
}
