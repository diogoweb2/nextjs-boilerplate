/**
 * Rogers daily sync runner (AUTO_SYNC_PLAN.md §10, phases 1–2 + scheduling).
 *
 * Reads credentials from Keychain → opens the trusted persistent profile → logs
 * in (reusing device trust to skip MFA) → exports the current transactions CSV →
 * POSTs it to the app's ingest endpoint (dedup makes re-runs safe).
 *
 *   npx tsx sync/run-rogers.ts             # headed (watch it work)
 *   npx tsx sync/run-rogers.ts --headless  # headless (launchd uses this)
 *
 * MFA handling: device trust normally persists, so MFA never appears. If it
 * does while running headless, the runner reopens a VISIBLE browser, notifies
 * you, and waits until you approve on your phone — then continues automatically.
 *
 * Requires Keychain items (one-time):
 *   security add-generic-password -a "rogers" -s "budget-sync-rogers"      -w
 *   security add-generic-password -a "rogers" -s "budget-sync-rogers-user" -w
 *   security add-generic-password -a "ingest" -s "budget-sync-ingest"      -w
 * And (for a deployed app) INGEST_URL=https://your-app/api/ingest.
 */
import { chromium, type BrowserContext, type Page } from 'playwright'
import { readCredentials } from './lib/keychain'
import { profileDir } from './lib/profile'
import { postCsv } from './lib/ingest'
import { notify } from './lib/notify'
import { rogers } from './adapters/rogers'

const startHeadless = process.argv.includes('--headless')
const MFA_WAIT_MS = 20 * 60 * 1000 // how long to wait for the user to approve

async function open(headless: boolean): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(profileDir('rogers'), {
    headless,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  })
  const page = context.pages()[0] ?? (await context.newPage())
  return { context, page }
}

/** Poll until the MFA screen clears (user approved on phone) or we time out. */
async function waitForMfaApproval(page: Page): Promise<void> {
  const deadline = Date.now() + MFA_WAIT_MS
  while (await rogers.isMfaChallenge(page)) {
    if (Date.now() > deadline) {
      throw new Error('MFA was not approved within the wait window.')
    }
    await page.waitForTimeout(3000)
  }
}

async function main(): Promise<void> {
  const creds = readCredentials('rogers') // throws with a setup hint if missing

  let { context, page } = await open(startHeadless)
  try {
    console.log('→ logging in (reusing trusted device session if present)…')
    await rogers.login(page, creds)

    if (await rogers.isMfaChallenge(page)) {
      // Escalate to a visible browser so the user can approve the device prompt.
      console.log('→ MFA required — reopening a visible browser for approval…')
      notify('Budget sync — Rogers', 'Device approval needed. Approve on your phone.')
      if (startHeadless) {
        await context.close()
        ;({ context, page } = await open(false))
        await rogers.login(page, creds)
      }
      await page.bringToFront()
      await waitForMfaApproval(page)
      console.log('→ MFA approved, continuing…')
    }

    console.log('→ exporting current transactions…')
    const file = await rogers.exportCsv(page, {
      from: new Date(Date.now() - 30 * 864e5),
      to: new Date(),
    })
    console.log(`✓ downloaded: ${file}`)

    console.log('→ posting to ingest endpoint…')
    const result = await postCsv(file, rogers.importSource)
    if (!result.ok) {
      throw new Error(`ingest rejected: ${result.error}`)
    }
    const summary = `${result.inserted} inserted, ${result.skipped} skipped (${result.period})`
    console.log(`✓ ingested "${result.source}": ${summary}`)
    notify('Budget sync — Rogers ✓', summary)
  } catch (err) {
    notify('Budget sync — Rogers FAILED', err instanceof Error ? err.message : String(err))
    throw err
  } finally {
    await context.close()
  }
  console.log('\nDone.')
  process.exit(0)
}

main().catch((err) => {
  console.error('\n✗ run failed:', err.message)
  process.exit(1)
})
