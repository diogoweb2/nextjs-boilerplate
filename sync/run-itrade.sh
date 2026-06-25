#!/bin/bash
# Launchd-safe wrapper for the MONTHLY iTrade holdings sync. Mirrors run-scotia.sh.
#
# Why a wrapper: launchd runs with a minimal environment and no fnm shell init, so
# we resolve a STABLE node path (fnm's `default` alias) and run tsx directly.
# Output goes to the log file configured in the plist.
set -euo pipefail

REPO="/Users/diogolopes/dev/budget/nextjs-boilerplate"
NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
TSX="$REPO/node_modules/tsx/dist/cli.mjs"

# Point the runner at the deployed app's ingest host (the runner swaps
# /api/ingest → /api/ingest-holdings itself).
export INGEST_URL="https://nextjs-boilerplate-nu-black-85.vercel.app/api/ingest"

STATUS_DIR="$HOME/Library/Application Support/budget-sync/status"
mkdir -p "$STATUS_DIR"

cd "$REPO"
echo "===== budget-sync itrade @ $(date) ====="
# NOTE: runs HEADED (no --headless). Bank logins behind bot detection reject
# headless; a headed run in the trust-built profile passes. A browser window
# appears for ~1 min at run time. Requires the user to be logged into the GUI
# session. First run will likely prompt for phone MFA (own browser profile).

# Retry on failure: the initial run plus up to 3 retries (4 total), 5 min apart.
# Re-imports add a fresh snapshot each time, so the wrapper exits on first success
# to avoid stacking duplicate snapshots from retries.
ATTEMPTS=4
DELAY=300  # 5 minutes between attempts

for attempt in $(seq 1 "$ATTEMPTS"); do
  echo "----- attempt $attempt/$ATTEMPTS @ $(date) -----"
  status=0
  "$NODE" "$TSX" "$REPO/sync/run-itrade.ts" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "✓ itrade sync succeeded on attempt $attempt @ $(date)"
    echo "ok" > "$STATUS_DIR/itrade"
    exit 0
  fi
  echo "✗ itrade sync failed on attempt $attempt (exit $status) @ $(date)"
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    echo "retrying in $((DELAY / 60)) min…"
    sleep "$DELAY"
  fi
done

echo "✗ itrade sync gave up after $ATTEMPTS attempts @ $(date)"
echo "fail" > "$STATUS_DIR/itrade"
exit 1
