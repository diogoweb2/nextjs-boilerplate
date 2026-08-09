import { Card } from '@/app/components/AppShell'
import type { AparecidaData } from '@/app/actions/aparecida'
import {
  categoryColor,
  categoryTotals,
  formatBRL,
  formatBRLCompact,
  formatDatePt,
  formatMonthPt,
  monthTotals,
} from '@/app/lib/aparecida'

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

export function AparecidaManager({ data }: { data: AparecidaData }) {
  const { transactions, imports } = data
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

  if (transactions.length === 0) {
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
        </div>
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
                    <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
                      <span className="w-12 shrink-0 tabular-nums text-[var(--muted)]">{formatDatePt(t.txnDate)}</span>
                      <span className="flex-1 truncate">
                        {t.description}
                        {t.installment && (
                          <span className="ml-1.5 text-xs text-[var(--muted)]">({t.installment})</span>
                        )}
                      </span>
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
                        style={{
                          color: categoryColor(t.category),
                          background: `color-mix(in srgb, ${categoryColor(t.category)} 15%, transparent)`,
                        }}
                      >
                        {t.category}
                      </span>
                      <span className="w-20 shrink-0 text-right tabular-nums font-medium">
                        {formatBRL(Number(t.amount))}
                      </span>
                    </li>
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
              <span className="truncate">{imp.filename}</span>
              <span className="shrink-0 text-xs text-[var(--muted)]">{imp.transactionCount} lançamentos</span>
              <span className="w-24 shrink-0 text-right tabular-nums font-medium">
                {formatBRL(Number(imp.totalAmount))}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
