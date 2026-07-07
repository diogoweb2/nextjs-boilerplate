import type { Page } from 'playwright'
import { join } from 'path'
import { downloadDir, readMarker, writeMarker } from '../lib/profile'
import { HARDENED_LAUNCH } from '../lib/stealth'
import { parseScotiaMortgageBalance, parseScotiaMortgageRate } from '../../app/lib/mortgage'
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
 * reached via a one-time `oauth_key` URL we CAN'T hardcode — so instead we enter
 * the way a person does: load the public personal-banking homepage and click its
 * "Sign In" link. Scotia then either shows the login form (expired session) or
 * redirects straight through to my-accounts (trusted session). Entering via the
 * homepage — rather than a cold `goto` to the authenticated deep link — also keeps
 * the WAF happy (the deep-link goto was getting blocked).
 *
 * Device MFA ("Sign in to the app to confirm it's you") only appears when the
 * trusted session has expired. Daily runs reuse the persistent profile and skip
 * it; when it does appear the runner pauses for the user (see the Rogers/Amex
 * adapters for the same pattern, and AUTO_SYNC_PLAN.md §3).
 *
 * Bot detection: Scotia's WAF refuses a plain automated browser ("sorry, we
 * couldn't complete your request… Ref: #…"), so — like Amex — we run the isolated
 * bundled Chromium with anti-automation launch flags + a stealth init script (see
 * lib/stealth.ts). The launchd wrapper runs HEADED, which the hardening needs.
 */

const HOME_URL = 'https://www.scotiabank.com/ca/en/personal.html'
// Where the homepage's desktop "Sign In" link points (the online-banking entry).
const ONLINE_URL = 'https://www.scotiaonline.scotiabank.com'

async function needsLogin(page: Page): Promise<boolean> {
  // The username field is only present on the logged-out sign-in screen.
  return page
    .locator('#usernameInput-input')
    .isVisible()
    .catch(() => false)
}

async function login(page: Page, creds: Credentials): Promise<void> {
  // Enter like a person: load the public homepage, then click its "Sign In" link
  // (which routes to the online-banking host). With an expired session that lands
  // on the login form; with a trusted session it redirects straight to my-accounts
  // (no username field → we're already in). A cold goto to the authenticated deep
  // link gets blocked by the WAF, so we go through the homepage instead.
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  // Enter online banking the way the homepage's desktop "Sign In" does — by going
  // to its destination directly. Clicking the link doesn't reliably trigger the
  // navigation (the homepage wraps the anchor in analytics JS that swallows the
  // default click, and a hidden mobile twin shares the class). A goto to this
  // login-entry host is exactly what the button does, and it isn't the WAF-blocked
  // secure deep link. Loading the homepage first warms cookies/referer.
  await page.goto(ONLINE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})

  const username = page.locator('#usernameInput-input')
  try {
    await username.waitFor({ state: 'visible', timeout: 15_000 })
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
  // On the login form → not MFA, the session just expired.
  if (await needsLogin(page)) return false
  // Reached the authenticated banking host → login + any MFA are done. This is the
  // real "cleared" signal: after you approve on your phone Scotia redirects the
  // auth/passport interstitial to secure.scotiabank.com/my-accounts. (Keyword
  // matching alone is unreliable here — the logged-in dashboard contains words like
  // "authenticate"/"verified", which would keep the approval-wait loop spinning.)
  if (page.url().includes('secure.scotiabank.com')) return false
  // Otherwise we're on the auth interstitial — the app-approval prompt is MFA.
  const body = await page.locator('body').innerText().catch(() => '')
  return /confirm it'?s you|sign in to the app|approve|verif|authenticat|one[- ]time|security code|we sent/i.test(
    body
  )
}

/**
 * Scotia's account view shows the active, unbilled cycle by default — the rolling
 * window the daily sync needs — so `_range` is unused (like Rogers/Amex).
 * Re-importing is free (dedup on the parsed scotia external id), so re-downloading
 * the same cycle every day is harmless.
 *
 * After login we're already on my-accounts, so we navigate by CLICKING the
 * chequing account from the list (matching the link's href, `/accounts/chequing/`,
 * not the account number) rather than another cold goto — both to keep nothing
 * account-specific in this PUBLIC repo and because the deep-link goto trips the
 * WAF. (Matching the href also survives Scotia rotating the opaque per-account
 * path token in the URL.) The download is then a two-step UI: click the Download
 * kebab to open a menu, then click "Download as CSV", which triggers a native save
 * we capture.
 */
async function exportCsv(page: Page, _range: DateRange): Promise<string> {
  // No goto — login left us on my-accounts. Open the chequing account by clicking
  // its link in the accounts list (a real navigation the WAF accepts).
  const account = page.locator('a[href*="/accounts/chequing/"]').first()
  await account.waitFor({ state: 'visible', timeout: 20_000 })
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

/**
 * Read the exact Scotia mortgage balance from the my-accounts landing page, run
 * right after login and BEFORE `exportCsv` clicks into chequing (which leaves
 * this page). The mortgage row carries a stable `data-bc` attribute
 * (`…ScotiaMortgage`); its styled-component CSS classes are build-time hashes
 * that rotate every deploy, so we anchor on `data-bc`, never the classes. We read
 * the row's full text (via textContent, which includes the visually-hidden
 * screen-reader label "…balance is CA$175,221.22") and hand it to the shared
 * `parseScotiaMortgageBalance` — one parser for both this scrape and the manual
 * paste box in the app. Soft-fails to null (no mortgage / layout drift) so it
 * never aborts the transaction sync.
 */
async function captureMortgageBalance(page: Page): Promise<number | null> {
  const row = () => page.locator('[data-bc*="ScotiaMortgage"]').first()
  const read = async (timeout: number): Promise<number | null> => {
    try {
      await row().waitFor({ state: 'attached', timeout })
    } catch {
      return null
    }
    const text = (await row().textContent().catch(() => '')) ?? ''
    return parseScotiaMortgageBalance(text)
  }

  // First try wherever we already are (the automated flow lands on my-accounts).
  const here = await read(8_000)
  if (here !== null) return here

  // Not found — we may still be on the public homepage (this happens in --manual
  // mode, which skips login()). Enter online banking the same WAF-safe way login()
  // does: goto the online host, which redirects a trusted session straight to the
  // my-accounts summary where the mortgage row lives. Then read once more.
  if (!page.url().includes('secure.scotiabank.com')) {
    await page.goto(ONLINE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForLoadState('networkidle').catch(() => {})
  }
  return read(15_000)
}

/**
 * Once a month, read the mortgage's current interest rate from its account page
 * so the payoff projection uses the real rate instead of the back-solved estimate.
 *
 * Throttled to one check per calendar month via a persistent marker (the rate
 * barely moves, and this costs an extra navigation) — returns null on the other
 * daily runs. The marker is only stamped on a SUCCESSFUL read, so a failed scrape
 * retries on the next daily run rather than skipping the whole month.
 *
 * Navigation is WAF-safe and token-rotation-proof: we re-enter online banking via
 * the online host (which redirects to the my-accounts summary), then CLICK the
 * mortgage account by its stable `/accounts/mortgage/` href — never a cold goto to
 * the opaque deep link. On the account page we anchor on the stable "Interest
 * rate" label (styled-component classes are hashed and rotate each deploy) and read
 * its info-line value. Soft-fails to null so it never disrupts the CSV sync.
 */
async function captureMortgageRate(page: Page): Promise<number | null> {
  const month = new Date().toISOString().slice(0, 7)
  if (readMarker('scotia', 'rate-checked') === month) return null // already this month

  // Land on the my-accounts summary (WAF-safe entry), then open the mortgage.
  await page.goto(ONLINE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
  const link = page.locator('a[href*="/accounts/mortgage/"]').first()
  try {
    await link.waitFor({ state: 'visible', timeout: 15_000 })
    await link.click()
  } catch {
    return null
  }
  await page.waitForLoadState('networkidle').catch(() => {})

  // Anchor on the stable "Interest rate" label; its info-line parent holds the
  // "3.55%" value. textContent of that parent → "Interest rate3.55%".
  const label = page.getByText('Interest rate', { exact: true }).first()
  try {
    await label.waitFor({ state: 'attached', timeout: 15_000 })
  } catch {
    return null
  }
  const lineText = (await label.locator('xpath=..').textContent().catch(() => '')) ?? ''
  const rate = parseScotiaMortgageRate(lineText)
  if (rate === null) return null // leave the marker unset → retry next daily run
  writeMarker('scotia', 'rate-checked', month)
  return rate
}

export const scotia: Adapter = {
  importSource: 'scotia',
  loginUrl: HOME_URL,
  // Scotia's WAF silently blocks an automated browser; harden the launch and
  // apply the stealth init script (same recipe as Amex — see lib/stealth.ts).
  launchOptions: HARDENED_LAUNCH,
  needsLogin,
  login,
  isMfaChallenge,
  exportCsv,
  captureMortgageBalance,
  captureMortgageRate,
}
