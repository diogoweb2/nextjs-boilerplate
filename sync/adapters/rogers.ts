import type { Page } from 'playwright'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { downloadDir } from '../lib/profile'
import { HARDENED_LAUNCH } from '../lib/stealth'
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
 *
 * Bot detection: a plain automated browser (`navigator.webdriver = true`) gets the
 * credentials rejected with "This feature is not currently available. Please try
 * again or call the number on the back of your card" — while the same login works
 * by hand. Same fix as Tangerine: HARDENED_LAUNCH strips the automation flag so
 * `navigator.webdriver` is false NATURALLY, and we skip the stealth init script
 * (its faked `navigator.plugins` is itself a fingerprint tell for reCAPTCHA).
 */

const LOGIN_URL = 'https://selfserve.rogersbank.com/sign-in?locale=en'
const TRANSACTIONS_URL = 'https://selfserve.rogersbank.com/transactions'

async function needsLogin(page: Page): Promise<boolean> {
  // The username field is only present on the logged-out sign-in screen — but it
  // can still be on screen UNDER the MFA modal, so MFA wins the tie-break.
  if (await mfaVisible(page)) return false
  return page
    .locator('#Username')
    .isVisible()
    .catch(() => false)
}

/**
 * Heuristic detector for Rogers' post-password MFA UI. Rogers runs the whole flow
 * (send-method modal → code entry) inside /sign-in without changing the URL, and
 * sometimes leaves the credential form mounted behind it — so neither the URL nor
 * `#Username` can tell us on their own.
 *
 * Matched on user-visible copy plus the standard one-time-code input, because the
 * markup is Tailwind soup with no stable ids of its own. Deliberately broad: a
 * false positive costs a wait the user can just click through, while a false
 * negative kills the run mid-challenge.
 */
async function mfaVisible(page: Page): Promise<boolean> {
  const otp = page.locator(
    'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="otp" i]'
  )
  if (await otp.first().isVisible().catch(() => false)) return true
  const copy = page.getByText(
    /verification code|security code|authentication code|verify it'?s you|send.*(code|passcode)|approve.*(phone|device)|two[- ]step/i
  )
  return copy.first().isVisible().catch(() => false)
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
  // 60s, not 30: Rogers' sign-in POST plus the reCAPTCHA round-trip is slow enough
  // that 30s occasionally expired while the request was still in flight.
  const submitted = await Promise.race([
    page
      .waitForURL((url) => !url.pathname.includes('/sign-in'), { timeout: 60_000 })
      .then(() => true),
    page
      .locator('#Username')
      .waitFor({ state: 'hidden', timeout: 60_000 })
      .then(() => true),
    // The MFA modal can render OVER a still-mounted credential form, so neither of
    // the two waits above ever fires. Poll for it, and return as soon as it shows:
    // the runner then owns the wait (20 min, visible browser) instead of us timing
    // out and failing the run while the user is reaching for their phone.
    (async () => {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        if (await mfaVisible(page)) return true
        await page.waitForTimeout(500)
      }
      return false
    })(),
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
  if (await mfaVisible(page)) return true // explicit MFA UI, even over the login form
  if (await needsLogin(page)) return false // credential form → not MFA, just expired
  return page.url().includes('/sign-in')
}

/**
 * Rogers' "Download transactions" dialog is unusable for automation: its CSV
 * endpoint (`…/activity?format=CSV`) is gated by a reCAPTCHA token, and it
 * scores the automated browser as a bot → 401 `RECAPTCHA_ERROR`, so no file ever
 * arrives. The transactions TABLE, though, is fed by `…/transactions?offset=N`
 * (the newest N×50 activities), which carries no reCAPTCHA. So we let the page
 * make that call once, borrow its auth headers, fetch a wider window ourselves,
 * and write a CSV in the exact shape of Rogers' own export — the existing
 * `master` parser ingests it unchanged.
 *
 * Fidelity (checked field-by-field against past exports): the export holds only
 * posted `TRANS`/`APPROVED` rows, its Reference Numbers are the API's
 * `referenceNumber` verbatim (payments included) so dedup lines up with earlier
 * imports, and it strips every comma from text ("PAYMENT, THANK YOU" →
 * "PAYMENT THANK YOU") — which we mirror so merchant/category rules keep matching.
 * "Name on Card" is left blank: the parser never reads it, and the repo's privacy
 * rule says not to keep cardholder names.
 *
 * `_range` is unused: offset=3 (~150 rows, about six weeks) comfortably covers
 * the current cycle plus overlap, and re-importing dedups to zero.
 */
const PAGES = 3

type RogersActivity = {
  date: string
  postedDate?: string
  referenceNumber?: string
  activityType: string
  activityStatus: string
  cardNumber?: string
  amount: { value: string }
  merchant?: {
    name?: string
    categoryDescription?: string
    address?: { city?: string; stateProvince?: string; countryCode?: string; postalCode?: string }
  }
}

const CSV_HEADER = [
  'Date', 'Posted Date', 'Reference Number', 'Activity Type', 'Activity Status', 'Card Number',
  'Merchant Category Description', 'Merchant Name', 'Merchant City', 'Merchant State or Province',
  'Merchant Country Code', 'Merchant Postal Code', 'Amount', 'Rewards', 'Name on Card',
]

/** Rogers' export drops commas (and we drop quotes) so fields never need escaping. */
const clean = (s: string | undefined) => (s ?? '').replace(/[,"\r\n]/g, '').trim()

function toCsvRow(a: RogersActivity): string {
  const n = Number(a.amount.value)
  const amount = `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
  const addr = a.merchant?.address
  return [
    a.date,
    a.postedDate ?? '',
    `"${clean(a.referenceNumber)}"`,
    a.activityType,
    a.activityStatus,
    clean(a.cardNumber),
    clean(a.merchant?.categoryDescription),
    clean(a.merchant?.name),
    clean(addr?.city),
    clean(addr?.stateProvince),
    clean(addr?.countryCode),
    clean(addr?.postalCode),
    amount,
    '',
    '',
  ].join(',')
}

async function exportCsv(page: Page, _range: DateRange): Promise<string> {
  // The table's first load is our source of auth: arm the wait before navigating.
  const tableRequest = page.waitForRequest(
    (r) => /\/corebank\/v1\/account\/[^/]+\/customer\/[^/]+\/transactions\?offset=/.test(r.url()),
    { timeout: 30_000 }
  )
  await page.goto(TRANSACTIONS_URL, { waitUntil: 'domcontentloaded' })
  const req = await tableRequest.catch(() => {
    throw new Error('The /transactions page never requested its transactions API — Rogers changed the page.')
  })
  const headers = await req.allHeaders()
  const endpoint = req.url().split('?')[0]

  const res = await page.context().request.get(`${endpoint}?offset=${PAGES}`, { headers })
  const body = await res.json().catch(() => null)
  const activities: RogersActivity[] | undefined = body?.activitySummary?.activities
  if (!res.ok() || !Array.isArray(activities)) {
    throw new Error(`Rogers transactions API returned ${res.status()}: ${JSON.stringify(body).slice(0, 200)}`)
  }

  const posted = activities.filter(
    (a) => a.activityType === 'TRANS' && a.activityStatus === 'APPROVED' && a.referenceNumber
  )
  const csv = [CSV_HEADER.join(','), ...posted.map(toCsvRow)].join('\n') + '\n'

  const stamp = new Date().toISOString().slice(0, 10)
  const dest = join(downloadDir('rogers'), `rogers-current-dl${stamp}.csv`)
  writeFileSync(dest, csv)
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
  launchOptions: HARDENED_LAUNCH,
  applyStealthScript: false,
  needsLogin,
  login,
  isMfaChallenge,
  exportCsv,
  captureAccountBalance,
}
