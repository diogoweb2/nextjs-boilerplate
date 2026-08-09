'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/app/components/AppShell'
import { AparecidaTransactionModal } from '@/app/components/AparecidaTransactionModal'
import type { AparecidaData } from '@/app/actions/aparecida'
import { setAparecidaNotSuspicious } from '@/app/actions/aparecida'
import {
  APARECIDA_CATEGORIES,
  MIN_FLAG_AMOUNT,
  categoryColor,
  categoryTotals,
  detectAnomalies,
  formatBRL,
  formatBRLCompact,
  formatDatePt,
  formatMonthPt,
  monthTotals,
  type FlaggedAparecidaTransaction,
} from '@/app/lib/aparecida'
import type { AparecidaTransaction } from '@/db/schema'

const FLAG_COLORS: Record<string, string> = {
  high_category_amount: '#ef4444',
  high_overall_amount: '#ef4444',
  new_merchant_high_value: '#f59e0b',
  unusual_city: '#3b82f6',
  possible_duplicate: '#8b5cf6',
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-[var(--surface-2)] p-3">
      <span className="text-xs font-medium uppercase tracking-widest text-[var(--muted)]">
        {label}
      </span>
      <span className="font-display text-2xl font-bold tabular-nums tracking-tight">{value}</span>
      {hint && <span className="text-xs text-[var(--muted)]">{hint}</span>}
    </div>
  )
}

function MonthlyBars({ months }: { months: { month: string; total: number }[] }) {
  const max = Math.max(1, ...months.map((m) => m.total))
  return (
    <ul className="flex flex-col gap-2.5">
      {months.map((m) => (
        <li key={m.month} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium text-[var(--foreground)]">{formatMonthPt(m.month)}</span>
            <span className="shrink-0 tabular-nums font-semibold">{formatBRL(m.total)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
            <div
              className="h-full rounded-full bg-[var(--accent)]"
              style={{ width: `${(m.total / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

function CategoryDonut({ segments, total }: { segments: { category: string; amount: number; pct: number }[]; total: number }) {
  const size = 180
  const stroke = 22
  const radius = (size - stroke) / 2
  const circ = 2 * Math.PI * radius
  const visible = segments.filter((s) => s.amount > 0)
  const lens = visible.map((s) => s.pct * circ)
  const arcs = visible.map((s, i) => ({
    seg: s,
    len: lens[i],
    offset: lens.slice(0, i).reduce((a, b) => a + b, 0),
  }))

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-7">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
          {arcs.map(({ seg: s, len, offset }) => (
            <circle
              key={s.category}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={categoryColor(s.category)}
              strokeWidth={stroke}
              strokeDasharray={`${len} ${circ - len}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
            >
              <title>{`${s.category}: ${formatBRLCompact(s.amount)} (${Math.round(s.pct * 100)}%)`}</title>
            </circle>
          ))}
        </g>
        <text x="50%" y="46%" textAnchor="middle" className="fill-[var(--muted)]" style={{ fontSize: 11 }}>
          Total
        </text>
        <text x="50%" y="60%" textAnchor="middle" className="fill-[var(--foreground)]" style={{ fontSize: 19, fontWeight: 700 }}>
          {formatBRLCompact(total)}
        </text>
      </svg>

      <ul className="grid w-full grid-cols-1 gap-1.5 sm:max-w-[260px]">
        {visible.map((s) => (
          <li key={s.category} className="flex items-center gap-2 text-sm">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: categoryColor(s.category) }} />
            <span className="flex-1 truncate text-[var(--foreground)]">{s.category}</span>
            <span className="tabular-nums text-[var(--muted)]">{Math.round(s.pct * 100)}%</span>
            <span className="w-24 text-right tabular-nums font-medium">{formatBRL(s.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Category badge — shared by every row rendering below. */
function CategoryBadge({ category }: { category: string }) {
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        color: categoryColor(category),
        background: `color-mix(in srgb, ${categoryColor(category)} 15%, transparent)`,
      }}
    >
      {category}
    </span>
  )
}

export function AparecidaManager({ data }: { data: AparecidaData }) {
  const router = useRouter()
  const { transactions: allTransactions, imports } = data
  const [monthFilter, setMonthFilter] = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [searchFilter, setSearchFilter] = useState<string>('')
  const [openTxn, setOpenTxn] = useState<AparecidaTransaction | null>(null)
  const [, startTransition] = useTransition()

  const allMonths = monthTotals(allTransactions)
  const hasActiveFilters = monthFilter !== 'all' || categoryFilter !== 'all' || searchFilter.trim() !== ''

  const transactions = useMemo(() => {
    const search = searchFilter.trim().toLowerCase()
    return allTransactions.filter((t) => {
      if (monthFilter !== 'all' && t.txnDate.slice(0, 7) !== monthFilter) return false
      if (categoryFilter !== 'all' && t.category !== categoryFilter) return false
      if (search && !t.description.toLowerCase().includes(search)) return false
      return true
    })
  }, [allTransactions, monthFilter, categoryFilter, searchFilter])

  const months = monthTotals(transactions)
  const categories = categoryTotals(transactions)
  const total = transactions.reduce((sum, t) => sum + Number(t.amount), 0)
  const lastMonth = months[months.length - 1]

  const byMonth = new Map<string, typeof transactions>()
  for (const t of transactions) {
    const key = t.txnDate.slice(0, 7)
    if (!byMonth.has(key)) byMonth.set(key, [])
    byMonth.get(key)!.push(t)
  }
  const monthGroups = [...byMonth.entries()].sort(([a], [b]) => b.localeCompare(a))

  const flaggedAll = detectAnomalies(transactions)
  const flagsById = new Map(flaggedAll.map((t) => [t.id, t.flags]))
  const flagged = flaggedAll
    .filter((t) => t.flags.length > 0)
    .sort((a, b) => b.flags.length - a.flags.length || b.txnDate.localeCompare(a.txnDate))

  function refresh() {
    startTransition(() => router.refresh())
  }

  function toggleNotSuspicious(id: number, next: boolean) {
    startTransition(async () => {
      await setAparecidaNotSuspicious(id, next)
      refresh()
    })
  }

  function filterByEstablishment(description: string) {
    setSearchFilter(description)
    setMonthFilter('all')
    setCategoryFilter('all')
    setOpenTxn(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function clearFilters() {
    setMonthFilter('all')
    setCategoryFilter('all')
    setSearchFilter('')
  }

  function TxnRow({ t, flags }: { t: AparecidaTransaction; flags?: FlaggedAparecidaTransaction['flags'] }) {
    return (
      <li className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg text-sm"
          onClick={() => setOpenTxn(t)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setOpenTxn(t)}
        >
          <span className="w-12 shrink-0 tabular-nums text-[var(--muted)]">{formatDatePt(t.txnDate)}</span>
          <span className="min-w-[140px] flex-1 cursor-pointer break-words font-medium hover:underline">
            {t.description}
            {t.installment && <span className="ml-1.5 text-xs text-[var(--muted)]">({t.installment})</span>}
          </span>
          <CategoryBadge category={t.category} />
          <span className="shrink-0 text-right tabular-nums font-semibold">{formatBRL(Number(t.amount))}</span>
        </div>
        {flags && flags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pl-[3.75rem]">
            {flags.map((f) => (
              <span
                key={f.code}
                className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{
                  color: FLAG_COLORS[f.code],
                  background: `color-mix(in srgb, ${FLAG_COLORS[f.code]} 12%, transparent)`,
                }}
              >
                {f.label}
              </span>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-3 pl-[3.75rem] text-xs">
          <button
            type="button"
            className="font-medium text-[var(--accent)] hover:underline"
            onClick={() => setOpenTxn(t)}
          >
            Mais detalhes
          </button>
          {flags && flags.length > 0 && (
            <button
              type="button"
              className="font-medium text-[var(--muted)] hover:underline"
              onClick={() => toggleNotSuspicious(t.id, true)}
              title="Some da lista para todos os lançamentos deste estabelecimento"
            >
              Não é suspeito (esse estabelecimento)
            </button>
          )}
          {t.notSuspicious && (
            <button
              type="button"
              className="font-medium text-[var(--muted)] hover:underline"
              onClick={() => toggleNotSuspicious(t.id, false)}
            >
              Marcar como suspeito novamente
            </button>
          )}
        </div>
      </li>
    )
  }

  if (allTransactions.length === 0) {
    return (
      <Card title="Aparecida">
        <p className="text-sm text-[var(--muted)]">
          Nenhum lançamento importado ainda. Coloque as faturas PDF em{' '}
          <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 text-xs">Brasil/aparecida/</code> e rode{' '}
          <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 text-xs">npm run aparecida:import</code>.
        </p>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {openTxn && (
        <AparecidaTransactionModal
          txn={openTxn}
          flags={flagsById.get(openTxn.id) ?? []}
          onClose={() => setOpenTxn(null)}
          onChanged={refresh}
          onFilterEstablishment={filterByEstablishment}
        />
      )}

      <Card
        title="Filtros"
        action={
          hasActiveFilters ? (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium hover:bg-[var(--surface-2)]"
            >
              Limpar filtros
            </button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="text"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder="Buscar por estabelecimento…"
            className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
            aria-label="Buscar por estabelecimento"
          />
          <select
            value={monthFilter}
            onChange={(e) => setMonthFilter(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm font-medium"
            aria-label="Filtrar por mês"
          >
            <option value="all">Todos os meses</option>
            {[...allMonths].reverse().map((m) => (
              <option key={m.month} value={m.month}>
                {formatMonthPt(m.month)}
              </option>
            ))}
          </select>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm font-medium"
            aria-label="Filtrar por categoria"
          >
            <option value="all">Todas as categorias</option>
            {APARECIDA_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <Card title="Resumo">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="Total no período" value={formatBRL(total)} hint={`${transactions.length} lançamentos`} />
          <StatTile
            label="Média mensal"
            value={formatBRL(months.length ? total / months.length : 0)}
            hint={`${months.length} faturas`}
          />
          {lastMonth && (
            <StatTile label={`Última fatura (${formatMonthPt(lastMonth.month)})`} value={formatBRL(lastMonth.total)} />
          )}
          <StatTile
            label="Fora do padrão"
            value={String(flagged.length)}
            hint={flagged.length ? 'vale dar uma olhada' : 'nada chamando atenção'}
          />
        </div>
      </Card>

      <Card title={`Fora do padrão (acima de ${formatBRL(MIN_FLAG_AMOUNT)})`}>
        {flagged.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            Nada fora do padrão até agora — sem valores muito acima do normal, comerciantes novos
            de valor alto, cidade incomum ou possíveis cobranças duplicadas.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {flagged.map((t) => (
              <TxnRow key={t.id} t={t} flags={t.flags} />
            ))}
          </ul>
        )}
      </Card>

      <Card title="Gasto por mês">
        <MonthlyBars months={months} />
      </Card>

      <Card title="Gasto por categoria">
        <CategoryDonut segments={categories} total={total} />
      </Card>

      <Card title="Lançamentos">
        <div className="flex flex-col gap-3">
          {monthGroups.map(([month, txns]) => {
            const monthTotal = txns.reduce((sum, t) => sum + Number(t.amount), 0)
            return (
              <details key={month} className="group rounded-xl border border-[var(--border)]" open={month === monthGroups[0][0]}>
                <summary className="flex cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold marker:content-none">
                  <span>{formatMonthPt(month)}</span>
                  <span className="tabular-nums text-[var(--muted)]">{formatBRL(monthTotal)}</span>
                </summary>
                <ul className="flex flex-col divide-y divide-[var(--border)] border-t border-[var(--border)] px-3">
                  {txns.map((t) => (
                    <TxnRow key={t.id} t={t} flags={flagsById.get(t.id)} />
                  ))}
                </ul>
              </details>
            )
          })}
        </div>
      </Card>

      <Card title="Faturas importadas">
        <ul className="flex flex-col divide-y divide-[var(--border)]">
          {imports.map((imp) => (
            <li key={imp.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 break-words">{imp.filename}</span>
              <span className="shrink-0 text-xs text-[var(--muted)]">{imp.transactionCount} lançamentos</span>
              <span className="w-24 shrink-0 text-right tabular-nums font-medium">
                {formatBRL(Number(imp.totalAmount))}
              </span>
              {imp.pdfBase64 && (
                <a
                  href={`/api/aparecida/statement/${encodeURIComponent(imp.filename)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs font-medium text-[var(--accent)] hover:underline"
                >
                  PDF
                </a>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
