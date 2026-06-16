# budget-sync

Automated daily ingestion of bank/card CSVs. See [`../AUTO_SYNC_PLAN.md`](../AUTO_SYNC_PLAN.md)
for the full design. Runs **on the Mac** (not Vercel): it needs a persistent browser profile,
real residential IP, and macOS Keychain — none of which exist on serverless.

## Layout

- `lib/keychain.ts` — read secrets from the macOS login Keychain via the `security` CLI.
- `lib/profile.ts` — per-source persistent browser profile + download dirs under
  `~/Library/Application Support/budget-sync/` (`chmod 700`, gitignored globally).
- `discover.ts` — **phase-1 discovery harness**. Headed browser; you log in + approve MFA once
  by hand, and it logs selectors + captures the downloaded CSV. Establishes the trusted session.

## Phase 1 — discovery (current step)

```bash
npx tsx sync/discover.ts rogers
```

1. A real Chrome window opens at the Rogers sign-in page.
2. Log in by hand and approve the device on your phone (one-time device trust — it persists in
   the profile dir, so later automated runs reuse it instead of re-triggering MFA).
3. Navigate to transactions/statements and trigger a **CSV export**.
4. The script saves the file to `~/Library/Application Support/budget-sync/_downloads/rogers/`
   and prints its header row — that tells us whether Rogers maps to the existing `master`
   parser or needs a new `ImportSource`.
5. Close the window. The selector tables printed in the terminal become the real auto-login
   adapter (next step).

Nothing here needs your password yet — this first run is manual login.

## Phase 1 — automated run (the spike)

Files: `adapters/types.ts` (adapter interface), `adapters/rogers.ts` (login → MFA-detect →
export, ingests as `master`), `run-rogers.ts` (Keychain → trusted profile → login → export →
parse-verify).

One-time: store credentials in Keychain.

```bash
security add-generic-password -a "rogers" -s "budget-sync-rogers"      -w   # password
security add-generic-password -a "rogers" -s "budget-sync-rogers-user" -w   # login id
```

Then run (close any discovery browser first — same profile can't be open twice):

```bash
npx tsx sync/run-rogers.ts             # headed, watch it work
npx tsx sync/run-rogers.ts --headless  # headless (for the eventual cron)
```

It logs in, exports "Current transactions", and prints the parsed row count to prove the
download→parse path. Device trust persists in the profile, so MFA is skipped on daily runs.

## Phase 2 — ingest into the app

`run-rogers.ts` POSTs the downloaded CSV to `app/api/ingest` (token-authed Route Handler) which
reuses `ingestStatement` — the same parse + merchant/category resolution + dedup as the manual
upload. Re-posting the same CSV inserts 0 duplicates (`onConflictDoNothing` on `external_id`), so
running the script several times a day is safe.

**One-time: create the ingest token** (shared by the app and the runner; never in a file):

```bash
security add-generic-password -a ingest -s budget-sync-ingest -w "$(openssl rand -hex 32)"
```

**Start the app with the token** (read from Keychain at startup — keeps it out of `.env`):

```bash
INGEST_TOKEN=$(security find-generic-password -a ingest -s budget-sync-ingest -w) npm run dev
```

**Run the sync** (separate terminal):

```bash
npx tsx sync/run-rogers.ts
```

Output ends with e.g. `✓ ingested "master" (2026-06): 8 inserted, 0 skipped`. Run it again the
same day and it should report `0 inserted, 8 skipped` — that's the dedup working.

For a deployed app, point the runner at it: `export INGEST_URL=https://your-app/api/ingest`
(and set `INGEST_TOKEN` in the host's env).

## Daily schedule (launchd, 11:59am)

Runs on the Mac via a LaunchAgent. **Mac off at 11:59 → run is skipped (no catch-up).**
**Asleep → runs on next wake** (harmless; dedup makes re-imports a no-op). It POSTs to the
**deployed** app, so nothing local needs to be running.

Files: `run-rogers.sh` (launchd-safe wrapper — resolves a stable fnm node, sets `INGEST_URL`)
and `launchd/com.budget.sync.rogers.plist`.

**Runs HEADED.** Rogers' login is behind reCAPTCHA, which rejects headless browsers; a headed
run in the trust-built persistent profile passes. So a Chrome window appears for ~30s at run
time, and **you must be logged into the macOS GUI session** for it to work (it is at noon).

**MFA:** device trust normally persists, so MFA never appears. If it ever does, the runner
reopens a **visible** browser, sends a macOS notification, and waits up to 20 min for you to
approve on your phone — then continues automatically.

### Setup

1. Deploy the ingest endpoint (push to `main` → Vercel) and set `INGEST_TOKEN` in Vercel's
   Production env to the same value as the `budget-sync-ingest` Keychain item:
   ```bash
   security find-generic-password -a ingest -s budget-sync-ingest -w   # copy into Vercel env
   ```
2. Edit `run-rogers.sh` → set `INGEST_URL` to your real `https://<app>.vercel.app/api/ingest`.
3. Verify a run works end-to-end against prod (headed — Rogers reCAPTCHA blocks headless):
   ```bash
   INGEST_URL=https://<app>.vercel.app/api/ingest npx tsx sync/run-rogers.ts
   ```
4. Install the schedule:
   ```bash
   cp sync/launchd/com.budget.sync.rogers.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.budget.sync.rogers.plist
   launchctl start com.budget.sync.rogers   # optional: trigger once now to test
   ```
5. Logs: `~/Library/Application Support/budget-sync/logs/rogers.log`.
   Unload to stop: `launchctl unload ~/Library/LaunchAgents/com.budget.sync.rogers.plist`.

## Next (phases 3–5)

Generalize the adapter for Tangerine/Amex/Scotia, then add push/email alerts on failure.
See `AUTO_SYNC_PLAN.md` §10.
