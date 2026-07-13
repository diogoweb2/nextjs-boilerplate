import type { Page } from 'playwright'

/** Rolling date window to request from the source each run. */
export type DateRange = { from: Date; to: Date }

export type Credentials = { username: string; password: string }

/**
 * Per-source adapter. Keeps bank-specific brittleness isolated behind a stable
 * interface (AUTO_SYNC_PLAN.md §6). The runner owns the browser/profile/Keychain;
 * the adapter only knows how to drive one site.
 */
/**
 * Extra Playwright launch options, merged into the persistent-context launch.
 * Used to harden against bot detection on stricter sites (e.g. Amex): run real
 * Google Chrome instead of the bundled Chromium and strip the automation flags
 * that set `navigator.webdriver`.
 */
export type LaunchHardening = {
  channel?: string
  args?: string[]
  ignoreDefaultArgs?: string[]
}

export type Adapter = {
  /** App `ImportSource` this source ingests as (Rogers → 'master'). */
  readonly importSource: string
  readonly loginUrl: string
  /** Optional per-site launch hardening (real Chrome / anti-automation flags). */
  readonly launchOptions?: LaunchHardening
  /**
   * Whether to inject the stealth init script (which patches navigator.webdriver/
   * plugins/languages) when `launchOptions` are set. Defaults to true. Sites with
   * anti-tamper fingerprinting (e.g. Tangerine's iovation/ThreatMetrix) detect the
   * patched `navigator` and refuse to render, so they opt OUT and rely on real
   * Chrome + the anti-automation launch flags alone.
   */
  readonly applyStealthScript?: boolean
  /** True when the username field is showing → session expired, must log in. */
  needsLogin(page: Page): Promise<boolean>
  /** Fill + submit the login form. No-op if already authenticated. */
  login(page: Page, creds: Credentials): Promise<void>
  /** True when the site is on a device/MFA verification screen. */
  isMfaChallenge(page: Page): Promise<boolean>
  /** Navigate to the export UI, request `range`, capture the CSV → file path. */
  exportCsv(page: Page, range: DateRange): Promise<string>
  /**
   * Optional: read the source's own current balance (a card's "Current balance"
   * / a chequing account's balance) from the post-login page, run right after
   * login/MFA and BEFORE `exportCsv` navigates away. Returns null when not found
   * (soft-fail — a missing balance must never abort the transaction sync; the
   * dashboard warns when it lags behind a successful run). The runner posts a
   * non-null result to /api/ingest-balance tagged with `importSource`.
   */
  captureAccountBalance?(page: Page): Promise<number | null>
  /**
   * Optional: read an account balance shown on the post-login landing page
   * (e.g. Scotia's mortgage balance on my-accounts) BEFORE `exportCsv` navigates
   * away. Returns null when the balance isn't present (soft-fail — a missing
   * balance must never abort the transaction sync). The runner posts a non-null
   * result to /api/ingest-mortgage.
   */
  captureMortgageBalance?(page: Page): Promise<number | null>
  /**
   * Optional: read the mortgage's interest rate (as a FRACTION, e.g. 0.0355),
   * typically throttled to once a month by the adapter (returns null when not due
   * or not found). Runs AFTER `exportCsv` since it navigates into the mortgage
   * account page. The runner posts a non-null result to /api/ingest-mortgage.
   */
  captureMortgageRate?(page: Page): Promise<number | null>
}
