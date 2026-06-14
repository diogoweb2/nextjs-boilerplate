import {
  type EnrichedTxn,
  anchorMonth,
  periodWindow,
  addMonths,
  monthKey,
} from '@/app/lib/analytics'
import { formatCurrency } from '@/app/lib/format'

export type InsightTone = 'good' | 'warn' | 'up' | 'down' | 'neutral'
export type InsightCard = { title: string; detail: string; tone: InsightTone }

export type Insights = {
  cards: InsightCard[]
  newMerchants: { name: string; amount: number }[]
  movers: { name: string; color: string; current: number; previous: number; delta: number }[]
  subscriptions: { name: string; amount: number; chargedThisPeriod: boolean }[]
  outliers: { merchant: string; amount: number; date: string; typical: number }[]
}

function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0)
}

export function buildInsights(
  all: EnrichedTxn[],
  months: number,
  excludeSpecial: boolean,
  exactMonth?: string | null
): Insights {
  const anchor = anchorMonth(all)
  if (!anchor) {
    return { cards: [], newMerchants: [], movers: [], subscriptions: [], outliers: [] }
  }
  const data = excludeSpecial ? all.filter((t) => !t.isSpecial) : all

  let start: string, end: string
  if (exactMonth) {
    start = exactMonth
    end = exactMonth
  } else {
    ;({ start, end } = periodWindow(anchor, months))
  }
  const inCur = (t: EnrichedTxn) => monthKey(t.txnDate) >= start && monthKey(t.txnDate) <= end

  const prevEnd = addMonths(start, -1)
  const prevStart = exactMonth ? prevEnd : addMonths(prevEnd, -(months - 1))
  const inPrev = (t: EnrichedTxn) =>
    monthKey(t.txnDate) >= prevStart && monthKey(t.txnDate) <= prevEnd

  const cur = data.filter((t) => inCur(t) && t.amount > 0)
  const prev = data.filter((t) => inPrev(t) && t.amount > 0)
  const beforeCur = data.filter((t) => monthKey(t.txnDate) < start)

  const curTotal = sum(cur.map((t) => t.amount))
  const prevTotal = sum(prev.map((t) => t.amount))

  const cards: InsightCard[] = []

  // 1. Overall direction vs previous period.
  if (prevTotal > 0) {
    const diff = curTotal - prevTotal
    const pct = Math.round((diff / prevTotal) * 100)
    if (Math.abs(pct) >= 3) {
      cards.push({
        title: diff > 0 ? `Spending up ${pct}%` : `Spending down ${Math.abs(pct)}%`,
        detail: (() => {
          const periodLabel = exactMonth ? 'month' : months === 1 ? 'month' : `${months} months`
          return diff > 0
            ? `You spent ${formatCurrency(Math.abs(diff))} more than the previous ${periodLabel}.`
            : `You spent ${formatCurrency(Math.abs(diff))} less than the previous ${periodLabel}. Nice work.`
        })(),
        tone: diff > 0 ? 'up' : 'good',
      })
    }
  }

  // 2. Top spending theme (category).
  const catTotals = new Map<string, { color: string; amount: number }>()
  for (const t of cur) {
    const e = catTotals.get(t.categoryName) ?? { color: t.categoryColor, amount: 0 }
    e.amount += t.amount
    catTotals.set(t.categoryName, e)
  }
  const topCat = [...catTotals.entries()].sort((a, b) => b[1].amount - a[1].amount)[0]
  if (topCat && curTotal > 0) {
    cards.push({
      title: `${topCat[0]} led your spending`,
      detail: `${formatCurrency(topCat[1].amount)} (${Math.round((topCat[1].amount / curTotal) * 100)}% of total) went to ${topCat[0]}.`,
      tone: 'neutral',
    })
  }

  // 3. Category movers (biggest change vs previous period).
  const prevCat = new Map<string, number>()
  for (const t of prev) prevCat.set(t.categoryName, (prevCat.get(t.categoryName) ?? 0) + t.amount)
  const moverNames = new Set([...catTotals.keys(), ...prevCat.keys()])
  const movers = [...moverNames]
    .map((name) => {
      const current = catTotals.get(name)?.amount ?? 0
      const previous = prevCat.get(name) ?? 0
      const color = catTotals.get(name)?.color ?? '#94a3b8'
      return { name, color, current, previous, delta: current - previous }
    })
    .filter((m) => Math.abs(m.delta) > 1)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 6)

  if (prevTotal > 0 && movers[0] && Math.abs(movers[0].delta) > 20) {
    const m = movers[0]
    cards.push({
      title: `Biggest change: ${m.name}`,
      detail:
        m.delta > 0
          ? `Up ${formatCurrency(m.delta)} vs the previous period.`
          : `Down ${formatCurrency(Math.abs(m.delta))} vs the previous period.`,
      tone: m.delta > 0 ? 'up' : 'good',
    })
  }

  // 4. New merchants (first ever seen in this period).
  const seenBefore = new Set(beforeCur.map((t) => t.merchantName))
  const newMerchMap = new Map<string, number>()
  for (const t of cur) {
    if (!seenBefore.has(t.merchantName)) {
      newMerchMap.set(t.merchantName, (newMerchMap.get(t.merchantName) ?? 0) + t.amount)
    }
  }
  const newMerchants = [...newMerchMap.entries()]
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount)
  if (newMerchants.length > 0) {
    cards.push({
      title: `${newMerchants.length} new merchant${newMerchants.length > 1 ? 's' : ''}`,
      detail: `First-time spending at ${newMerchants
        .slice(0, 3)
        .map((m) => m.name)
        .join(', ')}${newMerchants.length > 3 ? '…' : ''}.`,
      tone: 'neutral',
    })
  }

  // 5. Concentration.
  const merchTotals = new Map<string, number>()
  for (const t of cur) merchTotals.set(t.merchantName, (merchTotals.get(t.merchantName) ?? 0) + t.amount)
  const topMerch = [...merchTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  const topShare = curTotal > 0 ? sum(topMerch.map((m) => m[1])) / curTotal : 0
  if (topShare >= 0.4 && topMerch.length > 0) {
    cards.push({
      title: `Top 3 merchants = ${Math.round(topShare * 100)}% of spend`,
      detail: `${topMerch.map((m) => m[0]).join(', ')} dominate your spending this period.`,
      tone: 'warn',
    })
  }

  // 6. Outliers: a purchase much larger than that merchant's usual amount.
  const merchHistory = new Map<string, number[]>()
  for (const t of data.filter((t) => t.amount > 0)) {
    const arr = merchHistory.get(t.merchantName) ?? []
    arr.push(t.amount)
    merchHistory.set(t.merchantName, arr)
  }
  const outliers = cur
    .map((t) => {
      const hist = merchHistory.get(t.merchantName) ?? []
      const others = hist.length > 1 ? hist : []
      const typical = others.length ? sum(others) / others.length : 0
      return { merchant: t.merchantName, amount: t.amount, date: t.txnDate, typical }
    })
    .filter((o) => o.typical > 0 && o.amount >= o.typical * 2 && o.amount >= 80)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6)
  if (outliers[0]) {
    cards.push({
      title: 'Unusual purchase spotted',
      detail: `${formatCurrency(outliers[0].amount)} at ${outliers[0].merchant} is well above its usual ${formatCurrency(outliers[0].typical)}.`,
      tone: 'warn',
    })
  }

  // 7. Subscriptions: recurring merchants seen historically, charged or not this period.
  const recurringNames = new Set(data.filter((t) => t.isRecurring).map((t) => t.merchantName))
  const subscriptions = [...recurringNames]
    .map((name) => {
      const curForName = cur.filter((t) => t.merchantName === name)
      const amount = sum(curForName.map((t) => t.amount))
      return { name, amount, chargedThisPeriod: curForName.length > 0 }
    })
    .sort((a, b) => b.amount - a.amount)

  const notCharged = subscriptions.filter((s) => !s.chargedThisPeriod)
  if (notCharged.length > 0 && months <= 3) {
    cards.push({
      title: 'Subscription check',
      detail: `${notCharged
        .slice(0, 3)
        .map((s) => s.name)
        .join(', ')} didn't appear this period — confirm they're still active or were cancelled.`,
      tone: 'neutral',
    })
  }

  return {
    cards: cards.slice(0, 6),
    newMerchants: newMerchants.slice(0, 8),
    movers,
    subscriptions,
    outliers,
  }
}
