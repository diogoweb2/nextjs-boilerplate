#!/bin/bash
# Launchd-safe wrapper for the daily Tangerine sync. Mirrors run-rogers.sh.
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
echo "===== budget-sync tangerine @ $(date) ====="
# NOTE: runs HEADED (no --headless). Bank logins behind bot detection reject
# headless; a headed run in the trust-built profile passes. A browser window
# appears for ~30s at run time. Requires the user to be logged into the GUI
# session.
status=0
"$NODE" "$TSX" "$REPO/sync/run-tangerine.ts" || status=$?
if [ "$status" -eq 0 ]; then
  echo "ok" > "$STATUS_DIR/tangerine"
else
  echo "fail" > "$STATUS_DIR/tangerine"
  exit "$status"
fi
# Trigger the digest now that this sync succeeded. If all other sources are also
# ok today the push fires; the server deduplicates so the 11:15 job is a no-op.
echo "→ triggering digest check…"
"$NODE" "$TSX" "$REPO/sync/digest.ts" || echo "  (digest trigger failed — scheduled digest at 11:15 will retry)"
