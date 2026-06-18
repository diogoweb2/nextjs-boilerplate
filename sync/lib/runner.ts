/**
 * Generic daily-sync orchestrator shared by every source's runner
 * (AUTO_SYNC_PLAN.md §10). It owns the browser/profile/Keychain/ingest plumbing;
 * the per-source `Adapter` only knows how to drive one site.
 *
 * Flow: read credentials from Keychain → open the trusted persistent profile →
 * log in (reusing device trust to skip MFA) → export the current transactions
 * CSV → POST it to the app's ingest endpoint (dedup makes re-runs safe).
 *
 * MFA handling: device trust normally persists, so MFA never appears. If it does
 * while running headless, the runner reopens a VISIBLE browser, notifies you, and
 * waits until you approve on your phone — then continues automatically.
 */
import { chromium, type BrowserContext, type Page } from 'playwright'
import { join } from 'path'
import { readCredentials } from './keychain'
import { profileDir, logsDir } from './profile'
import { postCsv } from './ingest'
import { notify } from './notify'
import { applyStealth } from './stealth'
import type { Adapter } from '../adapters/types'

const MFA_WAIT_MS = 20 * 60 * 1000 // how long to wait for the user to approve

async function open(
  adapter: Adapter,
  source: string,
  headless: boolean
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(profileDir(source), {
    headless,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    ...adapter.launchOptions,
  })
  if (adapter.launchOptions && adapter.applyStealthScript !== false) await applyStealth(context)
  const page = context.pages()[0] ?? (await context.newPage())
  return { context, page }
}

/** Poll until the MFA screen clears (user approved on phone) or we time out. */
async function waitForMfaApproval(adapter: Adapter, page: Page): Promise<void> {
  const deadline = Date.now() + MFA_WAIT_MS
  while (await adapter.isMfaChallenge(page)) {
    if (Date.now() > deadline) {
      throw new Error('MFA was not approved within the wait window.')
    }
    await page.waitForTimeout(3000)
  }
}

/**
 * Run one source's daily sync end-to-end.
 *
 * @param source  Keychain/profile key (e.g. 'rogers', 'amex').
 * @param label   Human label used in notifications/logs (e.g. 'Rogers').
 * @param adapter The site-specific driver.
 * @param startHeadless Whether to launch headless (the launchd wrappers decide).
 */
export async function runSync(
  source: string,
  label: string,
  adapter: Adapter,
  startHeadless: boolean
): Promise<void> {
  const creds = readCredentials(source) // throws with a setup hint if missing

  let { context, page } = await open(adapter, source, startHeadless)
  try {
    console.log('→ logging in (reusing trusted device session if present)…')
    await adapter.login(page, creds)

    if (await adapter.isMfaChallenge(page)) {
      // Escalate to a visible browser so the user can approve the device prompt.
      console.log('→ MFA required — reopening a visible browser for approval…')
      notify(`Budget sync — ${label}`, 'Device approval needed. Approve on your phone.')
      if (startHeadless) {
        await context.close()
        ;({ context, page } = await open(adapter, source, false))
        await adapter.login(page, creds)
      }
      await page.bringToFront()
      await waitForMfaApproval(adapter, page)
      console.log('→ MFA approved, continuing…')
    }

    console.log('→ exporting current transactions…')
    const file = await adapter.exportCsv(page, {
      from: new Date(Date.now() - 30 * 864e5),
      to: new Date(),
    })
    console.log(`✓ downloaded: ${file}`)

    console.log('→ posting to ingest endpoint…')
    const result = await postCsv(file, adapter.importSource)
    if (!result.ok) {
      throw new Error(`ingest rejected: ${result.error}`)
    }
    const summary = `${result.inserted} inserted, ${result.skipped} skipped (${result.period})`
    console.log(`✓ ingested "${result.source}": ${summary}`)
    notify(`Budget sync — ${label} ✓`, summary)
  } catch (err) {
    // Capture state for debugging (esp. headless failures that can't be watched).
    try {
      const shot = join(logsDir(), `${source}-error-${Date.now()}.png`)
      console.error(`  page url: ${page.url()}`)
      console.error(`  page title: ${await page.title().catch(() => '?')}`)
      await page.screenshot({ path: shot, fullPage: true })
      console.error(`  screenshot: ${shot}`)
    } catch {}
    notify(`Budget sync — ${label} FAILED`, err instanceof Error ? err.message : String(err))
    throw err
  } finally {
    await context.close()
  }
  console.log('\nDone.')
  process.exit(0)
}
