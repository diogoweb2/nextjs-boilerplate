import type { BudgetData } from '@/app/lib/budget'
import type { BurndownData } from '@/app/lib/projection'
import type { InsightCard } from '@/app/lib/insights'
import { formatCurrency } from '@/app/lib/format'

export function buildBudgetInsights(
  budget: BudgetData,
  burndown: BurndownData | null,
): InsightCard[] {
  if (!budget.hasData) return []
  const cards: InsightCard[] = []

  // 1. Daily allowance — remaining discretionary ÷ days left
  if (burndown && burndown.granularity === 'day') {
    const remaining = burndown.remaining[burndown.asOfIndex] ?? burndown.budget
    const daysLeft = burndown.labels.length - burndown.asOfIndex - 1
    if (daysLeft > 0) {
      const daily = remaining / daysLeft
      cards.push({
        title: `≈ ${formatCurrency(Math.round(daily))}/day left`,
        detail: `${formatCurrency(Math.round(remaining))} discretionary over ${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining.`,
        tone: burndown.onPace ? 'good' : 'warn',
        href: '/budget',
      })
    }
  }

  // 2. Projected month-end at current pace
  if (burndown && burndown.granularity === 'day' && burndown.asOfIndex > 0) {
    const daysElapsed = burndown.asOfIndex + 1
    const daysLeft = burndown.labels.length - daysElapsed
    if (daysLeft > 0 && burndown.spentToDate > 0) {
      const dailyRate = burndown.spentToDate / daysElapsed
      const projectedTotal = burndown.spentToDate + dailyRate * daysLeft
      const projectedRemaining = burndown.budget - projectedTotal
      const over = projectedRemaining < 0
      cards.push({
        title: over
          ? `Projected ${formatCurrency(Math.round(-projectedRemaining))} over`
          : `Projected ${formatCurrency(Math.round(projectedRemaining))} under`,
        detail: `At this pace you'll finish the month ${over ? 'over' : 'under'} your discretionary budget.`,
        tone: over ? 'warn' : 'good',
        href: '/budget',
      })
    }
  }

  // 3. Net this month so far (income − spend for the anchor month)
  const monthNet = budget.ytdNet - budget.completedBaseline
  if (Math.abs(monthNet) > 0.5) {
    cards.push({
      title: `Net ${formatCurrency(Math.abs(monthNet))} this month`,
      detail: monthNet >= 0
        ? 'Ahead — income exceeds spend so far.'
        : 'Behind — spend exceeds income so far.',
      tone: monthNet >= 0 ? 'good' : 'warn',
      href: '/budget',
    })
  }

  // 4. Year net-to-go
  if (budget.monthsRemaining > 0) {
    const needed = budget.targetNet - budget.ytdNet
    const perMonth = needed / budget.monthsRemaining
    cards.push({
      title: `Net ${formatCurrency(Math.abs(budget.ytdNet))} YTD`,
      detail: needed > 0
        ? `Need +${formatCurrency(Math.round(perMonth))}/mo to reach ${formatCurrency(budget.targetNet)} by Dec.`
        : `Already at target — ${formatCurrency(-needed)} to spare.`,
      tone: needed <= 0 ? 'good' : perMonth <= budget.income ? 'neutral' : 'warn',
      href: '/reports',
    })
  }

  // 5. Unavoidable bills not yet posted this month
  const unpaidLines = budget.unavoidable.lines.filter((l) => !l.actual)
  const unavoidableLeft = unpaidLines.reduce((s, l) => s + l.amount, 0)
  if (unavoidableLeft > 0.5) {
    const count = unpaidLines.length
    const names = unpaidLines
      .slice(0, 3)
      .map((l) => `${l.label} · ${formatCurrency(Math.round(l.amount))}`)
      .join(', ')
    const detail = count > 3
      ? `${names} + ${count - 3} more`
      : names
    cards.push({
      title: `${formatCurrency(Math.round(unavoidableLeft))} in bills due`,
      detail,
      tone: 'neutral',
      href: '/budget/bills',
    })
  }

  return cards
}
