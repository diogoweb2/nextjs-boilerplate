import type { BrowserContext } from 'playwright'
import type { LaunchHardening } from '../adapters/types'

/**
 * Anti-bot-detection helpers for sites that silently reject automated browsers
 * (e.g. Amex's Akamai/Shape, which spins the login button then resets the form).
 *
 * We deliberately use Playwright's BUNDLED Chromium — not the user's installed
 * `channel: 'chrome'`. Bundled Chromium runs fully isolated, so it never hands
 * off to / fights with an already-open Chrome window. That matters most for the
 * unattended daily run, where the user's normal Chrome is likely open.
 *
 * Detection is defeated two ways:
 *  - launch flags that stop Chromium advertising itself as automated, and
 *  - an init script (runs before any page script) that masks the leftover
 *    `navigator.webdriver` / plugins / chrome-runtime tells.
 */
export const HARDENED_LAUNCH: LaunchHardening = {
  args: ['--disable-blink-features=AutomationControlled'],
  // Strip the flag Playwright adds that sets navigator.webdriver = true.
  ignoreDefaultArgs: ['--enable-automation'],
}

/**
 * Like HARDENED_LAUNCH but on real Google Chrome (`channel`) instead of bundled
 * Chromium. Some sites only render / pass their bot checks on a genuine Chrome
 * build — e.g. Tangerine's Angular app renders a blank page in bundled Chromium
 * but works in real Chrome. The tradeoff vs. bundled Chromium is that an
 * unattended run can collide with an already-open Chrome window; the isolated
 * per-source `user-data-dir` keeps it a SEPARATE instance, which avoids that.
 */
export const HARDENED_CHROME_LAUNCH: LaunchHardening = {
  channel: 'chrome',
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
}

/** Runs in every page before its own scripts; erases common automation tells. */
const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  window.chrome = window.chrome || { runtime: {} };
  const __q = navigator.permissions && navigator.permissions.query;
  if (__q) {
    navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : __q(p);
  }
`

/** Install the stealth init script into a context (no-op-safe to call always). */
export async function applyStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript(STEALTH_INIT)
}
