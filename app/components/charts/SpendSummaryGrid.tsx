'use client'

import { useState } from 'react'
import { StatCard } from '@/app/components/charts/StatCard'
import { formatCurrency } from '@/app/lib/format'

export type CategoryCardData = {
  name: string
  label: string
  amount: number
  prevAmount: number
  color: string
  budget: number
  href: string
  reportHref: string
}

/** Total-spend hero tile + per-category tiles, with a compact/expand toggle. */
export function SpendSummaryGrid({
  totalValue,
  totalCurrent,
  totalPrevious,
  totalHint,
  categoryCards,
}: {
  totalValue: string
  totalCurrent: number
  totalPrevious: number
  totalHint?: string
  categoryCards: CategoryCardData[]
}) {
  const [compact, setCompact] = useState(true)
  const toggle = () => setCompact((v) => !v)

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        hero
        compact={compact}
        onToggleCompact={toggle}
        label="Total spend"
        value={totalValue}
        current={totalCurrent}
        previous={totalPrevious}
        invertColors
        hint={totalHint}
      />
      {categoryCards.map((c) => (
        <StatCard
          key={c.name}
          compact={compact}
          onToggleCompact={toggle}
          label={c.label}
          value={formatCurrency(c.amount)}
          current={c.amount}
          previous={c.prevAmount}
          invertColors
          accent={c.color}
          budget={c.budget}
          href={c.href}
          reportHref={c.reportHref}
        />
      ))}
    </div>
  )
}
