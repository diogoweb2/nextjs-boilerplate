'use client'

import { useMemo, useState } from 'react'
import type { CashflowSankeyData, SankeyEndpoint } from '@/app/lib/cashflow-sankey'
import { CENTER_COLOR } from '@/app/lib/cashflow-sankey'
import { formatCurrency, formatCurrencyCompact, formatShortDate } from '@/app/lib/format'

/**
 * Two-stage cash-flow Sankey (Monarch-style): income sources → a central
 * "Income" node → spending categories (+ Saved). Pure SVG, responsive via
 * viewBox. Hovering a ribbon or node highlights that flow and dims the rest;
 * a floating tooltip carries the exact figure and % of income.
 */

const W = 960
const PAD_TOP = 28
const PAD_BOTTOM = 12
const LABEL_W = 210 // horizontal room for labels on each side
const BAR_W = 12
const GAP = 8 // vertical gap between nodes in a column
const PLOT_H = 340 // height budget for the tallest column's bars
const MIN_H = 3

type Placed = {
  node: SankeyEndpoint
  y: number
  h: number
  /** y and height of this flow's slice on the center bar. */
  cy: number
  ch: number
}

function ribbonPath(x0: number, y0: number, h0: number, x1: number, y1: number, h1: number) {
  const mx = (x0 + x1) / 2
  return [
    `M ${x0},${y0}`,
    `C ${mx},${y0} ${mx},${y1} ${x1},${y1}`,
    `L ${x1},${y1 + h1}`,
    `C ${mx},${y1 + h1} ${mx},${y0 + h0} ${x0},${y0 + h0}`,
    'Z',
  ].join(' ')
}

function place(nodes: SankeyEndpoint[], scale: number, top: number): Placed[] {
  let y = top
  let cy = top
  return nodes.map((node) => {
    const h = Math.max(MIN_H, node.value * scale)
    const ch = node.value * scale // true proportion on the center bar
    const placed = { node, y, h, cy, ch }
    y += h + GAP
    cy += ch
    return placed
  })
}

export function SankeyChart({ data }: { data: CashflowSankeyData }) {
  const [hover, setHover] = useState<string | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; node: SankeyEndpoint } | null>(null)
  const [detail, setDetail] = useState<SankeyEndpoint | null>(null)

  const { left, right, height, centerY, centerH, leftX, centerX, rightX } = useMemo(() => {
    const totalIn = data.incomes.reduce((a, n) => a + n.value, 0)
    const totalOut = data.spends.reduce((a, n) => a + n.value, 0)
    const maxTotal = Math.max(1, totalIn, totalOut)
    const scale = PLOT_H / maxTotal
    const colH = (ns: SankeyEndpoint[]) =>
      ns.reduce((a, n) => a + Math.max(MIN_H, n.value * scale), 0) + GAP * Math.max(0, ns.length - 1)

    // Center bar spans the true max total; columns center vertically against it.
    const centerH = maxTotal * scale
    const centerY = PAD_TOP
    const leftH = colH(data.incomes)
    const rightH = colH(data.spends)
    const height = PAD_TOP + Math.max(centerH, leftH, rightH) + PAD_BOTTOM

    const left = place(data.incomes, scale, PAD_TOP + Math.max(0, (centerH - leftH) / 2))
    const right = place(data.spends, scale, PAD_TOP + Math.max(0, (centerH - rightH) / 2))
    // Center-bar slices stack from the bar's top in column order.
    let acc = centerY
    for (const p of left) {
      p.cy = acc
      acc += p.ch
    }
    acc = centerY
    for (const p of right) {
      p.cy = acc
      acc += p.ch
    }

    return {
      left,
      right,
      height,
      centerY,
      centerH,
      leftX: LABEL_W,
      centerX: W / 2 - BAR_W / 2,
      rightX: W - LABEL_W - BAR_W,
    }
  }, [data])

  const dimmed = (key: string) => hover !== null && hover !== key
  const pctOfIncome = (v: number) =>
    data.totalIncome > 0 ? `${Math.round((v / data.totalIncome) * 100)}%` : null

  const onEnter = (node: SankeyEndpoint) => (e: React.MouseEvent) => {
    setHover(node.key)
    move(node)(e)
  }
  const move = (node: SankeyEndpoint) => (e: React.MouseEvent) => {
    const rect = (e.currentTarget as SVGElement).ownerSVGElement?.parentElement?.getBoundingClientRect()
    if (!rect) return
    setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, node })
  }
  const onLeave = () => {
    setHover(null)
    setTip(null)
  }

  const renderFlow = (p: Placed, side: 'in' | 'out') => {
    const gid = `sk-${side}-${p.node.key.replace(/[^a-zA-Z0-9-]/g, '_')}`
    const path =
      side === 'in'
        ? ribbonPath(leftX + BAR_W, p.y, p.h, centerX, p.cy, p.ch)
        : ribbonPath(centerX + BAR_W, p.cy, p.ch, rightX, p.y, p.h)
    const from = side === 'in' ? p.node.color : CENTER_COLOR
    const to = side === 'in' ? CENTER_COLOR : p.node.color
    return (
      <g key={p.node.key}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        <path
          d={path}
          fill={`url(#${gid})`}
          fillOpacity={hover === p.node.key ? 0.65 : dimmed(p.node.key) ? 0.12 : 0.32}
          style={{ transition: 'fill-opacity 150ms', cursor: 'pointer' }}
          onMouseEnter={onEnter(p.node)}
          onMouseMove={move(p.node)}
          onMouseLeave={onLeave}
          onClick={() => setDetail(p.node)}
        />
      </g>
    )
  }

  const renderNode = (p: Placed, side: 'in' | 'out') => {
    const x = side === 'in' ? leftX : rightX
    const labelX = side === 'in' ? x - 10 : x + BAR_W + 10
    const anchor = side === 'in' ? 'end' : 'start'
    const pct = side === 'out' ? pctOfIncome(p.node.value) : null
    const midY = p.y + p.h / 2
    const label = (
      <text
        x={labelX}
        y={midY}
        textAnchor={anchor}
        dominantBaseline="middle"
        style={{ fontSize: 12 }}
        opacity={dimmed(p.node.key) ? 0.35 : 1}
        pointerEvents="none"
      >
        <tspan className="fill-[var(--muted)]">{p.node.name} </tspan>
        <tspan className="fill-[var(--foreground)] font-semibold" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatCurrencyCompact(p.node.value)}
        </tspan>
        {pct && <tspan className="fill-[var(--muted)]"> · {pct}</tspan>}
      </text>
    )
    return (
      <g key={p.node.key}>
        <rect
          x={x}
          y={p.y}
          width={BAR_W}
          height={p.h}
          rx={3}
          fill={p.node.color}
          opacity={dimmed(p.node.key) ? 0.3 : 1}
          style={{ transition: 'opacity 150ms', cursor: 'pointer' }}
          onMouseEnter={onEnter(p.node)}
          onMouseMove={move(p.node)}
          onMouseLeave={onLeave}
          onClick={() => setDetail(p.node)}
        />
        {label}
      </g>
    )
  }

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" style={{ minHeight: 260 }} role="img" aria-label="Cash flow from income sources to spending categories">
        {/* Ribbons first (under the bars). */}
        {left.map((p) => renderFlow(p, 'in'))}
        {right.map((p) => renderFlow(p, 'out'))}

        {/* Center node. */}
        <rect x={centerX} y={centerY} width={BAR_W} height={Math.max(MIN_H, centerH)} rx={3} fill={CENTER_COLOR} />
        <text
          x={centerX + BAR_W / 2}
          y={centerY - 10}
          textAnchor="middle"
          style={{ fontSize: 12 }}
          pointerEvents="none"
        >
          <tspan className="fill-[var(--muted)]">Income </tspan>
          <tspan className="fill-[var(--foreground)] font-semibold" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatCurrencyCompact(Math.max(data.totalIncome, data.totalSpend))}
          </tspan>
        </text>

        {left.map((p) => renderNode(p, 'in'))}
        {right.map((p) => renderNode(p, 'out'))}
      </svg>

      {tip && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(tip.x + 12, 760), top: tip.y + 12 }}
        >
          <div className="mb-0.5 flex items-center gap-1.5 font-medium">
            <span className="h-2 w-2 rounded-full" style={{ background: tip.node.color }} />
            {tip.node.name}
          </div>
          <div className="tabular-nums font-semibold">{formatCurrency(tip.node.value)}</div>
          {pctOfIncome(tip.node.value) && (
            <div className="text-[var(--muted)]">{pctOfIncome(tip.node.value)} of income</div>
          )}
        </div>
      )}

      {detail && <NodeDetailModal node={detail} data={data} onClose={() => setDetail(null)} />}
    </div>
  )
}

/**
 * Click-through detail for a node: the transactions that make up the flow
 * (biggest first; negative rows are refunds/reimbursements netting against it).
 * The synthetic Saved / From-savings nodes have no transactions — they are the
 * income−spend gap — so they get a plain-language explanation instead.
 */
function NodeDetailModal({
  node,
  data,
  onClose,
}: {
  node: SankeyEndpoint
  data: CashflowSankeyData
  onClose: () => void
}) {
  const synthetic = node.key === 'saved' || node.key === 'shortfall'
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: node.color }} />
              {node.name}
            </div>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              <span className="tabular-nums font-medium text-[var(--foreground)]">
                {formatCurrency(node.value)}
              </span>
              {!synthetic && <> · {node.txns.length} transaction{node.txns.length === 1 ? '' : 's'}</>}
              {data.totalIncome > 0 && (
                <> · {Math.round((node.value / data.totalIncome) * 100)}% of income</>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-sm text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]"
          >
            ✕
          </button>
        </div>

        {synthetic ? (
          <div className="px-4 py-4 text-sm text-[var(--muted)]">
            {node.key === 'shortfall' ? (
              <>
                <p>
                  This isn&apos;t a transaction — it&apos;s the gap between what came in and what went
                  out. Spending in this period was{' '}
                  <span className="font-medium text-[var(--foreground)] tabular-nums">
                    {formatCurrency(data.totalSpend)}
                  </span>{' '}
                  against{' '}
                  <span className="font-medium text-[var(--foreground)] tabular-nums">
                    {formatCurrency(data.totalIncome)}
                  </span>{' '}
                  of income, so{' '}
                  <span className="font-medium text-[var(--foreground)] tabular-nums">
                    {formatCurrency(node.value)}
                  </span>{' '}
                  was covered by existing money (chequing balance / savings).
                </p>
                <p className="mt-2">
                  To see what drove it, click the spending categories on the right — or check the
                  Income report for the same period.
                </p>
              </>
            ) : (
              <p>
                Income exceeded spending by{' '}
                <span className="font-medium text-[var(--foreground)] tabular-nums">
                  {formatCurrency(node.value)}
                </span>{' '}
                in this period — money that stayed in your accounts rather than flowing to any
                category.
              </p>
            )}
          </div>
        ) : (
          <ul className="flex-1 divide-y divide-[var(--border)] overflow-y-auto px-4">
            {node.txns.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{t.merchant}</p>
                  <p className="text-xs text-[var(--muted)]">
                    {formatShortDate(t.date)}
                    {t.category !== node.name && <> · {t.category}</>}
                  </p>
                </div>
                <span
                  className={`shrink-0 tabular-nums ${
                    t.amount < 0 ? 'font-medium text-[var(--positive)]' : ''
                  }`}
                >
                  {t.amount < 0 ? `−${formatCurrency(Math.abs(t.amount))}` : formatCurrency(t.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {node.categoryParam && (
          <div className="border-t border-[var(--border)] px-4 py-2.5 text-right">
            <a
              href={`/transactions?category=${node.categoryParam}`}
              className="text-sm font-medium text-[var(--accent)] hover:underline"
            >
              View in Activity →
            </a>
          </div>
        )}
      </div>
    </div>
  )
}
