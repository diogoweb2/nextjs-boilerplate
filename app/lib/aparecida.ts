/**
 * "Aparecida" is a fully isolated view: someone else manages her money, this
 * page just lets the owner keep an eye on it. Fixed Portuguese category list
 * (no learning layer, no merchants) — shared between the importer prompt
 * (scripts/aparecida-import.ts) and the UI so colors/labels stay in sync.
 */

import type { AparecidaTransaction } from '@/db/schema'

export const APARECIDA_CATEGORIES = [
  'Mercado',
  'Farmácia',
  'Saúde',
  'Casa',
  'Vestuário',
  'Transporte',
  'Restaurante',
  'Lazer',
  'Serviços',
  'Presentes',
  'Outros',
] as const

export type AparecidaCategory = (typeof APARECIDA_CATEGORIES)[number]

const CATEGORY_COLORS: Record<string, string> = {
  Mercado: '#22c55e',
  Farmácia: '#ec4899',
  Saúde: '#ef4444',
  Casa: '#f59e0b',
  Vestuário: '#8b5cf6',
  Transporte: '#3b82f6',
  Restaurante: '#f97316',
  Lazer: '#06b6d4',
  Serviços: '#64748b',
  Presentes: '#d946ef',
  Outros: '#94a3b8',
}

export function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.Outros
}

const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const brlCompact = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
})

export function formatBRL(value: number): string {
  return brl.format(value)
}

export function formatBRLCompact(value: number): string {
  return brlCompact.format(value)
}

export type AparecidaMonthTotal = { month: string; total: number }
export type AparecidaCategoryTotal = { category: string; amount: number; pct: number }

export function monthTotals(txns: AparecidaTransaction[]): AparecidaMonthTotal[] {
  const byMonth = new Map<string, number>()
  for (const t of txns) {
    const month = t.txnDate.slice(0, 7)
    byMonth.set(month, (byMonth.get(month) ?? 0) + Number(t.amount))
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, total]) => ({ month, total }))
}

export function categoryTotals(txns: AparecidaTransaction[]): AparecidaCategoryTotal[] {
  const byCategory = new Map<string, number>()
  for (const t of txns) {
    byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + Number(t.amount))
  }
  const total = [...byCategory.values()].reduce((a, b) => a + b, 0) || 1
  return [...byCategory.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([category, amount]) => ({ category, amount, pct: amount / total }))
}

/** "2026-04" -> "Abr 2026". */
const PT_MONTHS = [
  'Jan',
  'Fev',
  'Mar',
  'Abr',
  'Mai',
  'Jun',
  'Jul',
  'Ago',
  'Set',
  'Out',
  'Nov',
  'Dez',
]

export function formatMonthPt(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m) return ym
  return `${PT_MONTHS[m - 1]} ${y}`
}

export function formatDatePt(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${d} ${PT_MONTHS[m - 1]}`
}
