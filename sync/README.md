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

## Amex (same pattern as Rogers)

Amex reuses the exact Rogers machinery — only the adapter (`adapters/amex.ts`) and the
source key differ. The shared orchestration lives in `lib/runner.ts`; `run-rogers.ts` and
`run-amex.ts` are thin wrappers over it. The app already parses the Amex CSV (`source: 'amex'`
in `app/lib/csv.ts`), so there's no new parser.

One-time Keychain credentials (same shape as Rogers):

```bash
security add-generic-password -a "amex" -s "budget-sync-amex"      -w   # password
security add-generic-password -a "amex" -s "budget-sync-amex-user" -w   # User ID
```

Run it:

```bash
npx tsx sync/run-amex.ts             # headed, watch it work
npx tsx sync/run-amex.ts --headless  # headless
```

It logs in (User ID + password), expands "Latest Transactions", downloads the CSV via the
modal, and POSTs it to the ingest endpoint as `amex`. Device trust persists in the profile,
so MFA is skipped on daily runs (and escalates to a visible browser + notification if it ever
appears, identical to Rogers).

Schedule (launchd): `run-amex.sh` + `launchd/com.budget.sync.amex.plist`, firing at **12:00**
— one minute after Rogers (11:59) so the two headed runs don't collide in the GUI session.
Install it the same way:

```bash
cp sync/launchd/com.budget.sync.amex.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.budget.sync.amex.plist
launchctl start com.budget.sync.amex   # optional: trigger once now to test
```

Logs: `~/Library/Application Support/budget-sync/logs/amex.log`.

## Daily digest notification (11:15am)

After the day's syncs, a separate launchd job pops **one native macOS notification**
summarizing the budget — so you get a "go check the site" nudge **without keeping a
browser tab open**. No Playwright: it just GETs the deployed app's `/api/digest` and
hands the returned `title`/`body` to `osascript`.

What it shows (all computed server-side in `app/lib/digest.ts`, reusing the dashboard
analytics):

- **Sync health** per card — `Amex ✓ · Master ⚠️ 4d`. Reads each source's last import
  freshness, so a stale/failed sync surfaces even if its runner never fired.
- **New spend** — total + count of charges imported in the last ~24h, plus the biggest.
- **Month pace** — discretionary month-to-date vs budget, with a straight-line month-end
  projection flagged `⚠️ over` when it exceeds the cap.
- **New / unusual** — first-seen merchants and a larger-than-usual charge.

The title carries a `✓` / `⚠️` so you can triage at a glance; `⚠️` means a sync is stale
**or** you're projected to overspend.

Auth reuses the **same `budget-sync-ingest` token** as ingest (no new secret). The digest
URL is derived from `INGEST_URL` (or set `DIGEST_URL` to override).

```bash
# Test against the deployed app (prints + notifies):
INGEST_URL=https://<app>.vercel.app/api/ingest npx tsx sync/digest.ts
```

Install the schedule (after `INGEST_TOKEN` is set in Vercel — same as ingest):

```bash
cp sync/launchd/com.budget.sync.digest.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.budget.sync.digest.plist
launchctl start com.budget.sync.digest   # optional: trigger once now to test
```

Logs: `~/Library/Application Support/budget-sync/logs/digest.log`.
Adding **Tangerine** later: add one line to `SYNC_SOURCES` in `app/lib/sync.ts` and the
digest (and the dashboard badge) pick it up automatically.

## Next (phases 3–5)

Generalize the adapter for Tangerine/Scotia, then add push/email alerts on failure.
See `AUTO_SYNC_PLAN.md` §10.
