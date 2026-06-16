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
# ⚠️ Replace with your real Vercel production URL.
export INGEST_URL="https://REPLACE-ME.vercel.app/api/ingest"

cd "$REPO"
echo "===== budget-sync rogers @ $(date) ====="
exec "$NODE" "$TSX" "$REPO/sync/run-rogers.ts" --headless
