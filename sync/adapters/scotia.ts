import type { Page } from 'playwright'
import { join } from 'path'
import { downloadDir } from '../lib/profile'
import type { Adapter, Credentials, DateRange } from './types'

/**
 * Scotiabank (chequing) adapter.
 *
 * Format: Scotia's CSV export ingests as the existing `scotia` source — the app
 * already parses it (header carries `Sub-description` + `Type of Transaction`;
 * see app/lib/csv.ts `detectSource` + `parseScotia`). No new parser.
 *
 * Login is a single step (username/card number + password) on a React app whose
 * fields live in the light DOM (`#usernameInput-input`, `#password-input`, submit
 * `#signIn`). The logged-out login form lives on the `auth.scotiaonline...` host,
 * reached via a one-time `oauth_key` URL we CAN'T hardcode — so instead we send a
 * trusted session straight to the secure accounts page and let Scotia bounce an
 * expired session to a freshly-keyed login screen for us.
 *
 * Device MFA ("Sign in to the app to confirm it's you") only appears when the
 * trusted session has expired. Daily runs reuse the persistent profile and skip
 * it; when it does appear the runner pauses for the user (see the Rogers/Amex
 * adapters for the same pattern, and AUTO_SYNC_PLAN.md §3).
 */

const ACCOUNTS_URL = 'https://secure.scotiabank.com/my-accounts'

async function needsLogin(page: Page): Promise<boolean> {
  // The username field is only present on the logged-out sign-in screen.
  return page
    .locator('#usernameInput-input')
    .isVisible()
    .catch(() => false)
}

async function login(page: Page, creds: Credentials): Promise<void> {
  // Hitting the secure accounts page with an expired session bounces through the
  // oauth flow to a freshly-keyed login form; with a trusted session it just
  // loads the accounts page (no username field → we're already in).
  await page.goto(ACCOUNTS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})

  const username = page.locator('#usernameInput-input')
  try {
    await username.waitFor({ state: 'visible', timeout: 10_000 })
  } catch {
    // No login form appeared → the persistent session is still trusted.
    return
  }

  await username.fill(creds.username)
  await page.locator('#password-input').fill(creds.password)
  await page.locator('#signIn').click()

  // Verify the login left the username screen. A rejected login (wrong password
  // or a bot-score block on automated/headless sessions) keeps the form showing
  // — fail loudly instead of proceeding unauthenticated. A success leaves it for
  // either the accounts page or the device-MFA ("confirm in app") screen, both of
  // which drop the username field.
  try {
    await username.waitFor({ state: 'hidden', timeout: 20_000 })
  } catch {
    throw new Error(
      'Login did not complete — the username field is still showing after submitting. Likely ' +
        'cause: the stored Keychain password is wrong, or Scotia blocked the automated login ' +
        '(more likely in headless). See the failure screenshot in the logs dir.'
    )
  }
  await page.waitForLoadState('networkidle').catch(() => {})
}

async function isMfaChallenge(page: Page): Promise<boolean> {
  // Heuristic: the "confirm it's you" app-approval prompt is visible and we're no
  // longer on the username screen.
  if (await needsLogin(page)) return false
  const body = await page.locator('body').innerText().catch(() => '')
  return /confirm it'?s you|sign in to the app|verif|authenticat|approve|one[- ]time|security code|we sent/i.test(
    body
  )
}

/**
 * Scotia's account view shows the active, unbilled cycle by default — the rolling
 * window the daily sync needs — so `_range` is unused (like Rogers/Amex).
 * Re-importing is free (dedup on the parsed scotia external id), so re-downloading
 * the same cycle every day is harmless.
 *
 * We open the chequing account from the accounts list by matching the link's href
 * (`/accounts/chequing/`), not the account number — so nothing account-specific
 * lands in this PUBLIC repo, and it survives Scotia rotating the opaque per-account
 * path token in the URL. The download is then a two-step UI: click the Download
 * kebab to open a menu, then click "Download as CSV", which triggers a native save
 * we capture.
 */
async function exportCsv(page: Page, _range: DateRange): Promise<string> {
  await page.goto(ACCOUNTS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})

  // Open the chequing account from the accounts list.
  const account = page.locator('a[href*="/accounts/chequing/"]').first()
  await account.waitFor({ state: 'visible', timeout: 15_000 })
  await account.click()

  const openMenu = page.locator('#download-print-action-menu')
  await openMenu.waitFor({ state: 'visible', timeout: 15_000 })
  await openMenu.click()

  // Arm the download listener before the click that triggers it.
  const csv = page.getByRole('button', { name: 'Download as CSV' })
  await csv.waitFor({ state: 'visible', timeout: 10_000 })
  const [download] = await Promise.all([page.waitForEvent('download'), csv.click()])

  const stamp = new Date().toISOString().slice(0, 10)
  const dest = join(downloadDir('scotia'), `scotia-current-${stamp}.csv`)
  await download.saveAs(dest)
  return dest
}

export const scotia: Adapter = {
  importSource: 'scotia',
  loginUrl: ACCOUNTS_URL,
  needsLogin,
  login,
  isMfaChallenge,
  exportCsv,
}
