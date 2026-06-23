'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  projectAccount,
  ACCOUNT_LABELS,
  type Account,
  type CardSource,
  type CardAccounts,
  type EventOverride,
  type ScheduledEvent,
} from '@/app/lib/cashflow'
import { saveCashflowConfig, type CashflowPlan } from '@/app/actions/cashflow'
import { formatCurrency, formatShortDate } from '@/app/lib/format'

const ACCOUNTS: Account[] = ['tangerine', 'scotia']

/**
 * "Safe to move" tool — the bottom half of the Emergency runway card. For each
 * chequing bank it projects the balance forward ~45 days (income in, bills + the
 * current card payment out, minus a manual unplanned-expense estimate), finds the
 * lowest point, and shows how much sits above a comfort buffer — i.e. cash you can
 * move to investment today. The projection is recomputed live (client-side) as the
 * unplanned-expense / buffer inputs change; the schedule editor persists overrides.
 * See BUSINESS_RULES.md §14.
 */
export function SafeToMoveWidget({ plan }: { plan: CashflowPlan }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editorOpen, setEditorOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)

  // Live, unsaved inputs (seeded from the persisted plan). The unplanned expense
  // is kept PER account; `pickAccount` is which one the input is editing.
  const [unplanned, setUnplanned] = useState<Record<Account, number>>(plan.unplannedExpense)
  const [pickAccount, setPickAccount] = useState<Account>('tangerine')
  const [buffers, setBuffers] = useState<Record<Account, number>>({
    tangerine: plan.accounts.find((a) => a.account === 'tangerine')?.buffer ?? 0,
    scotia: plan.accounts.find((a) => a.account === 'scotia')?.buffer ?? 0,
  })

  const results = useMemo(
    () =>
      plan.accounts.map((a) => ({
        ...a,
        result: projectAccount({
          account: a.account,
          startBalance: a.balance,
          events: a.events,
          today: plan.today,
          buffer: buffers[a.account] ?? 0,
          unplannedExpense: unplanned[a.account] ?? 0,
        }),
      })),
    [plan, buffers, unplanned],
  )

  // Unsaved changes to the unplanned-expense inputs (drives the Save button).
  const unplannedDirty = ACCOUNTS.some((a) => (unplanned[a] ?? 0) !== (plan.unplannedExpense[a] ?? 0))

  const persist = (patch: Parameters<typeof saveCashflowConfig>[0]) =>
    startTransition(async () => {
      await saveCashflowConfig(patch)
      router.refresh()
    })

  const totalSafe = results.reduce((s, r) => s + r.result.safeToMove, 0)

  return (
    <div className={`flex flex-col gap-4 ${pending ? 'opacity-70 transition-opacity' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            Safe to move to investment
            <button
              type="button"
              onClick={() => setInfoOpen((o) => !o)}
              aria-label="How this is calculated"
              aria-expanded={infoOpen}
              className={`grid h-4 w-4 place-items-center rounded-full border text-[10px] font-bold leading-none transition-colors ${
                infoOpen
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]'
                  : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]'
              }`}
            >
              i
            </button>
          </h3>
          <p className="text-xs text-[var(--muted)]">
            Cash above each account&apos;s buffer that isn&apos;t needed before your next pay.
          </p>
        </div>
        <button
          onClick={() => setEditorOpen((o) => !o)}
          className="shrink-0 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          {editorOpen ? 'done' : 'edit schedule'}
        </button>
      </div>

      {infoOpen && <InfoPanel plan={plan} />}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {results.map((a) => (
          <AccountCard key={a.account} label={a.label} balance={a.balance} buffer={buffers[a.account] ?? 0} result={a.result} />
        ))}
      </div>

      {totalSafe > 0.005 && (
        <p className="text-xs text-[var(--muted)]">
          Total you could move now:{' '}
          <span className="font-semibold text-[var(--positive)]">{formatCurrency(totalSafe)}</span>. If a month
          surprises you, just move it back from investment.
        </p>
      )}

      {/* Manual "big expense before next card payment" — recomputes live, saved
          explicitly so it survives reload. */}
      <div className="rounded-lg bg-[var(--surface-2)] px-3 py-2">
        <label className="text-xs font-medium">Expecting an unplanned expense before your next card payment?</label>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <select
            value={pickAccount}
            onChange={(e) => setPickAccount(e.target.value as Account)}
            className="rounded-lg border border-[var(--border)] bg-transparent px-2 py-1"
          >
            {ACCOUNTS.map((acc) => (
              <option key={acc} value={acc}>
                {ACCOUNT_LABELS[acc]}
              </option>
            ))}
          </select>
          <span className="text-[var(--muted)]">$</span>
          <input
            type="number"
            min={0}
            value={unplanned[pickAccount] || ''}
            onChange={(e) =>
              setUnplanned((u) => ({ ...u, [pickAccount]: Math.max(0, Number(e.target.value) || 0) }))
            }
            placeholder="0"
            className="w-28 rounded-lg border border-[var(--border)] bg-transparent px-2 py-1 text-right tabular-nums"
          />
          <button
            onClick={() => persist({ unplannedExpense: unplanned })}
            disabled={pending || !unplannedDirty}
            className="rounded-lg bg-[var(--accent)] px-3 py-1 font-medium text-[var(--accent-fg)] disabled:opacity-40"
          >
            {unplannedDirty ? 'Save' : 'Saved'}
          </button>
          <button
            onClick={() => {
              const cleared = { ...unplanned, [pickAccount]: 0 }
              setUnplanned(cleared)
              persist({ unplannedExpense: cleared })
            }}
            disabled={pending || ((unplanned[pickAccount] ?? 0) <= 0 && (plan.unplannedExpense[pickAccount] ?? 0) <= 0)}
            className="text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40"
          >
            Clear
          </button>
          <span className="text-[var(--muted)]">
            Set per account; updates the figures live; Save to keep it after reload.
          </span>
        </div>
      </div>

      {editorOpen && (
        <ScheduleEditor
          plan={plan}
          buffers={buffers}
          setBuffers={setBuffers}
          onSave={(patch) => persist(patch)}
        />
      )}
    </div>
  )
}

/** The "i" explanation of how each safe-to-move figure is calculated. */
function InfoPanel({ plan }: { plan: CashflowPlan }) {
  const cards =
    plan.cardAccounts.master === plan.cardAccounts.amex
      ? `both cards from ${ACCOUNT_LABELS[plan.cardAccounts.master]}`
      : `each card from its account`
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-[11px] leading-relaxed text-[var(--muted)]">
      <p className="mb-1.5 font-medium text-[var(--foreground)]">How the amount is figured</p>
      <p>
        For each chequing account we project the balance forward 45 days, day by day, then take the{' '}
        <span className="font-medium text-[var(--foreground)]">lowest point</span> it reaches before your pay
        replenishes it. Whatever sits above that low point (minus your buffer) is safe to move — you can always
        move it back from investment if a month surprises you.
      </p>
      <ul className="mt-1.5 flex flex-col gap-1">
        <li>
          <span className="text-[var(--foreground)]">Money in:</span> salary &amp; recurring deposits, on their
          usual day, into the account they land in.
        </li>
        <li>
          <span className="text-[var(--foreground)]">Money out:</span> your recurring bills on their due day, plus
          the credit-card payment — {cards} on{' '}
          <span className="text-[var(--foreground)]">day {plan.ccPaymentDay}</span> (the current statement
          balance), the most important date to be covered for.
        </li>
        <li>
          <span className="text-[var(--foreground)]">Pending cushion:</span> {formatCurrency(plan.ccPendingBuffer)}{' '}
          added to the card payment for charges still pending on the card that haven&apos;t exported to CSV yet.
        </li>
        <li>
          <span className="text-[var(--foreground)]">Buffer:</span> an extra cushion you set per account, kept on
          top of every bill above.
        </li>
        <li>
          <span className="text-[var(--foreground)]">Unplanned expense:</span> any one-off you add below is
          subtracted too.
        </li>
      </ul>
      <p className="mt-1.5">
        Bills you haven&apos;t paid in a while are treated as cancelled and dropped. Numbers are inferred from your
        statements — use <span className="text-[var(--foreground)]">edit schedule</span> to correct anything.
      </p>
    </div>
  )
}

function AccountCard({
  label,
  balance,
  buffer,
  result,
}: {
  label: string
  balance: number
  buffer: number
  result: ReturnType<typeof projectAccount>
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-lg font-semibold tabular-nums text-[var(--positive)]">
          {formatCurrency(result.safeToMove)}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">
        Balance {formatCurrency(balance)} · low point{' '}
        <span className="tabular-nums">{formatCurrency(result.trough)}</span> on{' '}
        {formatShortDate(result.troughDate)}
        {result.troughCause ? ` (after ${result.troughCause})` : ''}
        {buffer > 0 ? ` · keep ${formatCurrency(buffer)} buffer` : ''}.
      </p>
      <Sparkline timeline={result.timeline} buffer={buffer} />
      <p className="mt-1 text-[11px] text-[var(--muted)]">
        {result.nextPayday ? `Next pay ${formatShortDate(result.nextPayday)}.` : 'No income scheduled in window.'}
      </p>
    </div>
  )
}

/** Tiny balance-over-time line with a dashed buffer baseline and a trough dot. */
function Sparkline({ timeline, buffer }: { timeline: { date: string; balance: number }[]; buffer: number }) {
  const w = 240
  const h = 36
  if (timeline.length < 2) return null
  const ys = timeline.map((p) => p.balance)
  const lo = Math.min(buffer, ...ys)
  const hi = Math.max(buffer, ...ys)
  const span = hi - lo || 1
  const x = (i: number) => (i / (timeline.length - 1)) * w
  const y = (v: number) => h - ((v - lo) / span) * h
  const pts = timeline.map((p, i) => `${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ')
  const troughIdx = ys.indexOf(Math.min(...ys))
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-1.5 w-full" preserveAspectRatio="none" style={{ height: h }}>
      {buffer > 0 && (
        <line x1={0} x2={w} y1={y(buffer)} y2={y(buffer)} stroke="var(--warning)" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
      )}
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
      <circle cx={x(troughIdx)} cy={y(ys[troughIdx])} r={2.5} fill="var(--negative)" />
    </svg>
  )
}

/** Collapsible editor: per-account buffer + each inferred event's day/amount/
 *  account/enabled + the card→account mapping. Saves overrides on "Save". */
function ScheduleEditor({
  plan,
  buffers,
  setBuffers,
  onSave,
}: {
  plan: CashflowPlan
  buffers: Record<Account, number>
  setBuffers: (b: Record<Account, number>) => void
  onSave: (patch: {
    buffers: Record<Account, number>
    cardAccounts: CardAccounts
    ccPaymentDay: number
    ccPendingBuffer: number
    overrides: EventOverride[]
  }) => void
}) {
  // Per-event drafts (seeded from saved overrides) and the card mapping.
  const [drafts, setDrafts] = useState<Record<string, Partial<EventOverride>>>(() => {
    const seed: Record<string, Partial<EventOverride>> = {}
    for (const o of plan.overrides) seed[o.key] = { ...o }
    return seed
  })
  const [cardAccounts, setCardAccounts] = useState<CardAccounts>(plan.cardAccounts)
  const [ccPaymentDay, setCcPaymentDay] = useState(plan.ccPaymentDay)
  const [ccPendingBuffer, setCcPendingBuffer] = useState(plan.ccPendingBuffer)

  const val = <K extends keyof EventOverride>(e: ScheduledEvent, field: K): EventOverride[K] =>
    (drafts[e.key]?.[field] ?? (e[field as keyof ScheduledEvent] as EventOverride[K]))
  const enabled = (e: ScheduledEvent) => drafts[e.key]?.enabled !== false
  const edit = (key: string, patch: Partial<EventOverride>) =>
    setDrafts((d) => ({ ...d, [key]: { key, ...d[key], ...patch } }))

  const save = () => {
    const overrides: EventOverride[] = Object.values(drafts)
      .filter((o): o is EventOverride => Boolean(o.key))
      .map((o) => ({ ...o, key: o.key }))
    onSave({ buffers, cardAccounts, ccPaymentDay, ccPendingBuffer, overrides })
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-3 text-xs">
      <p className="text-[var(--muted)]">
        Inferred from your statements — correct anything that&apos;s off. Days are day-of-month; amounts are the
        expected payment.
      </p>

      {/* Card → account mapping + the shared payment day / pending cushion */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {(['master', 'amex'] as CardSource[]).map((card) => (
          <label key={card} className="flex items-center gap-1.5">
            <span className="font-medium">{card === 'master' ? 'Mastercard' : 'Amex'} paid from</span>
            <select
              value={cardAccounts[card]}
              onChange={(e) => setCardAccounts({ ...cardAccounts, [card]: e.target.value as Account })}
              className="rounded border border-[var(--border)] bg-transparent px-1.5 py-1"
            >
              {ACCOUNTS.map((acc) => (
                <option key={acc} value={acc}>
                  {ACCOUNT_LABELS[acc]}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="flex items-center gap-1.5">
          <span className="font-medium">Cards paid on day</span>
          <input
            type="number"
            min={1}
            max={28}
            value={ccPaymentDay}
            onChange={(e) => setCcPaymentDay(Math.min(28, Math.max(1, Number(e.target.value) || 1)))}
            className="w-14 rounded border border-[var(--border)] bg-transparent px-1.5 py-1 text-right tabular-nums"
          />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="font-medium">Pending cushion $</span>
          <input
            type="number"
            min={0}
            value={ccPendingBuffer || ''}
            onChange={(e) => setCcPendingBuffer(Math.max(0, Number(e.target.value) || 0))}
            placeholder="0"
            className="w-20 rounded border border-[var(--border)] bg-transparent px-1.5 py-1 text-right tabular-nums"
          />
        </label>
      </div>

      {plan.accounts.map((a) => (
        <div key={a.account} className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-semibold">{a.label}</span>
            <label className="flex items-center gap-1.5">
              <span className="text-[var(--muted)]">buffer $</span>
              <input
                type="number"
                min={0}
                value={buffers[a.account] || ''}
                onChange={(e) => setBuffers({ ...buffers, [a.account]: Math.max(0, Number(e.target.value) || 0) })}
                placeholder="0"
                className="w-20 rounded border border-[var(--border)] bg-transparent px-1.5 py-1 text-right tabular-nums"
              />
            </label>
          </div>
          {a.events.length === 0 && <p className="text-[var(--muted)]">No events inferred yet.</p>}
          {a.events.map((e) => (
            <div key={e.key} className={`flex items-center gap-1.5 ${enabled(e) ? '' : 'opacity-40'}`}>
              <input
                type="checkbox"
                checked={enabled(e)}
                onChange={(ev) => edit(e.key, { enabled: ev.target.checked })}
                className="accent-[var(--accent)]"
              />
              <span className="w-2 shrink-0 text-center" title={e.kind}>
                {e.kind === 'income' ? '↑' : e.kind === 'cc' ? '✦' : '↓'}
              </span>
              <span className="min-w-0 flex-1 truncate">{e.label}</span>
              <span className="text-[var(--muted)]">day</span>
              <input
                type="number"
                min={1}
                max={31}
                value={Number(val(e, 'dayOfMonth'))}
                onChange={(ev) => edit(e.key, { dayOfMonth: Math.min(31, Math.max(1, Number(ev.target.value) || 1)) })}
                className="w-12 rounded border border-[var(--border)] bg-transparent px-1 py-1 text-right tabular-nums"
              />
              <span className="text-[var(--muted)]">$</span>
              <input
                type="number"
                min={0}
                value={Number(val(e, 'amount'))}
                onChange={(ev) => edit(e.key, { amount: Math.max(0, Number(ev.target.value) || 0) })}
                className="w-20 rounded border border-[var(--border)] bg-transparent px-1 py-1 text-right tabular-nums"
              />
            </div>
          ))}
        </div>
      ))}

      <div className="flex justify-end">
        <button
          onClick={save}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--accent-fg)]"
        >
          Save schedule
        </button>
      </div>
    </div>
  )
}
