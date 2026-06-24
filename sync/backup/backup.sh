#!/bin/bash
# Weekly database backup to Google Drive. Also the `npm run backup` manual trigger.
#
# Dumps the whole Neon Postgres DB with pg_dump's custom, zlib-compressed format
# (-Fc -Z 9 -- already compressed, no separate gzip needed), uploads it to a
# dedicated Drive folder via rclone, prunes to the last N archives, then reports
# the outcome to the app (/api/backup-status) so a stale/broken backup surfaces
# as a dashboard banner. See sync/backup/README.md.
#
# Launchd-safe: like the sync wrappers it pins absolute tool paths (launchd has a
# minimal PATH) and writes to the log configured in the plist.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"

PG_DUMP="${PG_DUMP:-/opt/homebrew/opt/libpq/bin/pg_dump}"
RCLONE="${RCLONE:-/opt/homebrew/bin/rclone}"
REMOTE="${BACKUP_REMOTE:-gdrive:BudgetBackups}"
KEEP="${BACKUP_KEEP:-12}"
TMP="$HOME/Library/Application Support/budget-sync/tmp"

# DB creds come from .env.local (values are quoted -- safe to source). pg_dump
# needs a direct (non-pooler) session, so prefer the unpooled URL.
if [ ! -f "$REPO/.env.local" ]; then echo "[backup] ERROR: $REPO/.env.local missing" >&2; exit 1; fi
set -a; source "$REPO/.env.local"; set +a
DB_URL="${DATABASE_URL_UNPOOLED:-${POSTGRES_URL_NON_POOLING:-${DATABASE_URL:-}}}"

TS="$(date +%Y%m%d-%H%M%S)"
NAME="budget-$TS.dump"
mkdir -p "$TMP"
OUT="$TMP/$NAME"

echo "===== budget backup @ $(date) ====="

fail() {
  echo "[backup] FAILED: $1" >&2
  bash "$DIR/report-status.sh" fail "" "" "$1" || true
  rm -f "$OUT"
  exit 1
}

[ -n "$DB_URL" ] || fail "no database URL in .env.local"
[ -x "$PG_DUMP" ] || fail "pg_dump not found at $PG_DUMP (brew install libpq)"
[ -x "$RCLONE" ] || fail "rclone not found at $RCLONE (brew install rclone)"

echo "[backup] dumping database (compressed)..."
"$PG_DUMP" -Fc -Z 9 --no-owner --no-privileges -f "$OUT" "$DB_URL" || fail "pg_dump error"

SIZE="$(stat -f%z "$OUT" 2>/dev/null || echo 0)"
echo "[backup] dump ready: $NAME ($SIZE bytes)"

echo "[backup] uploading to $REMOTE..."
"$RCLONE" copy "$OUT" "$REMOTE/" || fail "rclone upload error"

# Retention: timestamped names sort chronologically, keep newest $KEEP, delete rest.
echo "[backup] pruning to last $KEEP archives..."
"$RCLONE" lsf "$REMOTE/" --include "budget-*.dump" | sort -r | tail -n +"$((KEEP + 1))" |
  while IFS= read -r f; do
    [ -n "$f" ] && "$RCLONE" deletefile "$REMOTE/$f" && echo "[backup] removed old $f"
  done

rm -f "$OUT"
echo "[backup] complete: $NAME"
bash "$DIR/report-status.sh" ok "$NAME" "$SIZE" "" || true
