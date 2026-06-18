import type { Page } from 'playwright'
import { join } from 'path'
import { downloadDir } from '../lib/profile'
import { HARDENED_CHROME_LAUNCH } from '../lib/stealth'
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
 * unavailable"), so we strip the automation tell by running real Chrome with the
 * anti-automation launch flags (HARDENED_CHROME_LAUNCH — `navigator.webdriver`
 * becomes false NATURALLY, no faking). But unlike Amex/Scotia we do NOT inject the
 * stealth init script: Tangerine's anti-tamper fingerprinting (iovation/
 * ThreatMetrix) detects the patched `navigator` and renders a BLANK page, so we
 * set `applyStealthScript: false`. Real Chrome + flags renders and passes. The
 * launchd wrapper runs HEADED, which this needs.
 */

const LOGIN_URL = 'https://www.tangerine.ca/app/#/login/login-id?locale=en_CA'
const DOWNLOAD_URL = 'https://www.tangerine.ca/app/#/download-transactions?locale=en_CA'

async function needsLogin(page: Page): Promise<boolean> {
  // Either login step (the "Next" id button or the password field) is only present
  // while we're in the logged-out login flow.
  return (
    (await page.locator('#login-user-id-submit-button').isVisible().catch(() => false)) ||
    (await page.locator('#passwordId-input').isVisible().catch(() => false))
  )
}

async function login(page: Page, creds: Credentials): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})

  // STEP 1 — Login ID. With a remembered device the saved ID is pre-filled (shown
  // as a dropdown), so only type when the editable textbox is present.
  const next = page.locator('#login-user-id-submit-button')
  try {
    await next.waitFor({ state: 'visible', timeout: 15_000 })
  } catch {
    // No login screen appeared → the persistent session is still trusted.
    return
  }
  const loginId = page.locator('#login-user-id-input')
  if (await loginId.isVisible().catch(() => false)) {
    await loginId.fill(creds.username)
  }
  // Keep the device remembered so MFA stays skipped (only flip it if it's off, so
  // we never accidentally toggle it back off).
  const remember = page.locator('#login-user-id-remember-me-toggle-button')
  if ((await remember.getAttribute('aria-checked').catch(() => null)) === 'false') {
    await remember.click().catch(() => {})
  }
  // click() auto-waits for the button to leave its disabled state once the form is valid.
  await next.click()

  // STEP 2 — Password.
  const password = page.locator('#passwordId-input')
  await password.waitFor({ state: 'visible', timeout: 15_000 })
  await password.fill(creds.password)
  await page.locator('#login-pin-submit-button').click()

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
 */
async function exportCsv(page: Page, _range: DateRange): Promise<string> {
  await page.goto(DOWNLOAD_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})

  // Open the "Download format" dropdown and choose CSV.
  const formatSelect = page.locator('mat-select[name="selectDownloadFormat"]')
  await formatSelect.waitFor({ state: 'visible', timeout: 20_000 })
  await formatSelect.click()
  const csvOption = page.getByRole('option', { name: 'Excel, other software (CSV)' })
  await csvOption.waitFor({ state: 'visible', timeout: 10_000 })
  await csvOption.click()

  // Arm the download listener before the click. Download opens a new tab, so the
  // event surfaces on the context rather than this page.
  const downloadPromise = page.context().waitForEvent('download')
  await page.getByRole('button', { name: 'Download', exact: true }).click()
  const download = await downloadPromise

  const stamp = new Date().toISOString().slice(0, 10)
  const dest = join(downloadDir('tangerine'), `tangerine-${stamp}.csv`)
  await download.saveAs(dest)
  return dest
}

export const tangerine: Adapter = {
  importSource: 'tangerine',
  loginUrl: LOGIN_URL,
  // Real Chrome + anti-automation flags defeats the "function unavailable" block;
  // the stealth init script is SKIPPED because Tangerine's anti-tamper
  // fingerprinting blanks the page when navigator is patched (see lib/stealth.ts).
  launchOptions: HARDENED_CHROME_LAUNCH,
  applyStealthScript: false,
  needsLogin,
  login,
  isMfaChallenge,
  exportCsv,
}
