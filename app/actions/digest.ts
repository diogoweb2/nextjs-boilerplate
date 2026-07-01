'use server'

import { revalidatePath } from 'next/cache'
import { runDailyDigestJob } from '@/app/lib/digest'

/**
 * Manual re-trigger for the daily digest, called from DigestStatusBanner's
 * Retry button after the automated launchd run failed (see `digest_runs`).
 * Runs the exact same push logic as the token-authed POST /api/digest — this
 * just skips the bearer-token hop since the button is already behind the
 * app's session auth (proxy.ts). Because the failed run it's reacting to
 * becomes "the previous run" that `runDailyDigestJob` checks, this also
 * pushes even if today has no new transactions yet.
 */
export async function retryDailyDigest(): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await runDailyDigestJob([])
    revalidatePath('/')
    if ('monthReport' in result) {
      return { ok: true, message: 'Monthly recap sent.' }
    }
    if (result.push.skipped) {
      return {
        ok: true,
        message: 'Digest ran, but the push was skipped (syncs incomplete, push not configured, or already sent today).',
      }
    }
    return { ok: true, message: `Digest sent to ${result.push.sent} device(s).` }
  } catch (err) {
    revalidatePath('/')
    return { ok: false, message: err instanceof Error ? err.message : 'Digest retry failed.' }
  }
}
