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

cd "$REPO"
echo "===== budget-sync tangerine @ $(date) ====="
# NOTE: runs HEADED (no --headless). Bank logins behind bot detection reject
# headless; a headed run in the trust-built profile passes. A browser window
# appears for ~30s at run time. Requires the user to be logged into the GUI
# session.
exec "$NODE" "$TSX" "$REPO/sync/run-tangerine.ts"
