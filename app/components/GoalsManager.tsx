'use client'

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Card, EmptyHint } from '@/app/components/AppShell'
import { LineChart } from '@/app/components/charts/LineChart'
import { formatCurrency, formatCurrencyCompact, formatMonth } from '@/app/lib/format'
import {
  createGoal,
  createNetZeroGoal,
  updateGoal,
  reorderGoals,
  archiveGoal,
  deleteGoal,
  toggleNotify,
  addContribution,
  adjustValue,
  updateMortgageBalance,
  type GoalView,
} from '@/app/actions/goals'

const INPUT_CLASS =
  'rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]'
const PRIMARY_BTN =
  'rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-fg)] disabled:opacity-40'
const GHOST_BTN =
  'rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)]'

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#ef4444', '#8b5cf6', '#84cc16']

type DragProps = {
  dragging: boolean
  isOver: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragEnter: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragEnd: () => void
  onDrop: (e: React.DragEvent) => void
}

/**
 * Drag-to-reorder for the active goal cards. Keeps an optimistic local order that
 * reshuffles live as you drag, then persists the final arrangement via
 * `reorderGoals`. Resyncs whenever the server-provided list changes (add/remove/
 * archive or a confirmed reorder).
 */
function useReorder(active: GoalView[]) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const serverOrder = active.map((g) => g.id)
  const serverKey = serverOrder.join(',')
  const [order, setOrder] = useState<number[]>(serverOrder)
  const orderRef = useRef<number[]>(order)
  orderRef.current = order
  const dragId = useRef<number | null>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [overId, setOverId] = useState<number | null>(null)

  // Resync when the server's set/ordering of active goals changes.
  useEffect(() => {
    setOrder(serverOrder)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey])

  const byId = new Map(active.map((g) => [g.id, g]))
  const items = order.map((id) => byId.get(id)).filter((g): g is GoalView => Boolean(g))

  const moveBefore = (sourceId: number, targetId: number) => {
    if (sourceId === targetId) return
    setOrder((prev) => {
      const next = prev.filter((id) => id !== sourceId)
      const idx = next.indexOf(targetId)
      if (idx === -1) return prev
      next.splice(idx, 0, sourceId)
      return next
    })
  }

  const persist = () => {
    const id = dragId.current
    dragId.current = null
    setDraggingId(null)
    setOverId(null)
    if (id === null) return
    const current = orderRef.current
    if (current.join(',') !== serverKey) {
      startTransition(async () => {
        await reorderGoals(current)
        router.refresh()
      })
    }
  }

  const dragPropsFor = (id: number): DragProps => ({
    dragging: draggingId === id,
    isOver: overId === id && draggingId !== id,
    onDragStart: (e) => {
      dragId.current = id
      setDraggingId(id)
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragEnter: (e) => {
      e.preventDefault()
      if (dragId.current !== null) {
        setOverId(id)
        moveBefore(dragId.current, id)
      }
    },
    onDragOver: (e) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDragEnd: persist,
    onDrop: (e) => {
      e.preventDefault()
      persist()
    },
  })

  return { items, dragPropsFor }
}

export function GoalsManager({
  goals,
  asOfYm,
  suggestNetZero,
}: {
  goals: GoalView[]
  asOfYm: string
  suggestNetZero: boolean
}) {
  const active = goals.filter((g) => !g.archived)
  const archived = goals.filter((g) => g.archived)
  const savings = active.filter((g) => g.kind === 'savings')
  const totalSaved = savings.reduce((s, g) => s + g.value, 0)
  const [showArchived, setShowArchived] = useState(false)
  const orderedActive = useReorder(active)

  return (
    <div className="flex flex-col gap-5">
      {/* Motivational hero */}
      <div className="card animate-in bg-gradient-to-br from-[var(--surface)] to-[var(--surface-2)] p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Your Goals 🎯</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {savings.length
                ? `${formatCurrency(totalSaved)} saved toward ${savings.length} ${savings.length === 1 ? 'goal' : 'goals'}. Keep going!`
                : 'Set your first goal and watch it grow.'}
            </p>
          </div>
          <span className="hidden text-4xl sm:block">🚀</span>
        </div>
      </div>

      {suggestNetZero && <NetZeroCTA />}

      {active.length === 0 && !suggestNetZero ? (
        <Card title="No goals yet">
          <EmptyHint>Create a goal below — a kitchen reno, an emergency fund, anything worth saving for.</EmptyHint>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {orderedActive.items.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              asOfYm={asOfYm}
              drag={active.length > 1 ? orderedActive.dragPropsFor(g.id) : undefined}
            />
          ))}
        </div>
      )}

      <NewGoalForm />

      {archived.length > 0 && (
        <div>
          <button onClick={() => setShowArchived((v) => !v)} className={GHOST_BTN}>
            {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
          </button>
          {showArchived && (
            <div className="mt-3 grid grid-cols-1 gap-5 lg:grid-cols-2">
              {archived.map((g) => (
                <GoalCard key={g.id} goal={g} asOfYm={asOfYm} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type Panel = 'none' | 'add' | 'adjust' | 'balance' | 'edit'

function GoalCard({ goal, asOfYm, drag }: { goal: GoalView; asOfYm: string; drag?: DragProps }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [panel, setPanel] = useState<Panel>('none')

  const run = (fn: () => Promise<void>) =>
    startTransition(async () => {
      await fn()
      setPanel('none')
      router.refresh()
    })

  const isMortgage = goal.kind === 'mortgage'
  const isNetZero = goal.kind === 'netzero'

  const subtitle = isMortgage
    ? 'Balance remaining'
    : isNetZero
      ? 'Year-net recovery'
      : goal.targetAmount
        ? `Goal ${formatCurrency(goal.targetAmount)}`
        : 'No target'

  return (
    <section
      onDragEnter={drag?.onDragEnter}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      className={`card flex flex-col gap-3 p-4 sm:p-5 transition-opacity ${pending ? 'opacity-60' : ''} ${
        drag?.dragging ? 'opacity-40' : ''
      } ${drag?.isOver ? 'ring-2 ring-[var(--accent)]' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {drag && (
            <span
              draggable
              onDragStart={drag.onDragStart}
              onDragEnd={drag.onDragEnd}
              title="Drag to reorder"
              aria-label="Drag to reorder"
              className="-ml-1 cursor-grab select-none px-1 text-[var(--muted)] hover:text-[var(--foreground)] active:cursor-grabbing"
            >
              ⠿
            </span>
          )}
          <span className="grid h-9 w-9 place-items-center rounded-xl text-xl" style={{ background: `${goal.color}22` }}>
            {goal.emoji}
          </span>
          <div>
            <h3 className="font-semibold leading-tight">{goal.name}</h3>
            <p className="text-xs text-[var(--muted)]">{subtitle}</p>
          </div>
        </div>
        <button
          onClick={() => run(() => toggleNotify(goal.id, !goal.notify))}
          title={goal.notify ? 'Notifications on' : 'Notifications off'}
          className={`rounded-lg px-2 py-1 text-sm ${goal.notify ? 'text-[var(--accent)]' : 'text-[var(--muted)]'}`}
        >
          {goal.notify ? '🔔' : '🔕'}
        </button>
      </div>

      {isMortgage ? <MortgageBody goal={goal} /> : isNetZero ? <NetZeroBody goal={goal} /> : <SavingsBody goal={goal} />}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        {isMortgage ? (
          <button onClick={() => setPanel(panel === 'balance' ? 'none' : 'balance')} className={PRIMARY_BTN}>
            Update balance
          </button>
        ) : isNetZero ? (
          <span className="text-xs text-[var(--muted)]">Updates automatically from your income vs spend ✨</span>
        ) : (
          <>
            <button onClick={() => setPanel(panel === 'add' ? 'none' : 'add')} className={PRIMARY_BTN}>
              Add money
            </button>
            <button onClick={() => setPanel(panel === 'adjust' ? 'none' : 'adjust')} className={GHOST_BTN}>
              Adjust value
            </button>
          </>
        )}
        <button onClick={() => setPanel(panel === 'edit' ? 'none' : 'edit')} className={`${GHOST_BTN} ${isNetZero ? 'ml-auto' : ''}`}>
          Edit
        </button>
      </div>

      {/* Inline panels */}
      {panel === 'add' && (
        <AddMoneyPanel onSubmit={(amount, asExpense, note) => run(() => addContribution({ goalId: goal.id, amount, asExpense, note }))} />
      )}
      {panel === 'adjust' && (
        <AdjustPanel current={goal.value} onSubmit={(newValue, note) => run(() => adjustValue({ goalId: goal.id, newValue, note }))} />
      )}
      {panel === 'balance' && (
        <BalancePanel current={goal.value} onSubmit={(newBalance) => run(() => updateMortgageBalance({ goalId: goal.id, newBalance }))} />
      )}
      {panel === 'edit' && (
        <EditPanel
          goal={goal}
          onSave={(patch) => run(() => updateGoal(goal.id, patch))}
          onArchive={() => run(() => archiveGoal(goal.id, !goal.archived))}
          onDelete={isMortgage ? undefined : () => run(() => deleteGoal(goal.id))}
        />
      )}
    </section>
  )
}

function SavingsBody({ goal }: { goal: GoalView }) {
  const pct = goal.progressPct
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <span className="tabular-nums text-2xl font-bold">{formatCurrency(goal.value)}</span>
        {pct !== null && <Ring pct={pct} color={goal.color} />}
      </div>
      {goal.targetAmount && pct !== null && (
        <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: goal.color }} />
        </div>
      )}
      <p className="text-xs text-[var(--muted)]">{goal.milestone}</p>
      {goal.series.length > 1 && (
        <LineChart labels={downsample(goal.series).map((p) => p.ym)} series={[{ color: goal.color, values: downsample(goal.series).map((p) => p.value) }]} height={140} />
      )}
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--muted)]">
        <Stat label="Contributed">{formatCurrency(goal.contributed)}</Stat>
        {goal.targetAmount && <Stat label="To go">{formatCurrency(Math.max(0, goal.targetAmount - goal.value))}</Stat>}
        {goal.projectedCompletionYm && <Stat label="On pace for">{formatMonth(goal.projectedCompletionYm)}</Stat>}
      </dl>
      {goal.targetAmount !== null && goal.value < goal.targetAmount && !goal.projectedCompletionYm && (
        <p className="text-[11px] text-[var(--muted)]">
          📈 A finish-date estimate appears once you have a couple of months of contributions — it learns your pace.
        </p>
      )}
    </div>
  )
}

function MortgageBody({ goal }: { goal: GoalView }) {
  const m = goal.mortgage
  if (!m) {
    return <p className="text-sm text-[var(--muted)]">{goal.milestone}</p>
  }
  const balanceLine = downsample(m.series).map((p) => p.actual ?? p.projected)
  const paceLine = downsample(m.series).map((p) => p.pace)
  const labels = downsample(m.series).map((p) => p.ym)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <span className="tabular-nums text-2xl font-bold">{formatCurrency(goal.value)}</span>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            m.onTrack ? 'bg-[var(--positive)]/15 text-[var(--positive)]' : 'bg-[var(--negative)]/15 text-[var(--negative)]'
          }`}
        >
          {m.onTrack ? 'On track ✓' : 'Behind pace'}
        </span>
      </div>
      <p className="text-xs text-[var(--muted)]">{goal.milestone}</p>
      <LineChart
        labels={labels}
        series={[
          { color: goal.color, values: balanceLine, name: 'Balance' },
          { color: 'var(--muted)', values: paceLine, name: 'Pace to age 50' },
        ]}
        height={150}
        area={false}
      />
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--muted)]">
        <Stat label="Payoff by">{formatMonth(m.targetYm)}</Stat>
        {goal.annualRate !== null && <Stat label="Interest rate">{(goal.annualRate * 100).toFixed(2)}%</Stat>}
        <Stat label="Regular payment">{formatCurrency(m.regularPayment)}/mo</Stat>
        <Stat label="Extra needed">{formatCurrency(m.recommendedExtra)}/mo</Stat>
        <Stat label="You pay extra">{formatCurrency(m.extraPayment)}/mo</Stat>
        <Stat label="Projected payoff">{m.projectedPayoffYm ? formatMonth(m.projectedPayoffYm) : '—'}</Stat>
      </dl>
    </div>
  )
}

function NetZeroBody({ goal }: { goal: GoalView }) {
  const nz = goal.netZero!
  const met = nz.value >= -0.005
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <span className={`tabular-nums text-2xl font-bold ${met ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
          {met ? formatCurrency(0) : formatCurrency(nz.value)}
        </span>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            met ? 'bg-[var(--positive)]/15 text-[var(--positive)]' : 'bg-[var(--negative)]/15 text-[var(--negative)]'
          }`}
        >
          {met ? 'Net zero ✓' : 'In the red'}
        </span>
      </div>
      <p className="text-xs text-[var(--muted)]">{goal.milestone}</p>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--muted)]">
        <Stat label="This year net">{formatCurrency(nz.currentYearNet)}</Stat>
        {nz.priorCarryover < -0.005 && <Stat label="Carried over">{formatCurrency(nz.priorCarryover)}</Stat>}
        <Stat label="Tracking since">{`Jan ${nz.startYear}`}</Stat>
      </dl>
      <p className="text-[11px] text-[var(--muted)]">
        ⚙️ Auto-updated from income vs spend; carries forward each year.{' '}
        <a className="text-[var(--accent)]" href="/budget">
          Plan it in Budget →
        </a>
      </p>
    </div>
  )
}

function NetZeroCTA() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <section className="card animate-in border-l-4 border-l-[var(--warning)] p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold">⚖️ You&apos;re negative on the year</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Start a Net-Zero recovery goal to track clawing it back. It carries any year-end deficit into the next
            year and cheers you on the moment you hit zero.
          </p>
        </div>
        <button
          disabled={pending}
          onClick={() => startTransition(async () => { await createNetZeroGoal(); router.refresh() })}
          className={`${PRIMARY_BTN} shrink-0`}
        >
          Start recovery goal
        </button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Small UI bits
// ---------------------------------------------------------------------------

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] uppercase tracking-wide">{label}</dt>
      <dd className="tabular-nums font-medium text-[var(--foreground)]">{children}</dd>
    </div>
  )
}

function Ring({ pct, color }: { pct: number; color: string }) {
  const r = 18
  const c = 2 * Math.PI * r
  const offset = c * (1 - Math.min(100, pct) / 100)
  return (
    <svg width={48} height={48} viewBox="0 0 48 48" className="shrink-0">
      <circle cx={24} cy={24} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={5} />
      <circle
        cx={24}
        cy={24}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform="rotate(-90 24 24)"
      />
      <text x={24} y={28} textAnchor="middle" style={{ fontSize: 11 }} className="fill-[var(--foreground)] font-semibold">
        {Math.round(pct)}%
      </text>
    </svg>
  )
}

function AddMoneyPanel({ onSubmit }: { onSubmit: (amount: number, asExpense: boolean, note: string) => void }) {
  const [amount, setAmount] = useState('')
  const [asExpense, setAsExpense] = useState(false)
  const [note, setNote] = useState('')
  return (
    <Panel>
      <input type="number" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${INPUT_CLASS} w-28`} />
      <input type="text" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className={`${INPUT_CLASS} min-w-0 flex-1`} />
      <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
        <input type="checkbox" checked={asExpense} onChange={(e) => setAsExpense(e.target.checked)} />
        count as an expense
      </label>
      <button disabled={!Number(amount)} onClick={() => onSubmit(Number(amount), asExpense, note)} className={PRIMARY_BTN}>
        Add
      </button>
    </Panel>
  )
}

function AdjustPanel({ current, onSubmit }: { current: number; onSubmit: (newValue: number, note: string) => void }) {
  const [value, setValue] = useState(String(current))
  const [note, setNote] = useState('')
  return (
    <Panel>
      <span className="text-xs text-[var(--muted)]">New market value</span>
      <input type="number" value={value} onChange={(e) => setValue(e.target.value)} className={`${INPUT_CLASS} w-32`} />
      <input type="text" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className={`${INPUT_CLASS} min-w-0 flex-1`} />
      <button onClick={() => onSubmit(Number(value), note)} className={PRIMARY_BTN}>
        Save
      </button>
    </Panel>
  )
}

function BalancePanel({ current, onSubmit }: { current: number; onSubmit: (newBalance: number) => void }) {
  const [value, setValue] = useState(String(Math.round(current * 100) / 100))
  return (
    <Panel>
      <span className="text-xs text-[var(--muted)]">Balance from statement</span>
      <input type="number" value={value} onChange={(e) => setValue(e.target.value)} className={`${INPUT_CLASS} w-36`} />
      <button disabled={!Number(value) && Number(value) !== 0} onClick={() => onSubmit(Number(value))} className={PRIMARY_BTN}>
        Save
      </button>
    </Panel>
  )
}

function EditPanel({
  goal,
  onSave,
  onArchive,
  onDelete,
}: {
  goal: GoalView
  onSave: (patch: { name?: string; emoji?: string; color?: string; targetAmount?: number | null; targetDate?: string | null; annualRate?: number | null }) => void
  onArchive: () => void
  onDelete?: () => void
}) {
  const [name, setName] = useState(goal.name)
  const [emoji, setEmoji] = useState(goal.emoji)
  const [color, setColor] = useState(goal.color)
  const [target, setTarget] = useState(goal.targetAmount ? String(goal.targetAmount) : '')
  const [date, setDate] = useState(goal.targetDate ?? '')
  const [rate, setRate] = useState(goal.annualRate !== null ? (goal.annualRate * 100).toFixed(2) : '')
  const isMortgage = goal.kind === 'mortgage'
  const isSavings = goal.kind === 'savings'
  return (
    <Panel column>
      <div className="flex flex-wrap items-center gap-2">
        <input value={emoji} onChange={(e) => setEmoji(e.target.value)} className={`${INPUT_CLASS} w-14 text-center`} />
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${INPUT_CLASS} min-w-0 flex-1`} />
      </div>
      {isMortgage ? (
        <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
          Current interest rate
          <span className="flex items-center gap-1">
            <input
              type="number"
              step="0.01"
              min={0}
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              className={`${INPUT_CLASS} w-24 text-right`}
            />
            %
          </span>
        </label>
      ) : isSavings ? (
        <div className="flex flex-wrap items-center gap-2">
          <input type="number" placeholder="Target $" value={target} onChange={(e) => setTarget(e.target.value)} className={`${INPUT_CLASS} w-28`} />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${INPUT_CLASS}`} />
          <div className="flex gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`h-6 w-6 rounded-full ${color === c ? 'ring-2 ring-offset-1 ring-[var(--accent)]' : ''}`}
                style={{ background: c }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() =>
            onSave({
              name,
              emoji,
              color,
              targetAmount: isSavings ? (target ? Number(target) : null) : undefined,
              targetDate: isSavings ? (date || null) : undefined,
              annualRate: isMortgage ? (rate ? Number(rate) / 100 : null) : undefined,
            })
          }
          className={PRIMARY_BTN}
        >
          Save
        </button>
        <button onClick={onArchive} className={GHOST_BTN}>
          {goal.archived ? 'Unarchive' : 'Archive'}
        </button>
        {onDelete && (
          <button onClick={onDelete} className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--negative)]">
            Delete
          </button>
        )}
      </div>
    </Panel>
  )
}

function NewGoalForm() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🎯')
  const [color, setColor] = useState(COLORS[0])
  const [target, setTarget] = useState('')
  const [date, setDate] = useState('')

  const submit = () =>
    startTransition(async () => {
      await createGoal({ name, emoji, color, targetAmount: target ? Number(target) : null, targetDate: date || null })
      setName('')
      setTarget('')
      setDate('')
      setOpen(false)
      router.refresh()
    })

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={`${PRIMARY_BTN} self-start`}>
        + New goal
      </button>
    )
  }
  return (
    <Card title="New goal">
      <div className={`flex flex-col gap-3 ${pending ? 'opacity-60' : ''}`}>
        <div className="flex flex-wrap items-center gap-2">
          <input value={emoji} onChange={(e) => setEmoji(e.target.value)} className={`${INPUT_CLASS} w-14 text-center`} aria-label="Emoji" />
          <input placeholder="What are you saving for?" value={name} onChange={(e) => setName(e.target.value)} className={`${INPUT_CLASS} min-w-0 flex-1`} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="number" placeholder="Target $ (optional)" value={target} onChange={(e) => setTarget(e.target.value)} className={`${INPUT_CLASS} w-40`} />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT_CLASS} aria-label="Target date" />
          <div className="flex gap-1">
            {COLORS.map((c) => (
              <button key={c} onClick={() => setColor(c)} className={`h-6 w-6 rounded-full ${color === c ? 'ring-2 ring-offset-1 ring-[var(--accent)]' : ''}`} style={{ background: c }} aria-label={`Color ${c}`} />
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button disabled={!name.trim()} onClick={submit} className={PRIMARY_BTN}>
            Create goal
          </button>
          <button onClick={() => setOpen(false)} className={GHOST_BTN}>
            Cancel
          </button>
        </div>
      </div>
    </Card>
  )
}

function Panel({ children, column = false }: { children: ReactNode; column?: boolean }) {
  return (
    <div className={`flex ${column ? 'flex-col' : 'flex-wrap items-center'} gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3`}>
      {children}
    </div>
  )
}

/** Cap a series to ~16 evenly-spaced points so chart x-labels never crowd. */
function downsample<T>(series: T[], max = 16): T[] {
  if (series.length <= max) return series
  const step = Math.ceil(series.length / max)
  const out = series.filter((_, i) => i % step === 0)
  if (out[out.length - 1] !== series[series.length - 1]) out.push(series[series.length - 1])
  return out
}
