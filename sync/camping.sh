#!/bin/bash
# Launchd-safe wrapper for the monthly camping-project refresh.
#
# The LaunchAgent fires this EVERY DAY, and this script decides whether it is
# due: once it has succeeded in a given calendar month it exits immediately, so
# the real work happens once a month. If a run fails (RV app unreachable, gcloud
# token expired, Neon blip) no stamp is written, so tomorrow's daily fire tries
# again — and the day after that — until it works.
#
# Why a wrapper: launchd runs with a minimal environment and no fnm shell init,
# so we resolve stable paths for node, tsx, claude and gcloud ourselves.
set -euo pipefail

REPO="/Users/diogolopes/dev/budget/nextjs-boilerplate"
FNM_BIN="$HOME/.local/share/fnm/aliases/default/bin"
NODE="$FNM_BIN/node"
TSX="$REPO/node_modules/tsx/dist/cli.mjs"
DOTENV="$REPO/node_modules/dotenv-cli/cli.js"

# `claude` (the AI sweep) lives in the fnm default alias; `gcloud` (the RV app's
# Firestore token) is Homebrew. Neither is on launchd's PATH.
export PATH="$FNM_BIN:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

STATUS_DIR="$HOME/Library/Application Support/budget-sync/status"
mkdir -p "$STATUS_DIR"
STAMP="$STATUS_DIR/camping-last-success"   # holds the YYYY-MM of the last success
MONTH="$(date +%Y-%m)"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$MONTH" ]; then
  echo "camping: already refreshed in $MONTH — nothing to do @ $(date)"
  exit 0
fi

cd "$REPO"
echo "===== budget-sync camping @ $(date) ====="

status=0
"$NODE" "$DOTENV" -e "$REPO/.env.local" -- \
  "$NODE" "$TSX" "$REPO/sync/camping.ts" --apply || status=$?

if [ "$status" -eq 0 ]; then
  echo "$MONTH" > "$STAMP"
  echo "ok" > "$STATUS_DIR/camping"
  echo "✓ camping refresh succeeded @ $(date) — next run: $(date -v+1m +%Y-%m)"
  exit 0
fi

echo "✗ camping refresh failed (exit $status) @ $(date) — will retry tomorrow"
echo "fail" > "$STATUS_DIR/camping"
exit 1
