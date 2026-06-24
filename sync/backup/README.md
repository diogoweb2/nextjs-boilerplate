# Database backup → Google Drive

Weekly, automatic, off-site backup of the entire Neon Postgres database, plus a
manual trigger and a restore path. All data lives in Neon (nothing on local
disk), so this is the only thing standing between you and total data loss if the
Neon project is ever deleted or corrupted.

## What it does

1. `pg_dump -Fc -Z 9` — dumps the whole DB into a single **compressed** custom-format
   archive `budget-YYYYMMDD-HHMMSS.dump` (zlib, ~the smallest practical size).
2. `rclone copy` — uploads it to **`gdrive:BudgetBackups/`** on your Google Drive.
3. Prunes to the **last 12** archives (override with `BACKUP_KEEP`).
4. Reports the result to the app (`POST /api/backup-status`) so the dashboard can
   warn you (red banner) if no successful backup has happened in **> 2 weeks**.

Runs **weekly, Friday 11:40** via launchd (`com.budget.backup`). The Mac must be
awake; if it's off the run is skipped, if asleep it runs on next wake. Backups are
idempotent — each run just makes a fresh timestamped archive.

## One-time setup

```sh
# 1. Postgres client tools (pg_dump / pg_restore) and rclone
brew install libpq rclone

# 2. Connect rclone to your Google Drive (opens a browser to log in once).
#    Name the remote exactly "gdrive" and accept the defaults; you don't need a
#    custom client id for personal use.
rclone config        # n) new remote → name: gdrive → storage: drive → ... → y

# 3. Install the weekly schedule
launchctl bootstrap gui/$(id -u) \
  /Users/diogolopes/dev/budget/nextjs-boilerplate/sync/launchd/com.budget.backup.plist

# (status reporting reuses the existing `budget-sync-ingest` Keychain token — no
#  new secret. The dashboard banner needs INGEST_TOKEN set on the deployed app,
#  which the sync pipeline already requires.)
```

Tools are referenced by absolute path (`/opt/homebrew/opt/libpq/bin/pg_dump`,
`/opt/homebrew/bin/rclone`) because launchd runs with a minimal PATH. Override via
the `PG_DUMP`, `PG_RESTORE`, `RCLONE`, `BACKUP_REMOTE`, `BACKUP_KEEP`,
`BACKUP_APP_URL` env vars if your paths differ.

## Manual use

```sh
npm run backup                 # back up right now
npm run restore -- --list      # list available backups (newest first)
npm run restore                # restore the most recent backup  (DESTRUCTIVE)
npm run restore -- budget-20260624-114000.dump   # restore a specific one
```

## Restore — read this

Restore is **destructive**: `pg_restore --clean --if-exists` drops and recreates
every table, replacing all current data with the backup's contents. The script
shows the target DB host and the chosen file, then requires you to type `yes`.

To rehearse safely without touching production, restore into a **Neon branch** (a
throwaway copy): create a branch in the Neon console, put its unpooled connection
string in `DATABASE_URL_UNPOOLED`, and run the restore against that.

## Verify / operate

```sh
# Fire the scheduled job once, now, and watch the log
launchctl kickstart -k gui/$(id -u)/com.budget.backup
tail -f "$HOME/Library/Application Support/budget-sync/logs/backup.log"

rclone lsf gdrive:BudgetBackups/          # confirm the archive landed
pg_restore --list <file>.dump             # confirm an archive is valid

# Remove the schedule
launchctl bootout gui/$(id -u)/com.budget.backup
```

## Files

| Path | Role |
|------|------|
| `backup.sh` | dump → compress → upload → prune → report (`npm run backup`, launchd) |
| `restore.sh` | list / download / `pg_restore` with confirmation (`npm run restore`) |
| `report-status.sh` | best-effort `POST /api/backup-status` (Keychain-token auth) |
| `../launchd/com.budget.backup.plist` | weekly Friday 11:40 schedule |
| `../../app/api/backup-status/route.ts` | token-authed endpoint → `backup_runs` table |
| `../../app/components/BackupStatusBanner.tsx` | dashboard "backup overdue" banner |
