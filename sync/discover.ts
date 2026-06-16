/**
 * Discovery harness (AUTO_SYNC_PLAN.md §10, phase 1).
 *
 * Opens a headed browser and gets out of your way. Rogers is an Angular SPA, so
 * page `load` events are useless for selector capture — instead you drive the
 * dump yourself:
 *
 *     ▶︎ press ENTER in this terminal to dump the controls of whatever screen
 *       is currently showing (works on any login/MFA/export step).
 *
 * It also captures any file download to disk and prints its header row.
 *
 * Two modes:
 *   npx tsx sync/discover.ts rogers          # TRUSTED profile (reuses your login)
 *   npx tsx sync/discover.ts rogers --fresh  # THROWAWAY profile (shows the
 *                                            #   logged-OUT login form)
 *
 * Use --fresh once to capture the login-form selectors (don't actually log in
 * there — just dump and close). Use the normal mode while logged in to capture
 * the navigation + export-button selectors.
 */
import { chromium, type Page, type Frame } from 'playwright'
import { readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { profileDir, downloadDir } from './lib/profile'

type SourceConfig = { loginUrl: string }

const SOURCES: Record<string, SourceConfig> = {
  rogers: { loginUrl: 'https://selfserve.rogersbank.com/sign-in?locale=en' },
  tangerine: { loginUrl: 'https://www.tangerine.ca/app/#/login/login-id?locale=en_CA' },
  amex: { loginUrl: 'https://www.americanexpress.com/en-ca/account/login' },
  scotia: { loginUrl: 'https://www.scotiabank.com/' },
}

const source = process.argv[2] ?? 'rogers'
const fresh = process.argv.includes('--fresh')
const config = SOURCES[source]
if (!config) {
  console.error(`Unknown source "${source}". Known: ${Object.keys(SOURCES).join(', ')}`)
  process.exit(1)
}

/** Dump the interactive controls of one frame so we can author selectors. */
async function dumpFrame(frame: Frame, label: string): Promise<void> {
  let controls: Array<Record<string, string | null>> = []
  try {
    controls = await frame.evaluate(() => {
      const attr = (el: Element, n: string) => el.getAttribute(n)
      const sel = 'input, button, select, a[role="button"], [role="button"]'
      // Walk the light DOM AND descend into open shadow roots (Angular/Web
      // Components hide their <input>s there, which querySelectorAll can't reach).
      const found: Element[] = []
      const visit = (root: Document | ShadowRoot) => {
        root.querySelectorAll(sel).forEach((el) => found.push(el))
        root.querySelectorAll('*').forEach((el) => {
          if ((el as HTMLElement).shadowRoot) visit((el as HTMLElement).shadowRoot!)
        })
      }
      visit(document)
      return found
        .filter((el) => (el as HTMLElement).offsetParent !== null || el.tagName === 'INPUT')
        .slice(0, 60)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: attr(el, 'type'),
          id: el.id || null,
          name: attr(el, 'name'),
          formcontrolname: attr(el, 'formcontrolname'),
          placeholder: attr(el, 'placeholder'),
          aria: attr(el, 'aria-label'),
          test: attr(el, 'data-testid') ?? attr(el, 'data-test') ?? attr(el, 'data-qa'),
          text: ((el as HTMLElement).innerText || (el as HTMLInputElement).value || '')
            .trim()
            .slice(0, 35),
        }))
    })
  } catch {
    return // frame navigated away mid-eval; ignore
  }
  if (controls.length === 0) return
  console.log(`\n=== controls @ ${label} ===`)
  console.table(controls)
}

async function dumpPage(page: Page): Promise<void> {
  console.log(`\n################  URL: ${page.url()}`)
  for (const frame of page.frames()) {
    const label = frame === page.mainFrame() ? 'main' : `iframe ${frame.url().slice(0, 60)}`
    await dumpFrame(frame, label)
  }
  console.log('\n(press ENTER to dump again after navigating)')
}

function attachDownloadCapture(page: Page, dir: string): void {
  page.on('download', async (download) => {
    const name = download.suggestedFilename() || `download-${Date.now()}`
    const dest = join(dir, name)
    await download.saveAs(dest)
    console.log(`\n⬇️  DOWNLOAD CAPTURED → ${dest}`)
    console.log(`   source url: ${download.url().slice(0, 120)}`)
    try {
      const head = readFileSync(dest, 'utf8').split('\n').slice(0, 2).join('\n')
      console.log(`   header + first row:\n${head}\n`)
    } catch {
      console.log('   (not a text file — open it manually to inspect)')
    }
  })
}

async function main(): Promise<void> {
  // --fresh uses a throwaway profile so the logged-OUT login form is visible.
  const inspectDir = join(profileDir(source), '..', `${source}-inspect`)
  const userDataDir = fresh ? inspectDir : profileDir(source)
  if (fresh) {
    try {
      rmSync(inspectDir, { recursive: true, force: true })
    } catch {}
  }
  const dlDir = downloadDir(source)
  console.log(`mode: ${fresh ? 'FRESH (throwaway, logged-out)' : 'TRUSTED (reuses your login)'}`)
  console.log(`profile: ${userDataDir}`)
  console.log(`downloads: ${dlDir}`)
  console.log(`opening ${config.loginUrl} …\n`)

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  })

  let current: Page
  const wire = (page: Page) => {
    attachDownloadCapture(page, dlDir)
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) current = page
    })
  }
  context.pages().forEach(wire)
  context.on('page', (p) => {
    wire(p)
    current = p
  })

  current = context.pages()[0] ?? (await context.newPage())
  await current.goto(config.loginUrl, { waitUntil: 'domcontentloaded' })
  // Give the SPA a beat to render its first screen, then dump once.
  await current.waitForTimeout(2500)
  await dumpPage(current)

  console.log(
    '\n👉 Navigate to the screen you want (login / MFA / transactions / export).\n' +
      '   Press ENTER here to print that screen’s selectors. Trigger the CSV\n' +
      '   export to capture the file. Type "q" + ENTER (or close the window) to quit.\n'
  )

  // Drive dumps from stdin — reliable for SPA screens with no load event.
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', async (data: string) => {
    if (data.trim().toLowerCase() === 'q') {
      await context.close()
      return
    }
    try {
      await dumpPage(current)
    } catch (e) {
      console.log('dump failed (page busy navigating?), try again:', (e as Error).message)
    }
  })

  await new Promise<void>((resolve) => context.on('close', () => resolve()))
  console.log('\nBrowser closed. Discovery session ended.')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
