import { execFileSync } from 'child_process'

/**
 * Fire a macOS notification (best-effort). When the runner is launched by a
 * LaunchAgent it runs in the user's GUI session, so notifications appear and a
 * headed browser can pop up for MFA. Never throws — alerting must not break a run.
 */
export function notify(title: string, message: string): void {
  try {
    const esc = (s: string) => s.replace(/["\\]/g, '\\$&')
    execFileSync('osascript', [
      '-e',
      `display notification "${esc(message)}" with title "${esc(title)}"`,
    ])
  } catch {
    // no GUI / osascript unavailable — the log still records everything
  }
}
