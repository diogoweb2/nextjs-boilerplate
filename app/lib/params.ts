/** Parse the shared period/special query params used by analytics pages. */
export function parsePeriodParams(sp: Record<string, string | string[] | undefined>): {
  months: number
  excludeSpecial: boolean
} {
  const raw = Number(Array.isArray(sp.months) ? sp.months[0] : sp.months)
  const months = [1, 3, 6, 12].includes(raw) ? raw : 3
  const special = Array.isArray(sp.special) ? sp.special[0] : sp.special
  return { months, excludeSpecial: special === '0' }
}
