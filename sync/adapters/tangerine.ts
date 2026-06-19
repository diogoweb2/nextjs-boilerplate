import type { Page } from 'playwright'
import { join } from 'path'
import { downloadDir } from '../lib/profile'
import { HARDENED_LAUNCH } from '../lib/stealth'
import type { Adapter, Credentials, DateRange } from './types'

/**
 * Tangerine (bank) adapter.
 *
 * Format: Tangerine's CSV export ingests as the existing `tangerine` source — the
 * app already parses it (header `Date,Transaction,Name,Memo,Amount`; see
 * app/lib/csv.ts `detectSource` + `parseTangerine`). No new parser.
 *
 * Login is TWO steps on an Angular Material SPA (hash routing under `/app/#/`):
 *  1. Login ID screen — `#login-user-id-input` then `#login-user-id-submit-button`
 *     ("Next"). With a remembered device the saved ID shows as a dropdown (no
 *     editable textbox), so we only type when the textbox is actually present.
 *  2. Password screen — `#passwordId-input` then `#login-pin-submit-button`
 *     ("Log In").
 * We also flip the "Remember me on this device" toggle on, which keeps the device
 * trusted so 2-step verification stays skipped on the daily runs.
 *
 * MFA (2-step verification) only appears when device trust has expired. Daily runs
 * reuse the persistent profile and skip it; when it does appear the runner pauses
 * for the user (see the Rogers/Amex/Scotia adapters for the same pattern).
 *
 * Bot detection: a plain automated browser is refused ("This function is currently
 * unavailable"), so we strip the automation tell with the anti-automation launch
 * flags (HARDENED_LAUNCH — `navigator.webdriver` becomes false NATURALLY, no
 * faking). We do NOT inject the stealth init script: Tangerine's anti-tamper
 * fingerprinting (iovation/ThreatMetrix) detects the patched `navigator` and
 * renders a BLANK page, so we set `applyStealthScript: false`. The launchd wrapper
 * runs HEADED, which this needs.
 *
 * Browser: bundled Chromium (HARDENED_LAUNCH), same as Amex/Scotia/Rogers. We used
 * to force real Chrome (`channel: 'chrome'`, HARDENED_CHROME_LAUNCH) because older
 * Chromium rendered a blank Angular page, but that no longer reproduces — bundled
 * Chromium + flags renders the login fully. Real Chrome was ALSO actively broken:
 * Chrome 149 disconnects from Playwright 1.61's CDP pipe immediately on launch
 * (the page closes within ~1s), which is what broke this sync. Bundled Chromium is
 * version-locked to Playwright, so it sidesteps that entirely.
 */

const LOGIN_URL = 'https://www.tangerine.ca/app/#/login/login-id?locale=en_CA'
// Download page is reached client-side via this hash (see exportCsv — a hard
// navigation reloads the SPA and drops the session).
const DOWNLOAD_HASH = '#/download-transactions?locale=en_CA'

async function needsLogin(page: Page): Promise<boolean> {
  // Either login step (the "Next" id button or the password field) is only present
  // while we're in the logged-out login flow.
  return (
    (await page.locator('#login-user-id-submit-button').isVisible().catch(() => false)) ||
    (await page.locator('#passwordId-input').isVisible().catch(() => false))
  )
}

/**
 * Type into an Angular Material reactive-form input RELIABLY. Playwright's
 * `fill()` sets the DOM `.value` and fires a single `input` event, which this
 * form does NOT always register — the text appears on screen but Angular's form
 * model stays empty, so the submit button never enables and the page rejects the
 * (model-)empty field. Real per-character keystrokes (`pressSequentially`) drive
 * Angular's bindings the same way a human does; we clear first and verify the DOM
 * value stuck so a silent miss fails loudly instead of submitting blank.
 */
async function typeInto(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector)
  await input.waitFor({ state: 'visible', timeout: 15_000 })
  // The login spinner overlays the form between steps and intercepts clicks; wait
  // it out so the click lands on the field instead of the spinner.
  await page.locator('#login-spinner').waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
  await input.click()
  await input.fill('') // clear any pre-filled value
  await input.pressSequentially(value, { delay: 25 })
  const got = await input.inputValue().catch(() => '')
  if (got.length !== value.length) {
    throw new Error(`Could not enter value into ${selector} (got ${got.length}/${value.length} chars).`)
  }
}

async function login(page: Page, creds: Credentials): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})

  // STEP 1 — Login ID. The form has TWO variants:
  //  • First time / ID not remembered → an editable textbox (#login-user-id-input)
  //    that we must type the username into.
  //  • ID remembered on this device → a mat-select dropdown
  //    (#login-user-id-saved-ids) already showing the saved ID, so there's nothing
  //    to type and we just click Next.
  const next = page.locator('#login-user-id-submit-button')
  try {
    await next.waitFor({ state: 'visible', timeout: 15_000 })
  } catch {
    // No login screen appeared → the persistent session is still trusted.
    return
  }
  // A still-trusted session briefly FLASHES the login form before its auth guard
  // redirects to the dashboard. Wait for the login spinner to clear, then bail out
  // if we've routed off /login — otherwise we'd type into a form that's detaching.
  await page.locator('#login-spinner').waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
  if (!page.url().includes('/login')) return
  // Decide the variant by WAITING for the saved-ID dropdown (the remembered case,
  // now the norm) — a single isVisible() snapshot is unreliable because the
  // editable textbox flashes into the DOM first and then detaches before the
  // dropdown stabilizes. If the dropdown shows, the saved ID is pre-selected and
  // there's nothing to type; otherwise it's the textbox and we type the username.
  const savedIdDropdown = page.locator('#login-user-id-saved-ids')
  const savedIdShown = await savedIdDropdown
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false)
  if (!savedIdShown) {
    await typeInto(page, '#login-user-id-input', creds.username)
  }
  // Keep the device remembered so MFA stays skipped (only flip it if it's off, so
  // we never accidentally toggle it back off).
  const remember = page.locator('#login-user-id-remember-me-toggle-button')
  if ((await remember.getAttribute('aria-checked').catch(() => null)) === 'false') {
    await remember.click().catch(() => {})
  }
  // Wait out the spinner so the click lands on Next, not the overlay. click()
  // auto-waits for the button to leave its disabled state once the form is valid.
  await page.locator('#login-spinner').waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
  await next.click()

  // STEP 2 — Password.
  await typeInto(page, '#passwordId-input', creds.password)
  await page.locator('#login-pin-submit-button').click()
  const password = page.locator('#passwordId-input')

  // Verify the login left the password screen. A rejected login (wrong password or
  // a bot-score block on automated/headless sessions) keeps it showing — fail
  // loudly instead of proceeding unauthenticated. A success leaves it for either
  // the dashboard or the 2-step verification screen, both of which drop the field.
  try {
    await password.waitFor({ state: 'hidden', timeout: 20_000 })
  } catch {
    throw new Error(
      'Login did not complete — the password field is still showing after submitting. Likely ' +
        'cause: the stored Keychain password is wrong, or Tangerine blocked the automated login ' +
        '(more likely in headless). See the failure screenshot in the logs dir.'
    )
  }
  await page.waitForLoadState('networkidle').catch(() => {})
}

async function isMfaChallenge(page: Page): Promise<boolean> {
  // On a login step → not MFA, the session just expired.
  if (await needsLogin(page)) return false
  // Tangerine's 2-step verification lives in the `/login` flow; once we've routed
  // away from it we're authenticated (keyword matching alone is unreliable — the
  // logged-in app contains words like "verified" that would spin the wait loop).
  if (!page.url().includes('/login')) return false
  const body = await page.locator('body').innerText().catch(() => '')
  return /verif|authenticat|one[- ]time|security code|we sent|enter the code|2-step/i.test(body)
}

/**
 * Tangerine's download page lets you pick a format and pull the current activity —
 * the rolling window the daily sync needs — so `_range` is unused (like the other
 * adapters). Re-importing is free (dedup on the parsed tangerine external id), so
 * re-downloading every day is harmless.
 *
 * Picking CSV from the `selectDownloadFormat` mat-select and clicking Download
 * opens the file in a NEW TAB; with `acceptDownloads` Playwright captures it as a
 * context-level download event (so we listen on the context, not just this page).
 *
 * The route lands on the Transactions page with the "Statements" tab active by
 * default, so we first click the "Download Transactions" tab (rendered as an <a>
 * link, not a button) to reveal the format dropdown.
 */
async function exportCsv(page: Page, _range: DateRange): Promise<string> {
  // Navigate WITHIN the SPA via a hashchange. A hard page.goto() reloads the app,
  // drops the in-memory session, and bounces back to the login screen; the Angular
  // router picks up a hash change client-side with the session intact.
  await page.evaluate((hash) => {
    window.location.hash = hash
  }, DOWNLOAD_HASH)

  // Defensive: if the login screen still shows (saved-ID dropdown), the device is
  // trusted, so clicking Next carries us back in, then re-route to the download page.
  const next = page.locator('#login-user-id-submit-button')
  const onLogin = await next.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)
  if (onLogin) {
    await page.locator('#login-spinner').waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
    await next.click().catch(() => {})
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.evaluate((hash) => {
      window.location.hash = hash
    }, DOWNLOAD_HASH)
  }

  // Some layouts land on the "Statements" tab first; if its "Download
  // Transactions" link is shown, click it. The client-side hash nav usually lands
  // straight on the form, in which case the link isn't present — so it's optional.
  const downloadTab = page.getByRole('link', { name: 'Download Transactions' })
  if (await downloadTab.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
    await downloadTab.click()
  }

  // Account — the form is supposed to auto-select the account, but that's flaky.
  // If nothing is chosen (placeholder still showing), open it and pick the first
  // account; the Download button stays disabled until an account is selected.
  const accountSelect = page.locator('#e-transfer-account')
  await accountSelect.waitFor({ state: 'visible', timeout: 20_000 })
  if (await accountSelect.locator('.mat-mdc-select-placeholder').isVisible().catch(() => false)) {
    await accountSelect.click()
    const firstAccount = page.getByRole('option').first()
    await firstAccount.waitFor({ state: 'visible', timeout: 10_000 })
    await firstAccount.click()
  }

  // Download format — choose CSV if not already set.
  const formatSelect = page.locator('mat-select[name="selectDownloadFormat"]')
  await formatSelect.waitFor({ state: 'visible', timeout: 20_000 })
  if (await formatSelect.locator('.mat-mdc-select-placeholder').isVisible().catch(() => false)) {
    await formatSelect.click()
    const csvOption = page.getByRole('option', { name: 'Excel, other software (CSV)' })
    await csvOption.waitFor({ state: 'visible', timeout: 10_000 })
    await csvOption.click()
  }

  // Arm the download listener before the click. Download opens a new tab, so the
  // event surfaces on the context rather than this page.
  const downloadPromise = page.context().waitForEvent('download')
  await page.locator('#download-transactions-button').click()
  const download = await downloadPromise

  const stamp = new Date().toISOString().slice(0, 10)
  const dest = join(downloadDir('tangerine'), `tangerine-${stamp}.csv`)
  await download.saveAs(dest)
  return dest
}

export const tangerine: Adapter = {
  importSource: 'tangerine',
  loginUrl: LOGIN_URL,
  // Bundled Chromium + anti-automation flags defeats the "function unavailable"
  // block; the stealth init script is SKIPPED because Tangerine's anti-tamper
  // fingerprinting blanks the page when navigator is patched (see lib/stealth.ts).
  launchOptions: HARDENED_LAUNCH,
  applyStealthScript: false,
  needsLogin,
  login,
  isMfaChallenge,
  exportCsv,
}
