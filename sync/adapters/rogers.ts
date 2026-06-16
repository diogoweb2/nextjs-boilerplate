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

  // Land on either the dashboard or the device-MFA screen; the runner decides.
  await page.waitForLoadState('networkidle').catch(() => {})
}

async function isMfaChallenge(page: Page): Promise<boolean> {
  // TODO(pass 2): tighten with the real MFA-screen selector/URL once observed.
  // Heuristic for now: a verification/approval prompt is visible and we're no
  // longer on the username screen.
  if (await needsLogin(page)) return false
  const body = await page.locator('body').innerText().catch(() => '')
  return /verif|authenticat|approve|one[- ]time|security code|we sent/i.test(body)
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

  const openDialog = page.locator('[aria-label="Download transactions"]')
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

export const rogers: Adapter = {
  importSource: 'master',
  loginUrl: LOGIN_URL,
  needsLogin,
  login,
  isMfaChallenge,
  exportCsv,
}
