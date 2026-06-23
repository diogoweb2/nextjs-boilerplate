'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card, EmptyHint } from '@/app/components/AppShell'
import { LineChart } from '@/app/components/charts/LineChart'
import { recordBalance, type EmergencyFundData } from '@/app/actions/emergency'
import { ACCOUNT_SOURCES, type FundSource } from '@/app/lib/emergency'
import { formatCurrency } from '@/app/lib/format'

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

  const bySource = new Map(data.accounts.map((a) => [a.source, a]))

  return (
    <Card title="Emergency Fund">
      <div className={pending ? 'opacity-70 transition-opacity' : ''}>
        {!data.hasData && (
          <EmptyHint>
            Enter the current balance of each account below to start tracking your emergency fund.
            The chequing accounts then update themselves from imported bank statements; the low-risk
            investment is manual — update it whenever it changes.
          </EmptyHint>
        )}

        {data.hasData && (
          <div className="mb-4">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Total emergency fund</p>
            <p className="text-3xl font-bold tabular-nums">{formatCurrency(data.total)}</p>
          </div>
        )}

        <div className="flex flex-col divide-y divide-[var(--border)]">
          {ACCOUNT_SOURCES.map(({ source, label, autoTracked }) => {
            const acct = bySource.get(source)
            const isEditing = editing === source || !acct
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
                    <span className="ml-2 text-xs text-[var(--muted)]">not set up</span>
                  )}
                  {acct && (
                    <span className="ml-2 text-xs text-[var(--muted)]">
                      {autoTracked ? 'since' : 'as of'} {acct.since}
                    </span>
                  )}
                </div>
                {isEditing ? (
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
