import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, chmodSync } from 'fs'

/**
 * Per-source data lives under ~/Library/Application Support/budget-sync/.
 * These dirs hold persistent browser profiles (session cookies + device-trust
 * tokens) and are as sensitive as the passwords themselves — chmod 700, and
 * gitignored globally (see AUTO_SYNC_PLAN.md §5).
 */
const BASE = join(homedir(), 'Library', 'Application Support', 'budget-sync')

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true })
  chmodSync(path, 0o700)
  return path
}

/** Persistent browser profile dir for a source (Playwright userDataDir). */
export function profileDir(source: string): string {
  ensureDir(BASE)
  return ensureDir(join(BASE, source))
}

/** Temp dir where downloaded CSVs land before ingest. */
export function downloadDir(source: string): string {
  ensureDir(BASE)
  return ensureDir(join(BASE, '_downloads', source))
}

/** Dir for run logs and failure screenshots (matches the launchd plist path). */
export function logsDir(): string {
  ensureDir(BASE)
  return ensureDir(join(BASE, 'logs'))
}
