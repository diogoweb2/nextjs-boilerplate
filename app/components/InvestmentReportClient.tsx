'use client'

import { useEffect } from 'react'
import { formatCurrency, formatCurrencyCompact, formatLongDate } from '@/app/lib/format'
import { INVESTMENT_REPORT_SEEN_KEY } from '@/app/lib/investmentReportSchedule'
import type { InvestmentReport, PositionMove, BucketAllocation } from '@/app/lib/investmentReport'

const BUCKET_LABEL: Record<string, string> = {
  equity: 'Equities', bonds: 'Bonds', cash: 'Cash', other: 'Other',
}
const BUCKET_COLOR: Record<string, string> = {
  equity: 'var(--accent)', bonds: '#a855f7', cash: '#14b8a6', other: 'var(--muted)',
}

function Delta({ value, pct }: { value: number; pct?: number | null }) {
  const positive = value >= 0
  return (
    <span className={`tabular-nums ${positive ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
      {positive ? '▲' : '▼'} {formatCurrency(Math.abs(value))}
      {pct != null && ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`}
    </span>
  )
}

export function InvestmentReportClient({ report }: { report: InvestmentReport }) {
  // Mark this snapshot as seen so the dashboard reminder stops nagging (device-local).
  useEffect(() => {
    if (report.ok && report.toDate) {
      localStorage.setItem(INVESTMENT_REPORT_SEEN_KEY, report.toDate)
      window.dispatchEvent(new Event('investmentReportChange'))
    }
  }, [report.ok, report.toDate])

  if (!report.ok) {
    return (
      <div className="card p-6 text-center text-sm text-[var(--muted)]">
        {report.reason}
      </div>
    )
  }

  const r = report
  const dipTone =
    r.dip.level === 'buy' ? { border: 'var(--positive)', bg: 'rgba(34,197,94,0.10)', icon: '🟢' }
    : r.dip.level === 'watch' ? { border: 'var(--warning)', bg: 'rgba(234,179,8,0.10)', icon: '🟡' }
    : { border: 'var(--border)', bg: 'var(--surface-2)', icon: '⚪️' }

  return (
    <div className="flex flex-col gap-5">
      {/* Headline */}
      <section className="card p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Investment report</h1>
            <p className="text-xs text-[var(--muted)]">
              What changed from {formatLongDate(r.fromDate)} to {formatLongDate(r.toDate)}
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold tabular-nums">{formatCurrencyCompact(r.valueNow)}</div>
            <div className="text-[11px] text-[var(--muted)]">total value (CAD)</div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Stat label="Total change" value={<Delta value={r.deltaCad} />} />
          <Stat
            label="Market change (excl. deposits)"
            value={<Delta value={r.marketDeltaCad} pct={r.marketDeltaPct} />}
          />
          <Stat
            label="New money in"
            value={<span className="tabular-nums">{r.contributionsInWindow >= 0 ? '+' : '−'}{formatCurrency(Math.abs(r.contributionsInWindow))}</span>}
          />
        </div>
      </section>

      {/* The decision aid — bonds / dip signal */}
      <section
        className="card p-5"
        style={{ borderColor: dipTone.border, background: dipTone.bg }}
      >
        <div className="flex items-start gap-3">
          <span className="text-xl leading-none">{dipTone.icon}</span>
          <div className="flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">
                {r.dip.rotateOpportunity ? 'Consider moving bonds → equities' : 'Bond rotation check'}
              </h2>
              <span className="text-xs text-[var(--muted)] tabular-nums">
                {Math.round(r.bondPct)}% in bonds/cash · {r.dip.drawdownPct <= 0 ? `${r.dip.drawdownPct.toFixed(1)}%` : `+${r.dip.drawdownPct.toFixed(1)}%`} vs peak
              </span>
            </div>
            <p className="mt-1 text-sm">{r.dip.message}</p>
            <p className="mt-1.5 text-[11px] text-[var(--muted)]">
              Peak {formatCurrency(r.dip.peakValue)} on {formatLongDate(r.dip.peakDate)} · now {formatCurrency(r.dip.currentValue)}.
              A deterministic drawdown signal — no live prices or advice; you decide.
            </p>
          </div>
        </div>
      </section>

      {/* Allocation */}
      <section className="card p-5">
        <h2 className="mb-3 text-sm font-semibold">Allocation</h2>
        <AllocationBar allocation={r.allocation} total={r.valueNow} />
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {r.allocation.map((b) => (
            <div key={b.bucket} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: BUCKET_COLOR[b.bucket] }} />
                {BUCKET_LABEL[b.bucket]} <span className="text-[var(--muted)]">{b.pct.toFixed(0)}%</span>
              </span>
              <span className="flex items-center gap-2 tabular-nums">
                {formatCurrency(b.valueCad)}
                {b.deltaCad !== 0 && (
                  <span className={`text-[11px] ${b.deltaCad >= 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
                    {b.deltaCad >= 0 ? '+' : '−'}{formatCurrency(Math.abs(b.deltaCad))}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Biggest movers */}
      {r.topMovers.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold">Biggest movers this month</h2>
          <MoversTable movers={r.topMovers} />
        </section>
      )}

      {/* Per account */}
      <section className="flex flex-col gap-4">
        {r.accounts.map((a) => (
          <div key={a.id} className="card p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm font-semibold">{a.name} <span className="font-normal text-[var(--muted)]">· {a.ownerName}</span></div>
              <div className="text-right">
                <div className="text-lg font-bold tabular-nums">{formatCurrency(a.valueNow)}</div>
                <div className="text-[11px]"><Delta value={a.marketDeltaCad} pct={a.marketDeltaPct} /> market</div>
              </div>
            </div>
            {a.contributionsInWindow !== 0 && (
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                Includes {a.contributionsInWindow >= 0 ? '+' : '−'}{formatCurrency(Math.abs(a.contributionsInWindow))} new money in.
              </p>
            )}
            {a.movers.length > 0 && <div className="mt-3"><MoversTable movers={a.movers.slice(0, 5)} compact /></div>}
          </div>
        ))}
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div className="text-[11px] text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-base font-semibold">{value}</div>
    </div>
  )
}

function AllocationBar({ allocation }: { allocation: BucketAllocation[]; total: number }) {
  return (
    <div className="flex h-3 overflow-hidden rounded-full bg-[var(--surface-2)]">
      {allocation.filter((b) => b.pct > 0).map((b) => (
        <div key={b.bucket} style={{ width: `${b.pct}%`, background: BUCKET_COLOR[b.bucket] }} title={`${BUCKET_LABEL[b.bucket]} ${b.pct.toFixed(0)}%`} />
      ))}
    </div>
  )
}

function MoversTable({ movers, compact }: { movers: PositionMove[]; compact?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <tbody>
          {movers.map((m) => (
            <tr key={m.symbol} className="border-t border-[var(--border)] first:border-t-0">
              <td className="py-1.5 pr-2">
                <span className="font-medium">{m.symbol}</span>
                {m.isNew && <span className="ml-1.5 rounded bg-[var(--surface-2)] px-1 text-[9px] text-[var(--muted)]">NEW</span>}
                {m.isGone && <span className="ml-1.5 rounded bg-[var(--surface-2)] px-1 text-[9px] text-[var(--muted)]">SOLD</span>}
                {!compact && <div className="text-[11px] text-[var(--muted)]">{m.name}</div>}
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--muted)]">{formatCurrency(m.valueNow)}</td>
              <td className="py-1.5 pl-2 text-right">
                <Delta value={m.deltaCad} pct={m.deltaPct} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
