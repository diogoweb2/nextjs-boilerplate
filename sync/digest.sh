#!/bin/bash
# Launchd-safe wrapper for the daily budget digest. Mirrors run-amex.sh.
#
# Fires AFTER the day's card syncs and pops one native macOS notification with a
# glanceable overview (no browser needed — it just hits the deployed /api/digest).
set -euo pipefail

REPO="/Users/diogolopes/dev/budget/nextjs-boilerplate"
NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
TSX="$REPO/node_modules/tsx/dist/cli.mjs"

# Point at the deployed app; the digest URL is derived from INGEST_URL.
export INGEST_URL="https://nextjs-boilerplate-nu-black-85.vercel.app/api/ingest"

cd "$REPO"
echo "===== budget-sync digest @ $(date) ====="
exec "$NODE" "$TSX" "$REPO/sync/digest.ts"
