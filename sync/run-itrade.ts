/**
 * Monthly iTrade HOLDINGS sync (BUSINESS_RULES §16). Distinct from the daily
 * transaction syncs: it logs into Scotia (reusing the Scotia adapter's login +
 * device trust and the SAME Keychain credentials), then for each configured
 * registered account opens its iTrade overview page, clicks "Download CSV", and
 * POSTs the portfolio export to /api/ingest-holdings — which snapshots the
 * holdings into that account (FX → CAD). Runs once a month via launchd.
 *
 *   npx tsx sync/run-itrade.ts             # headed (watch it work)
 *   npx tsx sync/run-itrade.ts --headless  # headless (bank bot-detection may block)
 *
 * Reuses the Scotia Keychain items (no new secrets):
 *   security add-generic-password -a "scotia" -s "budget-sync-scotia"      -w
 *   security add-generic-password -a "scotia" -s "budget-sync-scotia-user" -w
 *   security add-generic-password -a "ingest" -s "budget-sync-ingest"      -w
 *
 * The account list (URLs are account-identifying, so NOT committed) lives in
 * sync/itrade.accounts.json — see sync/itrade.accounts.example.json.
 *
 * Failure handling mirrors the other syncs at the runner level: a macOS
 * notification, a failure screenshot, and a non-zero exit so the launchd wrapper
 * retries. It is NOT wired into the dashboard's daily-staleness banner (that
 * 3-day threshold would false-alarm a monthly job).
 */
import { chromium, type Page } from 'playwright'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join } from 'path'
import { readCredentials } from './lib/keychain'
import { profileDir, downloadDir, logsDir } from './lib/profile'
import { postHoldingsCsv } from './lib/ingest'
import { notify } from './lib/notify'
import { applyStealth } from './lib/stealth'
import { scotia } from './adapters/scotia'

const SOURCE = 'itrade'
const LABEL = 'iTrade'
const MFA_WAIT_MS = 20 * 60 * 1000

type ItradeAccount = { label: string; account: string; url: string }

function loadAccounts(): ItradeAccount[] {
  const path = fileURLToPath(new URL('./itrade.accounts.json', import.meta.url))
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(
      `Missing ${path}. Copy sync/itrade.accounts.example.json to sync/itrade.accounts.json ` +
        'and fill in each account\'s iTrade overview URL + brokerage number.',
    )
  }
  const parsed = JSON.parse(raw) as ItradeAccount[]
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('itrade.accounts.json is empty.')
  for (const a of parsed) {
    if (!a.url || !a.account) throw new Error(`itrade.accounts.json entry missing url/account: ${JSON.stringify(a)}`)
  }
  return parsed
}

/** Click the "Download CSV" button on an iTrade overview page and save the file. */
async function downloadCsv(page: Page, acc: ItradeAccount): Promise<string> {
  await page.goto(acc.url, { waitUntil: 'domcontentloaded' })
  // The export control is a button whose accessible name is "Download CSV"
  // (aria-label), shown as "CSV"; fall back to its stable class, then to text.
  const button = page
    .getByRole('button', { name: 'Download CSV' })
    .or(page.locator('button.DownloadCsv'))
    .or(page.getByRole('button', { name: /^CSV$/ }))
    .first()
  await button.waitFor({ state: 'visible', timeout: 30_000 })

  const [download] = await Promise.all([page.waitForEvent('download'), button.click()])
  const stamp = new Date().toISOString().slice(0, 10)
  const dest = join(downloadDir('itrade'), `itrade-${acc.label}-${stamp}.csv`)
  await download.saveAs(dest)
  return dest
}

async function main() {
  const headless = process.argv.includes('--headless')
  const accounts = loadAccounts()
  const creds = readCredentials('scotia') // same login as the Scotia chequing sync

  const context = await chromium.launchPersistentContext(profileDir('itrade'), {
    headless,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    ...scotia.launchOptions,
  })
  if (scotia.launchOptions && scotia.applyStealthScript !== false) await applyStealth(context)
  const page = context.pages()[0] ?? (await context.newPage())

  try {
    console.log('→ logging in to Scotia (reusing trusted device session if present)…')
    await scotia.login(page, creds)

    if (await scotia.isMfaChallenge(page)) {
      console.log('→ MFA required — approve on your phone…')
      notify(`Budget sync — ${LABEL}`, 'Device approval needed. Approve on your phone.')
      await page.bringToFront()
      const deadline = Date.now() + MFA_WAIT_MS
      while (await scotia.isMfaChallenge(page)) {
        if (Date.now() > deadline) throw new Error('MFA was not approved within the wait window.')
        await page.waitForTimeout(3000)
      }
      console.log('→ MFA approved, continuing…')
    }

    const summaries: string[] = []
    for (const acc of accounts) {
      console.log(`→ ${acc.label}: opening iTrade overview…`)
      const file = await downloadCsv(page, acc)
      console.log(`  ✓ downloaded: ${file}`)
      const result = await postHoldingsCsv(file, acc.account)
      if (!result.ok) throw new Error(`${acc.label} ingest rejected: ${result.error}`)
      const line = `${acc.label}: ${result.positions} positions · $${result.totalValueCad.toLocaleString('en-CA')}`
      console.log(`  ✓ ingested ${line}`)
      summaries.push(line)
    }

    notify(`Budget sync — ${LABEL} ✓`, summaries.join('\n'))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      const shot = join(logsDir(), `${SOURCE}-error-${Date.now()}.png`)
      console.error(`  page url: ${page.url()}`)
      await page.screenshot({ path: shot, fullPage: true })
      console.error(`  screenshot: ${shot}`)
    } catch {}
    notify(`Budget sync — ${LABEL} FAILED`, message)
    await context.close()
    throw err
  }
  await context.close()
  console.log('\nDone.')
  process.exit(0)
}

main().catch((err) => {
  console.error('\n✗ run failed:', err.message)
  process.exit(1)
})
