import type { Page } from 'playwright'

/** Rolling date window to request from the source each run. */
export type DateRange = { from: Date; to: Date }

export type Credentials = { username: string; password: string }

/**
 * Per-source adapter. Keeps bank-specific brittleness isolated behind a stable
 * interface (AUTO_SYNC_PLAN.md §6). The runner owns the browser/profile/Keychain;
 * the adapter only knows how to drive one site.
 */
export type Adapter = {
  /** App `ImportSource` this source ingests as (Rogers → 'master'). */
  readonly importSource: string
  readonly loginUrl: string
  /** True when the username field is showing → session expired, must log in. */
  needsLogin(page: Page): Promise<boolean>
  /** Fill + submit the login form. No-op if already authenticated. */
  login(page: Page, creds: Credentials): Promise<void>
  /** True when the site is on a device/MFA verification screen. */
  isMfaChallenge(page: Page): Promise<boolean>
  /** Navigate to the export UI, request `range`, capture the CSV → file path. */
  exportCsv(page: Page, range: DateRange): Promise<string>
}
