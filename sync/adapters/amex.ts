import type { Page } from 'playwright'
import { join } from 'path'
import { downloadDir } from '../lib/profile'
import type { Adapter, Credentials, DateRange } from './types'
import { HARDENED_LAUNCH } from '../lib/stealth'

/**
 * American Express (Canada) credit-card adapter.
 *
 * Format: Amex's CSV export ingests as the existing `amex` source — the app
 * already parses it (header carries `Card Member` / `Account #`; see
 * app/lib/csv.ts `detectSource` + `parseAmex`). No new parser.
 *
 * Login is a single step (User ID + password) on a React app. Fields are in the
 * light DOM (`#eliloUserID`, `#eliloPassword`) and the submit button is
 * `#loginSubmit`. We send the runner straight to the statements page via the
 * login form's `DestPage` param so a trusted session lands on the page we need.
 *
 * Device MFA ("we don't recognize this device" / one-time code) only appears
 * when the trusted session has expired. Daily runs reuse the persistent profile
 * and skip it; when it does appear the runner pauses for the user (see
 * AUTO_SYNC_PLAN.md §3 and the Rogers adapter for the same pattern).
 */

const STATEMENTS_URL = 'https://global.americanexpress.com/statements'
const LOGIN_URL =
  'https://www.americanexpress.com/en-ca/account/login?DestPage=' +
  encodeURIComponent(STATEMENTS_URL)

async function needsLogin(page: Page): Promise<boolean> {
  // The User ID field is only present on the logged-out login screen.
  return page
    .locator('#eliloUserID')
    .isVisible()
    .catch(() => false)
}

async function login(page: Page, creds: Credentials): Promise<void> {
  // Amex client-redirects the first navigation (to the elilo login host), which
  // aborts goto with net::ERR_ABORTED even though the page loads. Swallow it; the
  // #eliloUserID wait below is the real gate (and decides trusted vs. logged-out).
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})

  const username = page.locator('#eliloUserID')
  try {
    await username.waitFor({ state: 'visible', timeout: 10_000 })
  } catch {
    // No login form appeared → the persistent session is still trusted.
    return
  }

  await username.fill(creds.username)
  await page.locator('#eliloPassword').fill(creds.password)
  await page.locator('#loginSubmit').click()

  // Verify the login left the login screen. A rejected login (wrong password or
  // a bot-score block on automated/headless sessions) keeps us on /account/login
  // — fail loudly instead of proceeding unauthenticated. A success leaves it for
  // either the statements page or the device-MFA screen.
  try {
    await page.waitForURL((url) => !url.pathname.includes('/account/login'), { timeout: 20_000 })
  } catch {
    throw new Error(
      'Login did not complete — still on /account/login after submitting. Likely cause: the ' +
        'stored Keychain password is wrong, or Amex blocked the automated login (more likely ' +
        'in headless). See the failure screenshot in the logs dir.'
    )
  }
  await page.waitForLoadState('networkidle').catch(() => {})
}

async function isMfaChallenge(page: Page): Promise<boolean> {
  // TODO(pass 2): tighten with the real Amex MFA-screen selector/URL once
  // observed. Heuristic for now: a verification/approval prompt is visible and
  // we're no longer on the User ID screen.
  if (await needsLogin(page)) return false
  const body = await page.locator('body').innerText().catch(() => '')
  return /verif|authenticat|approve|one[- ]time|security code|we sent|recognize this device/i.test(
    body
  )
}

/**
 * Amex's "Latest Transactions" panel is the active, unbilled cycle — the rolling
 * window the daily sync needs — so `_range` is unused (like Rogers). Re-importing
 * is free (dedup on the parsed external id), so re-downloading the same cycle
 * every day is harmless.
 *
 * The download is a two-step UI: expand the panel, click its Download button to
 * open a modal, pick CSV, then click the confirm anchor (whose href is the CSV
 * API). The latest-transactions Download button's `data-testid` embeds the
 * statement date (which changes), so we match the stable prefix+suffix instead.
 */
async function exportCsv(page: Page, _range: DateRange): Promise<string> {
  // Tolerate the client-redirect abort (see login); the #latest-transactions
  // wait below is the real gate.
  await page.goto(STATEMENTS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})

  // Expand "Latest Transactions" if it's collapsed.
  const panel = page.locator('#latest-transactions')
  await panel.waitFor({ state: 'visible', timeout: 15_000 })
  if ((await panel.getAttribute('aria-expanded')) !== 'true') {
    await panel.click()
  }

  // Open the download modal. The testid embeds a date, so match prefix+suffix.
  const openDialog = page.locator(
    'button[data-testid*="latest-transactions/"][data-testid$="/download-button"]'
  )
  await openDialog.first().waitFor({ state: 'visible', timeout: 10_000 })
  await openDialog.first().click()

  // Pick the CSV format in the modal (clicking the label selects its radio).
  const csv = page.locator('label[for="myca-activity-download-body-selection-options-csv"]')
  await csv.waitFor({ state: 'visible', timeout: 10_000 })
  await csv.click()

  // Arm the download listener before the click that triggers it. The confirm
  // anchor's href is the CSV documents API.
  const confirm = page.locator(
    '#myca-activity-download-footer-download-confirm-csv-Download-anchor'
  )
  await confirm.waitFor({ state: 'visible', timeout: 10_000 })
  const [download] = await Promise.all([page.waitForEvent('download'), confirm.click()])

  const stamp = new Date().toISOString().slice(0, 10)
  const dest = join(downloadDir('amex'), `amex-latest-${stamp}.csv`)
  await download.saveAs(dest)
  return dest
}

export const amex: Adapter = {
  importSource: 'amex',
  loginUrl: LOGIN_URL,
  // Amex's login is behind aggressive bot detection (Akamai/Shape) that silently
  // rejects an automated browser — the submit spins, then the form just resets
  // with no error. We stay on the isolated bundled Chromium (so the unattended
  // daily run never fights an already-open Chrome) and defeat detection with
  // launch flags + a stealth init script (see lib/stealth.ts).
  launchOptions: HARDENED_LAUNCH,
  needsLogin,
  login,
  isMfaChallenge,
  exportCsv,
}
