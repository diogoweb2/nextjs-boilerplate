'use client'

import { useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatCurrency, formatCurrencyCompact, formatLongDate } from '@/app/lib/format'
import {
  createRegisteredAccount,
  updateRegisteredAccount,
  deleteRegisteredAccount,
  importHoldings,
  addManualContribution,
  deleteContribution,
  type InvestmentsData,
  type AccountView,
} from '@/app/actions/investments'

const INPUT =
  'rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]'
const BTN =
  'rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-fg)] disabled:opacity-40'
const BTN_GHOST =
  'rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--muted)] hover:text-[var(--foreground)]'

const KIND_LABEL: Record<string, string> = {
  tfsa: 'TFSA', resp: 'RESP', rrsp: 'RRSP', fhsa: 'FHSA', nonreg: 'Non-registered',
}

export function InvestmentsManager({ data }: { data: InvestmentsData }) {
  const [adding, setAdding] = useState(false)
  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Investments</h1>
          <p className="text-xs text-[var(--muted)]">
            Registered accounts at iTrade — value, contribution room & government grants.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="text-2xl font-bold tabular-nums">{formatCurrencyCompact(data.totalValueCad)}</div>
          <div className="text-[11px] text-[var(--muted)]">total market value (CAD)</div>
          {data.accounts.some((a) => a.latest) && (
            <Link href="/accounts/investments/report" className="text-xs font-medium text-[var(--accent)]">
              📈 Monthly report ▶
            </Link>
          )}
        </div>
      </header>

      {data.accounts.length === 0 && !adding && (
        <div className="card p-6 text-center text-sm text-[var(--muted)]">
          No registered accounts yet.{' '}
          <button className="font-medium text-[var(--accent)]" onClick={() => setAdding(true)}>
            Add your TFSA or RESP
          </button>{' '}
          to track room, grants and holdings.
        </div>
      )}

      {data.accounts.map((a) => (
        <AccountCard key={a.id} account={a} />
      ))}

      {adding ? (
        <AddAccountForm onDone={() => setAdding(false)} />
      ) : (
        data.accounts.length > 0 && (
          <button className={`${BTN_GHOST} self-start`} onClick={() => setAdding(true)}>
            + Add account
          </button>
        )
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function AccountCard({ account: a }: { account: AccountView }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [tab, setTab] = useState<'holdings' | 'contributions' | 'settings'>('holdings')

  const gain = a.latest ? a.latest.totalValueCad - a.latest.bookValueCad : 0
  const gainPct = a.latest && a.latest.bookValueCad ? (gain / a.latest.bookValueCad) * 100 : 0

  return (
    <section className="card animate-in p-4 sm:p-5">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{a.name}</span>
            <span className="rounded-md bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--muted)]">
              {KIND_LABEL[a.kind] ?? a.kind} · {a.ownerName}
            </span>
          </div>
          {a.latest && (
            <div className="mt-0.5 text-[11px] text-[var(--muted)]">
              as of {formatLongDate(a.latest.occurredAt)}
              {a.latest.fxUsdCad !== 1 && <> · USD→CAD {a.latest.fxUsdCad.toFixed(4)}</>}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-xl font-bold tabular-nums">
            {a.latest ? formatCurrency(a.latest.totalValueCad) : '—'}
          </div>
          {a.latest && (
            <div className={`text-[11px] tabular-nums ${gain >= 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
              {gain >= 0 ? '▲' : '▼'} {formatCurrency(Math.abs(gain))} ({gainPct >= 0 ? '+' : ''}{gainPct.toFixed(1)}%)
            </div>
          )}
        </div>
      </div>

      {/* Rule engine: TFSA room or RESP grant */}
      {a.tfsa && <TfsaPanel room={a.tfsa} />}
      {a.resp && <RespPanel grant={a.resp} />}

      {/* Tabs */}
      <div className="mb-3 mt-4 flex gap-1 border-b border-[var(--border)]">
        {(['holdings', 'contributions', 'settings'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs font-medium capitalize ${
              tab === t ? 'border-b-2 border-[var(--accent)] text-[var(--foreground)]' : 'text-[var(--muted)]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'holdings' && <HoldingsTab account={a} />}
      {tab === 'contributions' && <ContributionsTab account={a} />}
      {tab === 'settings' && (
        <SettingsTab
          account={a}
          onDelete={() =>
            startTransition(async () => {
              if (confirm(`Delete "${a.name}" and all its holdings/contributions?`)) {
                await deleteRegisteredAccount(a.id)
                router.refresh()
              }
            })
          }
          deleting={pending}
        />
      )}
    </section>
  )
}

// --- TFSA room meter -------------------------------------------------------

function TfsaPanel({ room }: { room: NonNullable<AccountView['tfsa']> }) {
  const used = Math.max(0, room.contributionsThisYear)
  const pct = room.annualLimit > 0 ? Math.min(100, (used / (used + Math.max(0, room.room))) * 100) : 0
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-[var(--muted)]">Contribution room left</span>
        <span className={`text-lg font-bold tabular-nums ${room.overContributed ? 'text-[var(--negative)]' : ''}`}>
          {formatCurrency(room.room)}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--surface)]">
        <div
          className={`h-full rounded-full ${room.overContributed ? 'bg-[var(--negative)]' : 'bg-[var(--accent)]'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-[var(--muted)]">
        <span>{formatCurrency(room.contributionsThisYear)} contributed this year</span>
        <span>baseline {formatCurrency(room.baselineAmount)} @ {room.baselineDate}</span>
      </div>
      {room.warnings.map((w, i) => (
        <p key={i} className="mt-2 rounded-lg bg-[var(--surface)] px-2.5 py-1.5 text-[11px] text-[var(--foreground)]">
          {room.overContributed ? '⚠️ ' : '💡 '}{w}
        </p>
      ))}
    </div>
  )
}

// --- RESP grant meter ------------------------------------------------------

function RespPanel({ grant }: { grant: NonNullable<AccountView['resp']> }) {
  const lifetimePct = Math.min(100, (grant.grantReceivedLifetime / 7200) * 100)
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-[var(--muted)]">Free grant available this year</span>
        <span className="text-lg font-bold tabular-nums text-[var(--positive)]">
          {formatCurrency(grant.freeGrantAvailableThisYear)}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--surface)]">
        <div className="h-full rounded-full bg-[var(--positive)]" style={{ width: `${lifetimePct}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-[var(--muted)]">
        <span>{formatCurrency(grant.grantReceivedLifetime)} of $7,200 lifetime grant</span>
        <span>{formatCurrency(grant.contributionsThisYear)} contributed this year</span>
      </div>
      {grant.warnings.map((w, i) => (
        <p key={i} className="mt-2 rounded-lg bg-[var(--surface)] px-2.5 py-1.5 text-[11px] text-[var(--foreground)]">
          {grant.expired ? '⚠️ ' : '🎁 '}{w}
        </p>
      ))}
    </div>
  )
}

// --- Holdings tab ----------------------------------------------------------

function HoldingsTab({ account: a }: { account: AccountView }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const fxRef = useRef<HTMLInputElement>(null)

  const upload = () => {
    const file = fileRef.current?.files?.[0]
    if (!file) { setMsg('Choose a CSV first.'); return }
    const fd = new FormData()
    fd.set('file', file)
    fd.set('accountId', String(a.id))
    if (fxRef.current?.value.trim()) fd.set('fxUsdCad', fxRef.current.value.trim())
    startTransition(async () => {
      const res = await importHoldings(fd)
      if (res.ok) {
        setMsg(
          `Imported ${res.positions} positions · ${formatCurrency(res.totalValueCad)}` +
            (res.fxUsdCad !== 1 ? ` · USD→CAD ${res.fxUsdCad.toFixed(4)}${res.fxLive ? ' (live)' : ''}` : ''),
        )
        if (fileRef.current) fileRef.current.value = ''
        router.refresh()
      } else {
        setMsg(res.error)
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {a.positions.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase text-[var(--muted)]">
                <th className="py-1 pr-2 font-medium">Symbol</th>
                <th className="py-1 pr-2 font-medium">Qty</th>
                <th className="py-1 pr-2 text-right font-medium">Value (CAD)</th>
                <th className="py-1 pl-2 text-right font-medium">All-time</th>
              </tr>
            </thead>
            <tbody>
              {a.positions.map((p) => (
                <tr key={p.symbol} className="border-t border-[var(--border)]">
                  <td className="py-1.5 pr-2">
                    <div className="font-medium">{p.symbol}</div>
                    <div className="text-[11px] text-[var(--muted)]">
                      {p.name}
                      {p.currency === 'USD' && (
                        <span className="ml-1 rounded bg-[var(--surface-2)] px-1 text-[9px]">USD</span>
                      )}
                    </div>
                  </td>
                  <td className="py-1.5 pr-2 tabular-nums text-[var(--muted)]">{p.quantity}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{formatCurrency(p.marketValueCad)}</td>
                  <td className={`py-1.5 pl-2 text-right tabular-nums ${p.changePct >= 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
                    {p.changePct >= 0 ? '+' : ''}{p.changePct.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="py-2 text-sm text-[var(--muted)]">No holdings yet — import an iTrade portfolio CSV below.</p>
      )}

      <div className="rounded-xl border border-dashed border-[var(--border)] p-3">
        <div className="mb-2 text-xs font-medium">Import holdings snapshot</div>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".csv" className="text-xs" />
          <input ref={fxRef} type="number" step="0.0001" placeholder="USD→CAD (auto)" className={`${INPUT} w-36`} />
          <button className={BTN} disabled={pending} onClick={upload}>
            {pending ? 'Importing…' : 'Import CSV'}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--muted)]">
          USD positions are converted to CAD with the live Bank of Canada rate (override above if you prefer).
        </p>
        {msg && <p className="mt-1.5 text-[11px] text-[var(--foreground)]">{msg}</p>}
      </div>
    </div>
  )
}

// --- Contributions tab -----------------------------------------------------

function ContributionsTab({ account: a }: { account: AccountView }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [kind, setKind] = useState<'contribution' | 'withdrawal'>('contribution')

  const add = () => {
    const amt = Number(amount)
    if (!amt) return
    startTransition(async () => {
      await addManualContribution({ accountId: a.id, amount: amt, kind, occurredAt: date })
      setAmount('')
      router.refresh()
    })
  }
  const remove = (id: number) =>
    startTransition(async () => {
      await deleteContribution(id)
      router.refresh()
    })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value as 'contribution' | 'withdrawal')} className={INPUT}>
          <option value="contribution">Contribution</option>
          <option value="withdrawal">Withdrawal</option>
        </select>
        <input type="number" step="0.01" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${INPUT} w-32`} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT} />
        <button className={BTN} disabled={pending} onClick={add}>Add</button>
      </div>
      <p className="text-[11px] text-[var(--muted)]">
        Most contributions are added automatically when you tag a Scotia→iTrade transfer on the dashboard. Add here only
        for deposits the bank import didn&apos;t catch.
      </p>
      {a.contributions.length > 0 ? (
        <ul className="flex flex-col divide-y divide-[var(--border)]">
          {a.contributions.map((c) => (
            <li key={c.id} className="flex items-center justify-between py-1.5 text-sm">
              <span className="text-[var(--muted)]">{formatLongDate(c.occurredAt)}</span>
              <span className="flex items-center gap-2">
                <span className={`tabular-nums ${c.kind === 'withdrawal' ? 'text-[var(--negative)]' : ''}`}>
                  {c.kind === 'withdrawal' ? '−' : '+'}{formatCurrency(c.amount)}
                </span>
                <span className="rounded bg-[var(--surface-2)] px-1 text-[9px] text-[var(--muted)]">
                  {c.fromTransfer ? 'transfer' : 'manual'}
                </span>
                <button onClick={() => remove(c.id)} className="text-[var(--muted)] hover:text-[var(--negative)]" aria-label="Delete">✕</button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-2 text-sm text-[var(--muted)]">No contributions tracked yet.</p>
      )}
    </div>
  )
}

// --- Settings tab ----------------------------------------------------------

function SettingsTab({ account: a, onDelete, deleting }: { account: AccountView; onDelete: () => void; deleting: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState(a.name)
  const [roomAmt, setRoomAmt] = useState(a.roomBaselineAmount?.toString() ?? '')
  const [roomDate, setRoomDate] = useState(a.roomBaselineDate ?? '')
  const [birthYear, setBirthYear] = useState(a.beneficiaryBirthYear?.toString() ?? '')
  const [grantRecv, setGrantRecv] = useState(a.grantBaselineReceived?.toString() ?? '')
  const [contribBase, setContribBase] = useState(a.contributionBaseline?.toString() ?? '')
  const [carry, setCarry] = useState(a.grantCarryForward?.toString() ?? '')

  const save = () =>
    startTransition(async () => {
      await updateRegisteredAccount(a.id, {
        name,
        roomBaselineAmount: roomAmt ? Number(roomAmt) : null,
        roomBaselineDate: roomDate || null,
        beneficiaryBirthYear: birthYear ? Number(birthYear) : null,
        grantBaselineReceived: grantRecv ? Number(grantRecv) : null,
        contributionBaseline: contribBase ? Number(contribBase) : null,
        grantCarryForward: carry ? Number(carry) : null,
      })
      router.refresh()
    })

  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[var(--muted)]">Account name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
      </label>

      {a.kind === 'tfsa' && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--muted)]">Room baseline (CRA)</span>
            <input type="number" step="0.01" value={roomAmt} onChange={(e) => setRoomAmt(e.target.value)} className={INPUT} placeholder="23756.00" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--muted)]">As of (a Jan 1)</span>
            <input type="date" value={roomDate} onChange={(e) => setRoomDate(e.target.value)} className={INPUT} />
          </label>
          <p className="col-span-2 text-[11px] text-[var(--muted)]">
            Read &quot;TFSA contribution room as of Jan 1&quot; from CRA My Account. Room then recalcs from your tagged transfers.
          </p>
        </div>
      )}

      {a.kind === 'resp' && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--muted)]">Beneficiary birth year</span>
            <input type="number" value={birthYear} onChange={(e) => setBirthYear(e.target.value)} className={INPUT} placeholder="2016" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--muted)]">Carry-forward grant ($)</span>
            <input type="number" step="0.01" value={carry} onChange={(e) => setCarry(e.target.value)} className={INPUT} placeholder="0" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--muted)]">CESG received to date</span>
            <input type="number" step="0.01" value={grantRecv} onChange={(e) => setGrantRecv(e.target.value)} className={INPUT} placeholder="3600" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--muted)]">Contributions to date</span>
            <input type="number" step="0.01" value={contribBase} onChange={(e) => setContribBase(e.target.value)} className={INPUT} placeholder="18000" />
          </label>
          <p className="col-span-2 text-[11px] text-[var(--muted)]">
            These &quot;to date&quot; figures are everything before tracking started (for the $7,200 grant & $50k contribution caps).
          </p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <button className={BTN} disabled={pending} onClick={save}>Save</button>
        <button className="text-xs font-medium text-[var(--negative)] disabled:opacity-40" disabled={deleting} onClick={onDelete}>
          Delete account
        </button>
      </div>
    </div>
  )
}

// --- Add account -----------------------------------------------------------

function AddAccountForm({ onDone }: { onDone: () => void }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [kind, setKind] = useState<'tfsa' | 'resp' | 'rrsp' | 'fhsa' | 'nonreg'>('tfsa')
  const [name, setName] = useState('')
  const [owner, setOwner] = useState<'self' | 'partner'>('self')
  const [roomAmt, setRoomAmt] = useState('')
  const [roomDate, setRoomDate] = useState('')

  const create = () => {
    if (!name.trim()) return
    startTransition(async () => {
      await createRegisteredAccount({
        kind,
        name,
        owner,
        roomBaselineAmount: kind === 'tfsa' && roomAmt ? Number(roomAmt) : null,
        roomBaselineDate: kind === 'tfsa' && roomDate ? roomDate : null,
      })
      router.refresh()
      onDone()
    })
  }

  return (
    <div className="card p-4">
      <div className="mb-3 text-sm font-semibold">New registered account</div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={INPUT}>
            <option value="tfsa">TFSA</option>
            <option value="resp">RESP</option>
            <option value="rrsp">RRSP</option>
            <option value="fhsa">FHSA</option>
            <option value="nonreg">Non-registered</option>
          </select>
          <select value={owner} onChange={(e) => setOwner(e.target.value as 'self' | 'partner')} className={INPUT}>
            <option value="self">Me</option>
            <option value="partner">Partner</option>
          </select>
          <input placeholder="Name (e.g. My TFSA)" value={name} onChange={(e) => setName(e.target.value)} className={`${INPUT} flex-1`} />
        </div>
        {kind === 'tfsa' && (
          <div className="flex flex-wrap gap-2">
            <input type="number" step="0.01" placeholder="CRA room baseline (e.g. 23756)" value={roomAmt} onChange={(e) => setRoomAmt(e.target.value)} className={`${INPUT} flex-1`} />
            <input type="date" value={roomDate} onChange={(e) => setRoomDate(e.target.value)} className={INPUT} title="As of (a Jan 1)" />
          </div>
        )}
        <div className="flex gap-2">
          <button className={BTN} disabled={pending} onClick={create}>Create</button>
          <button className={BTN_GHOST} onClick={onDone}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
