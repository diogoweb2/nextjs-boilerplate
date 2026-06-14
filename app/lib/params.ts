/** Parse the shared period/special query params used by analytics pages. */
export function parsePeriodParams(sp: Record<string, string | string[] | undefined>): {
  months: number
  excludeSpecial: boolean
  month: string | null
  category: string | null
} {
  const raw = Number(Array.isArray(sp.months) ? sp.months[0] : sp.months)
  const months = [1, 2, 3, 6, 12].includes(raw) ? raw : 3
  const special = Array.isArray(sp.special) ? sp.special[0] : sp.special
  const rawMonth = Array.isArray(sp.month) ? sp.month[0] : sp.month
  const month = rawMonth && /^\d{4}-\d{2}$/.test(rawMonth) ? rawMonth : null
  const rawCategory = Array.isArray(sp.category) ? sp.category[0] : sp.category
  const category = rawCategory ?? null
  return { months, excludeSpecial: special === '0', month, category }
}
