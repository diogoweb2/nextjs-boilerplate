import type { Download, Page } from 'playwright'
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
 * an arbitrary date range, so `_range` is unused. We pull the NEWEST dated
 * statement option (values like "2026-07-11", newest first) — NOT the
 * "Current transactions" option, which is broken on Rogers' side: selecting it
 * enables Download, the modal closes, and no file is ever produced (confirmed by
 * hand, Jul 2026). Re-importing is free (dedup on Reference Number), so
 * re-downloading the same statement every day is harmless.
 *
 * Boundary caveat: the newest statement lags the unbilled cycle, so transactions
 * after the last statement date only land once the next statement is cut — the
 * sync trails by up to a cycle. If Rogers ever fixes "Current transactions",
 * switch back for same-day data.
 */
async function exportCsv(page: Page, _range: DateRange): Promise<string> {
  await page.goto(TRANSACTIONS_URL, { waitUntil: 'domcontentloaded' })

  // The `aria-label="Download transactions"` sits on an inner <p> that is only the
  // LABEL: the click handler lives on its parent <div>. So anchor on the stable
  // aria-label but click the parent. Class names are Tailwind soup Rogers reshuffles
  // freely; never match those.
  const openDialog = page.locator('[aria-label="Download transactions"]').locator('xpath=..')
  await openDialog.waitFor({ state: 'visible', timeout: 15_000 })

  const monthSelect = page.locator('#month-select')

  // Open the dialog by DISPATCHING the pointer/mouse sequence onto the element,
  // rather than with Playwright's real-mouse `.click()`.
  //
  // Playwright's click moves a virtual mouse to the element's center and clicks
  // there; on this page that lands but never opens the dialog. Dispatching the
  // events directly onto the node — verified by hand in DevTools — does open it.
  // The trigger is a plain <div> (no `disabled`, no button role), so Playwright's
  // actionability checks pass regardless and give us no signal either way.
  //
  // Retried because React renders the <div> before hydration wires its handler, so
  // an early dispatch is silently swallowed. Success is defined as "the dialog is
  // actually on screen", not "the click returned" — the previous version's failure
  // showed up much later, on a dialog that had never opened. Re-clicking is safe:
  // the trigger opens the dialog, it doesn't toggle it.
  for (let attempt = 1; ; attempt++) {
    await openDialog.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const init: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
        button: 0,
      }
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, init))
      }
    })
    try {
      await monthSelect.waitFor({ state: 'visible', timeout: 2_000 })
      break
    } catch {
      if (attempt >= 10) {
        throw new Error(
          'The download dialog never opened after 10 clicks on "Download transactions".'
        )
      }
      await page.waitForTimeout(1_000)
    }
  }

  // Pick the newest dated statement. The options are ordered newest-first, after
  // the "-Select-" placeholder ("") and the broken "current_transactions" entry,
  // and their values are the statement close date (e.g. "2026-07-11") — so the
  // first date-shaped value is the most recent month.
  const newest = await monthSelect.evaluate((el) => {
    const select = el as HTMLSelectElement
    return (
      Array.from(select.options)
        .map((o) => o.value)
        .find((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)) ?? null
    )
  })
  if (!newest) {
    throw new Error('No dated statement option found in the #month-select dropdown.')
  }
  await monthSelect.selectOption(newest)

  // Arm the download listener BEFORE the click that triggers it, and listen on the
  // whole context rather than just this page: Rogers hands the CSV off through a
  // brand-new tab, and Playwright fires `download` on the page that actually
  // receives it — so a plain `page.waitForEvent('download')` waits forever on the
  // wrong page while the click itself worked fine. The export is also generated
  // server-side, so give it well over the 30s default.
  const downloadPromise = new Promise<Download>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('No download started within 90s of clicking Download.')),
      90_000
    )
    const settle = (d: Download) => {
      clearTimeout(timer)
      resolve(d)
    }
    page.once('download', settle)
    page.context().on('page', (popup) => popup.once('download', settle))
  })

  await page.getByRole('button', { name: 'Download', exact: true }).click()
  const download = await downloadPromise

  const stamp = new Date().toISOString().slice(0, 10)
  const dest = join(downloadDir('rogers'), `rogers-${newest}-dl${stamp}.csv`)
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
