#!/bin/bash
# Restore the database from a Google Drive backup. DESTRUCTIVE -- drops and
# recreates every table, replacing all current data. Requires an explicit typed
# "yes". Usage:
#   restore.sh --list           list available backups (newest first)
#   restore.sh                  restore the most recent backup
#   restore.sh <filename>       restore a specific backup
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"

PG_RESTORE="${PG_RESTORE:-/opt/homebrew/opt/libpq/bin/pg_restore}"
RCLONE="${RCLONE:-/opt/homebrew/bin/rclone}"
REMOTE="${BACKUP_REMOTE:-gdrive:BudgetBackups}"
TMP="$HOME/Library/Application Support/budget-sync/tmp"

if [ ! -f "$REPO/.env.local" ]; then echo "[restore] ERROR: $REPO/.env.local missing" >&2; exit 1; fi
set -a; source "$REPO/.env.local"; set +a
DB_URL="${DATABASE_URL_UNPOOLED:-${POSTGRES_URL_NON_POOLING:-${DATABASE_URL:-}}}"

[ -n "$DB_URL" ] || { echo "[restore] ERROR: no database URL in .env.local" >&2; exit 1; }
[ -x "$PG_RESTORE" ] || { echo "[restore] ERROR: pg_restore not found at $PG_RESTORE (brew install libpq)" >&2; exit 1; }
[ -x "$RCLONE" ] || { echo "[restore] ERROR: rclone not found at $RCLONE (brew install rclone)" >&2; exit 1; }

list() { "$RCLONE" lsf "$REMOTE/" --include "budget-*.dump" | sort -r; }

if [ "${1:-}" = "--list" ]; then
  echo "Backups in $REMOTE (newest first):"
  list
  exit 0
fi

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  TARGET="$(list | head -1)"
  [ -z "$TARGET" ] && { echo "No backups found in $REMOTE." >&2; exit 1; }
  echo "Most recent backup: $TARGET"
fi

# Show the target host (no credentials) so the user can confirm what they're about
# to overwrite.
DB_HOST="$(printf '%s' "$DB_URL" | sed -E 's#.*@([^/?]+).*#\1#')"
echo
echo "*** DESTRUCTIVE: this drops and recreates every table in:"
echo "      $DB_HOST"
echo "    replacing ALL current data with the contents of:"
echo "      $TARGET"
echo
printf 'Type "yes" to proceed: '
read -r ans
[ "$ans" = "yes" ] || { echo "Aborted."; exit 1; }

mkdir -p "$TMP"
LOCAL="$TMP/$TARGET"
echo "[restore] downloading $TARGET..."
"$RCLONE" copyto "$REMOTE/$TARGET" "$LOCAL" || { echo "[restore] ERROR: download failed" >&2; exit 1; }

echo "[restore] restoring..."
"$PG_RESTORE" --clean --if-exists --no-owner --no-privileges -d "$DB_URL" "$LOCAL"
rc=$?
rm -f "$LOCAL"
if [ "$rc" -eq 0 ]; then
  echo "[restore] complete from $TARGET"
else
  echo "[restore] ERROR: pg_restore exited $rc -- review the output above" >&2
  exit "$rc"
fi
