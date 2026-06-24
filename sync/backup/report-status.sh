#!/bin/bash
# Best-effort: report a backup run to the deployed app's token-authed
# /api/backup-status so the dashboard can warn when backups go stale. Mirrors
# sync/lib/status.ts (reportSyncStatus) but in bash, so backup needs no node.
# A reporting failure must never mask the real backup result — this never exits
# non-zero.
#
# Usage: report-status.sh <ok|fail> [filename] [sizeBytes] [error]
set -uo pipefail

STATUS="${1:-fail}"
FILENAME="${2:-}"
SIZE="${3:-}"
ERROR="${4:-}"

# Same host as the CSV ingest (see sync/run-*.sh). Override with BACKUP_APP_URL.
APP_URL="${BACKUP_APP_URL:-https://nextjs-boilerplate-nu-black-85.vercel.app}"
URL="$APP_URL/api/backup-status"

# Reuse the existing ingest token (service=budget-sync-ingest, account=ingest).
TOKEN="$(security find-generic-password -a ingest -s budget-sync-ingest -w 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "  (skip status report: keychain item budget-sync-ingest not found)" >&2
  exit 0
fi

payload="{\"status\":\"$STATUS\""
[ -n "$FILENAME" ] && payload="$payload,\"filename\":\"$FILENAME\""
# size only if it's a plain integer
if [ -n "$SIZE" ] && [ "$SIZE" -eq "$SIZE" ] 2>/dev/null; then
  payload="$payload,\"sizeBytes\":$SIZE"
fi
if [ -n "$ERROR" ]; then
  esc="$(printf '%s' "$ERROR" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  payload="$payload,\"error\":\"$esc\""
fi
payload="$payload}"

code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$payload" 2>/dev/null || echo 000)"
[ "$code" = "200" ] || echo "  (backup-status report returned $code)" >&2
exit 0
