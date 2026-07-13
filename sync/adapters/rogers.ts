import type { Page } from 'playwright'
import { join } from 'path'
import { downloadDir } from '../lib/profile'
import type { Adapter, Credentials, DateRange } from './types'

/**
 * Rogers Bank credit-card adapter.
 *
 * Format: Rogers' CSV export ingests as the existing `master` source — confirmed
 * during the spike (header carries `Reference Number` + `Merchant Category
 * Description`; see AUTO_SYNC_PLAN.md §1 and BUSINESS_RULES.md). No new parser.
 *
 * Login is a single step (username + password) on an Angular SPA whose form
 * lives in an open shadow root — Playwright's locators pierce it automatically.
 * The "Sign in" button is `disabled` until the reactive form validates, so we
 * just fill both fields and let `click()` auto-wait for it to enable.
 *
 * Device MFA ("approve on phone") only appears when the trusted session has
 * expired. Daily runs reuse the persistent profile and skip it; when it does
 * appear the runner pauses for the user (see AUTO_SYNC_PLAN.md §3).
 */

const LOGIN_URL = 'https://selfserve.rogersbank.com/sign-in?locale=en'
const TRANSACTIONS_URL = 'https://selfserve.rogersbank.com/transactions'

async function needsLogin(page: Page): Promise<boolean> {
  // The username field is only present on the logged-out sign-in screen.
  return page
    .locator('#Username')
    .isVisible()
    .catch(() => false)
}

async function login(page: Page, creds: Credentials): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' })

  const username = page.locator('#Username')
  try {
    await username.waitFor({ state: 'visible', timeout: 10_000 })
  } catch {
    // No login form appeared → the persistent session is still trusted.
    return
  }

  await username.fill(creds.username)
  await page.locator('#Password').fill(creds.password)
  // click() auto-waits for the submit button to leave its `disabled` state once
  // the Angular form is valid.
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Submitting has one of three outcomes, and we only need to tell them apart —
  // not drive them:
  //   1. We leave /sign-in                  → logged in (trusted device).
  //   2. The credential form is replaced by the MFA flow (Rogers keeps this on
  //      /sign-in: first a modal asking how to send the code, then the code entry)
  //      → return, and let the runner wait on isMfaChallenge while the user works
  //      through it by hand.
  //   3. The credential form is still up    → rejected (wrong stored password, or
  //      reCAPTCHA scored the automated/headless session too low).
  // We deliberately don't wait for the URL alone: MFA never changes it, so that
  // wait would time out and kill the run mid-challenge.
  const submitted = await Promise.race([
    page
      .waitForURL((url) => !url.pathname.includes('/sign-in'), { timeout: 30_000 })
      .then(() => true),
    page
      .locator('#Username')
      .waitFor({ state: 'hidden', timeout: 30_000 })
      .then(() => true),
  ]).catch(() => false)

  if (!submitted) {
    throw new Error(
      'Login did not complete — the /sign-in credential form is still up after submitting. ' +
        'Likely cause: the stored Keychain password is wrong, or Rogers’ reCAPTCHA rejected ' +
        'the automated login (more likely in headless). See the failure screenshot in the logs dir.'
    )
  }
  await page.waitForLoadState('networkidle').catch(() => {})
}

/**
 * True while the post-password MFA flow is on screen. Rogers runs the whole flow
 * (send-method modal → code entry) under /sign-in without changing the URL, so
 * "past the credential form but still on /sign-in" IS the challenge — and it stays
 * true across every step, which is what keeps the runner waiting instead of
 * closing the browser out from under the user mid-code.
 */
async function isMfaChallenge(page: Page): Promise<boolean> {
  if (await needsLogin(page)) return false // credential form → not MFA, just expired
  return page.url().includes('/sign-in')
}

/**
 * Rogers' export UI is statement-period based (a `#month-select` dropdown), not
 * an arbitrary date range, so `_range` is unused: we always pull
 * "Current transactions" (the active, unbilled cycle) — that's the rolling
 * window the daily sync needs. Re-importing is free (dedup on Reference Number),
 * so there's no harm re-downloading the same cycle every day.
 *
 * Boundary caveat: on the day a statement closes, the last days of the old cycle
 * move from "Current transactions" into a dated statement option. If a gap ever
 * shows up, the cheap fix is to ALSO download the most recent dated option each
 * run — dedup makes the overlap a no-op. Not built until it's a real problem.
 */
async function exportCsv(page: Page, _range: DateRange): Promise<string> {
  await page.goto(TRANSACTIONS_URL, { waitUntil: 'domcontentloaded' })

  // The `aria-label="Download transactions"` sits on an inner <p> that is only the
  // LABEL: the click handler lives on its parent <div>, and the <p> itself carries
  // `hidden md:block` (invisible on narrow viewports). So anchor on the stable
  // aria-label but click the parent — clicking the label alone doesn't open the
  // dialog. Class names are Tailwind soup Rogers reshuffles freely; never match those.
  const openDialog = page.locator('[aria-label="Download transactions"]').locator('xpath=..')
  await openDialog.waitFor({ state: 'visible', timeout: 15_000 })
  await openDialog.click()

  const monthSelect = page.locator('#month-select')
  await monthSelect.waitFor({ state: 'visible', timeout: 10_000 })
  await monthSelect.selectOption('current_transactions')

  // Arm the download listener before the click that triggers it.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download', exact: true }).click(),
  ])

  const stamp = new Date().toISOString().slice(0, 10)
  const dest = join(downloadDir('rogers'), `rogers-current-${stamp}.csv`)
  await download.saveAs(dest)
  return dest
}

/**
 * Read the card's "Current balance" from the account page. Anchored on the
 * STABLE `aria-label="Current balance"` span — never the Tailwind utility
 * classes, which Rogers tweaks freely. The dollar figure lives in a sibling
 * subtree, so we walk up the label's ancestors until one's visible text
 * contains a $ amount (small markup reshuffles keep working as long as the
 * label and the amount stay in the same card). Tried on the post-login landing
 * page first, then on /transactions (both render the account-summary header).
 * Soft-fails to null so it never aborts the transaction sync.
 */
async function captureAccountBalance(page: Page): Promise<number | null> {
  const readHere = async (timeout: number): Promise<number | null> => {
    const label = page.locator('[aria-label="Current balance"]').first()
    try {
      await label.waitFor({ state: 'attached', timeout })
    } catch {
      return null
    }
    for (let depth = 1; depth <= 5; depth++) {
      const text = await label
        .locator(`xpath=ancestor::*[${depth}]`)
        .innerText()
        .catch(() => '')
      const m = text.replace(/ /g, ' ').match(/\$\s?([\d,]+\.\d{2})/)
      if (m) return Number(m[1].replace(/,/g, ''))
      // Stop climbing once the ancestor also contains other balance labels —
      // any $ found beyond this point could be the credit limit instead.
      if (/available credit|credit limit/i.test(text)) return null
    }
    return null
  }

  const here = await readHere(10_000)
  if (here !== null) return here
  if (!page.url().includes('/transactions')) {
    await page.goto(TRANSACTIONS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
    return readHere(15_000)
  }
  return null
}

export const rogers: Adapter = {
  importSource: 'master',
  loginUrl: LOGIN_URL,
  needsLogin,
  login,
  isMfaChallenge,
  exportCsv,
  captureAccountBalance,
}
