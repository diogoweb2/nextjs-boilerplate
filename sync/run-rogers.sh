#!/bin/bash
# Launchd-safe wrapper for the daily Rogers sync.
#
# Why a wrapper: launchd runs with a minimal environment and no fnm shell init,
# so we resolve a STABLE node path (fnm's `default` alias, not the ephemeral
# per-shell multishell path) and run tsx directly. Output goes to the log file
# configured in the plist.
set -euo pipefail

REPO="/Users/diogolopes/dev/budget/nextjs-boilerplate"
NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
TSX="$REPO/node_modules/tsx/dist/cli.mjs"

# Point the runner at the deployed app's ingest endpoint.
export INGEST_URL="https://nextjs-boilerplate-nu-black-85.vercel.app/api/ingest"

STATUS_DIR="$HOME/Library/Application Support/budget-sync/status"
mkdir -p "$STATUS_DIR"

cd "$REPO"
echo "===== budget-sync rogers @ $(date) ====="
# NOTE: runs HEADED (no --headless). Rogers' reCAPTCHA rejects headless logins;
# a headed run in the trust-built profile passes. A browser window appears for
# ~30s at run time. Requires the user to be logged into the GUI session.

# Retry on failure: the initial run plus up to 3 retries (4 attempts total), 5
# min apart, before giving up. Bank syncs fail for transient reasons (a slow
# page, a momentary MFA escalation, a blip in the deployed ingest endpoint);
# spacing retries 5 min apart lets those clear. Re-imports dedup to zero, so
# retrying after a partial success is harmless.
ATTEMPTS=4
DELAY=300  # 5 minutes between attempts

for attempt in $(seq 1 "$ATTEMPTS"); do
  echo "----- attempt $attempt/$ATTEMPTS @ $(date) -----"
  status=0
  "$NODE" "$TSX" "$REPO/sync/run-rogers.ts" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "✓ rogers sync succeeded on attempt $attempt @ $(date)"
    echo "ok" > "$STATUS_DIR/rogers"
    # Trigger the digest check now that this sync succeeded. It only pushes once
    # ALL 4 accounts are ok today, so this fires the notification when the last
    # sync of the day completes; the 12:30 launchd job is just a backstop.
    echo "→ triggering digest check…"
    "$NODE" "$TSX" "$REPO/sync/digest.ts" || echo "  (digest trigger failed — scheduled digest at 12:30 will retry)"
    exit 0
  fi
  echo "✗ rogers sync failed on attempt $attempt (exit $status) @ $(date)"
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    echo "retrying in $((DELAY / 60)) min…"
    sleep "$DELAY"
  fi
done

echo "✗ rogers sync gave up after $ATTEMPTS attempts @ $(date)"
echo "fail" > "$STATUS_DIR/rogers"
exit 1
