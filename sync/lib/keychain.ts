import { execFileSync } from 'child_process'

/**
 * Read a secret from the macOS login Keychain via the `security` CLI.
 *
 * Nothing is ever written to disk or shell history: the value is returned
 * directly to the caller, which should use it immediately and not hold it
 * longer than the login call. See AUTO_SYNC_PLAN.md §5 — Keychain is the only
 * acceptable credential store given the repo is public.
 *
 * Store secrets once, interactively (the `-w` with no value prompts so the
 * password never lands in shell history):
 *
 *   security add-generic-password -a "rogers" -s "budget-sync-rogers"      -w   # password
 *   security add-generic-password -a "rogers" -s "budget-sync-rogers-user" -w   # login id
 */
export function readSecret(service: string, account: string): string {
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-a', account, '-s', service, '-w'],
      { encoding: 'utf8' }
    )
    return out.replace(/\n$/, '')
  } catch {
    throw new Error(
      `Keychain item not found: service="${service}" account="${account}".\n` +
        `Add it once with:\n  security add-generic-password -a "${account}" -s "${service}" -w`
    )
  }
}

/** Credentials for one sync source. */
export function readCredentials(source: string): { username: string; password: string } {
  return {
    username: readSecret(`budget-sync-${source}-user`, source),
    password: readSecret(`budget-sync-${source}`, source),
  }
}
