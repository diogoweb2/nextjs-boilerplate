'use client'

/**
 * "Available to give a job" — sits beside the Net-trajectory (Year) chart. That
 * chart says how far the year is from its Dec 31 target; this says what's in
 * hand to close it.
 *
 * Deliberately three facts and no more: what's available, what to leave behind
 * for the year's target, and what a normal month looks like (so a 3-paycheque
 * month isn't mistaken for repeatable capacity). Everything else — the split
 * itself — belongs to the surplus prompt when the month closes.
 */

import { formatCurrency, formatMonth } from '@/app/lib/format'
import type { PendingSurplus } from '@/app/lib/surplus'

export function PendingSurplusCard({ data }: { data: PendingSurplus }) {
  const { net, daysToClose, minForTarget, month, extraCheque, typicalNet } = data
  const hasSurplus = net > 0
  const closes =
    daysToClose === 0 ? 'closes tonight' : daysToClose === 1 ? 'closes tomorrow' : `${daysToClose} days left`

  return (
    <div className="flex flex-col gap-3">
      {/* Two headline figures of equal weight: what landed this month, and what
          a month without the extra paycheque actually nets. The second is the
          one that says whether the first is repeatable. */}
      <div className="flex flex-col gap-4">
        <Stat
          label="This month"
          value={formatCurrency(Math.max(0, net))}
          sub={`${formatMonth(month)} · ${closes}`}
          color={hasSurplus ? 'var(--positive)' : 'var(--muted)'}
        />
        {typicalNet != null && (
          <Stat
            label="A 2-paycheque month"
            value={formatCurrency(typicalNet)}
            sub={`this month had 3 · the extra was ${formatCurrency(extraCheque)}`}
            color="var(--foreground)"
          />
        )}
      </div>

      {hasSurplus && minForTarget != null && (
        <dl className="border-t border-[var(--border)] pt-3 text-sm">
          <Row label="Leave for the year's target" value={formatCurrency(minForTarget)} />
        </dl>
      )}

      {!hasSurplus && (
        <p className="text-sm text-[var(--muted)]">
          {formatMonth(month)} is down {formatCurrency(-net)} — nothing to allocate yet.
        </p>
      )}
    </div>
  )
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="text-3xl font-bold tabular-nums" style={{ color }}>
        {value}
      </div>
      <div className="text-xs text-[var(--muted)]">{sub}</div>
    </div>
  )
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd
        className="font-semibold tabular-nums"
        style={{ color: muted ? 'var(--muted)' : 'var(--foreground)' }}
      >
        {value}
      </dd>
    </div>
  )
}
