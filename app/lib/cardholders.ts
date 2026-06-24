/**
 * Maps a card's last-4 to "who made the purchase" WITHOUT storing names in the
 * DB or the (public) repo. The name<->card mapping lives only in .env.local:
 *
 *   PARTNER_CARDS=8616,11011   # last-4 of the partner's cards
 *   PARTNER_NAME=Alice
 *   SELF_NAME=Me
 *
 * Anything not in PARTNER_CARDS is attributed to SELF. Defaults are neutral so
 * the committed code never contains a real name.
 */
export function cardholderName(last4: string | null): string {
  const partnerCards = (process.env.PARTNER_CARDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const partnerName = process.env.PARTNER_NAME ?? 'Partner'
  const selfName = process.env.SELF_NAME ?? 'Me'
  return last4 && partnerCards.includes(last4) ? partnerName : selfName
}

/** Display names + partner card last-4s for the auto-fill feature (server-side). */
export function getPersonNames(): { selfName: string; partnerName: string; partnerCards: string[] } {
  return {
    selfName: process.env.SELF_NAME ?? 'Me',
    partnerName: process.env.PARTNER_NAME ?? 'Partner',
    partnerCards: (process.env.PARTNER_CARDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  }
}
