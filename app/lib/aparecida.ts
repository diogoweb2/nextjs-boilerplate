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

/**
 * "Fora do padrão" — deterministic, statistics-only anomaly flags (no AI at
 * runtime; the app stays fully deterministic per house rule, only the PDF
 * extraction step in scripts/aparecida-import.ts calls a model). The goal is
 * to surface charges worth a second look, not to accuse — every flag is a
 * plain statistical outlier a human can eyeball and dismiss.
 */
export type AparecidaFlagCode =
  | 'high_category_amount'
  | 'high_overall_amount'
  | 'new_merchant_high_value'
  | 'unusual_city'
  | 'possible_duplicate'

export type AparecidaFlag = { code: AparecidaFlagCode; label: string }

export type FlaggedAparecidaTransaction = AparecidaTransaction & { flags: AparecidaFlag[] }

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/** Best-effort trailing city guess from a statement line like "Q HORTA RECIFE". */
function guessCity(description: string): string | null {
  const words = description.trim().split(/\s+/)
  const last = words[words.length - 1]
  if (!last || last.length < 4 || !/^[A-ZÀ-Ú]+$/.test(last)) return null
  return last
}

/**
 * She lives in Recife; a charge in Olinda or anywhere else in Grande Recife
 * is completely normal and shouldn't get flagged just for not matching the
 * single "dominant city" token. Trailing tokens seen on real statements for
 * the metro-area cities (multi-word names get truncated to their last word
 * by guessCity, e.g. "JABOATAO DOS GUARARAPES" -> "GUARARAPES").
 */
const RECIFE_METRO_CITIES = new Set([
  'RECIFE',
  'OLINDA',
  'PAULISTA',
  'CAMARAGIBE',
  'JABOATAO',
  'GUARARAPES',
  'IGARASSU',
  'IPOJUCA',
  'ABREU',
  'CABO',
  'MATA',
])

const MIN_FLAG_AMOUNT = 30 // ignore trivial charges even if statistically odd

export function detectAnomalies(txns: AparecidaTransaction[]): FlaggedAparecidaTransaction[] {
  const amounts = txns.map((t) => Number(t.amount))
  const overallMedian = median(amounts)

  // Per-category mean/stddev (need a handful of samples to mean anything).
  const byCategory = new Map<string, number[]>()
  for (const t of txns) {
    if (!byCategory.has(t.category)) byCategory.set(t.category, [])
    byCategory.get(t.category)!.push(Number(t.amount))
  }
  const categoryStats = new Map<string, { mean: number; std: number }>()
  for (const [cat, vals] of byCategory) {
    if (vals.length < 4) continue
    const m = mean(vals)
    categoryStats.set(cat, { mean: m, std: stddev(vals, m) })
  }

  // Dominant city — the one most of her spending happens in.
  const cityCounts = new Map<string, number>()
  for (const t of txns) {
    const city = guessCity(t.description)
    if (city) cityCounts.set(city, (cityCounts.get(city) ?? 0) + 1)
  }
  const dominantCity = [...cityCounts.entries()].sort(([, a], [, b]) => b - a)[0]?.[0] ?? null
  const dominantCityCount = dominantCity ? cityCounts.get(dominantCity)! : 0

  // Merchant description sighted count (exact text match).
  const descriptionCounts = new Map<string, number>()
  for (const t of txns) {
    descriptionCounts.set(t.description, (descriptionCounts.get(t.description) ?? 0) + 1)
  }

  // Same day + same description + same amount, seen more than once.
  const duplicateKeyCounts = new Map<string, number>()
  for (const t of txns) {
    const key = `${t.txnDate}|${t.description}|${t.amount}`
    duplicateKeyCounts.set(key, (duplicateKeyCounts.get(key) ?? 0) + 1)
  }

  return txns.map((t) => {
    const amount = Number(t.amount)
    const flags: AparecidaFlag[] = []

    if (amount >= MIN_FLAG_AMOUNT) {
      const catStat = categoryStats.get(t.category)
      if (catStat && catStat.std > 0 && amount > catStat.mean + 2.5 * catStat.std) {
        flags.push({
          code: 'high_category_amount',
          label: `Bem acima do normal para ${t.category} (média ${formatBRL(catStat.mean)})`,
        })
      } else if (overallMedian > 0 && amount > overallMedian * 6) {
        flags.push({
          code: 'high_overall_amount',
          label: `Muito acima do lançamento típico (mediana ${formatBRL(overallMedian)})`,
        })
      }

      if (descriptionCounts.get(t.description) === 1 && overallMedian > 0 && amount > overallMedian * 3) {
        flags.push({
          code: 'new_merchant_high_value',
          label: 'Comerciante que só aparece uma vez, com valor alto',
        })
      }
    }

    // City mismatch only means something once there's a real "normal" to compare against.
    const city = guessCity(t.description)
    if (
      city &&
      dominantCity &&
      city !== dominantCity &&
      dominantCityCount >= 10 &&
      !RECIFE_METRO_CITIES.has(city)
    ) {
      flags.push({
        code: 'unusual_city',
        label: `Cidade incomum: ${city} (normalmente ${dominantCity})`,
      })
    }

    const dupKey = `${t.txnDate}|${t.description}|${t.amount}`
    if ((duplicateKeyCounts.get(dupKey) ?? 0) > 1) {
      flags.push({ code: 'possible_duplicate', label: 'Possível cobrança duplicada no mesmo dia' })
    }

    // Owner override: marked "não é suspeito" clears everything EXCEPT the
    // amount-based flags — a legit merchant can still post a charge that's
    // genuinely way above normal, and that's worth a fresh look regardless of
    // an earlier dismissal (which was about the merchant/location, not this
    // specific amount).
    const finalFlags = t.notSuspicious
      ? flags.filter((f) => f.code === 'high_category_amount' || f.code === 'high_overall_amount')
      : flags

    return { ...t, flags: finalFlags }
  })
}
