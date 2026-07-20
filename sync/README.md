# budget-sync

Automated daily ingestion of bank/card CSVs. See [`../AUTO_SYNC_PLAN.md`](../AUTO_SYNC_PLAN.md)
for the full design.

> Looking for the weekly **database backup → Google Drive** (and restore)? That's a
> separate job — see [`backup/README.md`](./backup/README.md). Runs **on the Mac** (not Vercel): it needs a persistent browser profile,
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

It logs in, exports the newest dated statement month (Rogers' "Current transactions"
option is broken — it enables Download but never produces a file, as of Jul 2026), and
prints the parsed row count to prove the download→parse path. Device trust persists in
the profile, so MFA is skipped on daily runs.

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

## Scotia (same pattern as Rogers/Amex)

Scotia (chequing) reuses the same machinery — only the adapter (`adapters/scotia.ts`) and
source key differ. The app already parses the Scotia CSV (`source: 'scotia'` in
`app/lib/csv.ts`), so there's no new parser.

The logged-out login form lives on a one-time `oauth_key` URL we can't hardcode, so the adapter
sends the trusted session straight to `secure.scotiabank.com/my-accounts` and lets Scotia bounce
an expired session to a freshly-keyed login screen. To reach the chequing statement it then
clicks the account from that list by matching the link's `href` on the type segment alone
(`/chequing/`) — so no account number lands in this **public** repo, and it survives Scotia
rotating the opaque per-account path token. Match the segment, not the prefix: Scotia moved
these links from `/accounts/chequing/…` to `/my-accounts/chequing/…` in mid-2026 and a
prefix-anchored selector fails as a silent 20s timeout on the my-accounts page.

One-time Keychain items (same shape as Rogers/Amex — just credentials):

```bash
security add-generic-password -a "scotia" -s "budget-sync-scotia"      -w   # password
security add-generic-password -a "scotia" -s "budget-sync-scotia-user" -w   # username/card #
```

Run it:

```bash
npx tsx sync/run-scotia.ts             # headed, watch it work
npx tsx sync/run-scotia.ts --headless  # headless
```

It logs in (username/card # + password), opens the account's Download kebab, picks
"Download as CSV", and POSTs it to the ingest endpoint as `scotia`. Device trust persists in the
profile, so MFA ("Sign in to the app to confirm it's you") is skipped on daily runs — and
escalates to a visible browser + notification if it ever appears, identical to Rogers/Amex.

Schedule (launchd): `run-scotia.sh` + `launchd/com.budget.sync.scotia.plist`, firing at **11:02**
— after Rogers (11:00) and Amex (11:01) so the headed runs don't collide in the GUI session.
Install it the same way:

```bash
cp sync/launchd/com.budget.sync.scotia.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.budget.sync.scotia.plist
launchctl start com.budget.sync.scotia   # optional: trigger once now to test
```

Logs: `~/Library/Application Support/budget-sync/logs/scotia.log`.

## Tangerine (same pattern as Rogers/Amex/Scotia)

Tangerine reuses the same machinery — only the adapter (`adapters/tangerine.ts`) and source key
differ. The app already parses the Tangerine CSV (`source: 'tangerine'` in `app/lib/csv.ts`), so
there's no new parser.

Two Tangerine-specific wrinkles the adapter handles: login is **two steps** (Login ID → "Next" →
password → "Log In") on an Angular Material SPA, and clicking **Download opens the CSV in a new
tab** — so the runner listens for the download on the browser *context*, not just the page. On the
Login ID step it also flips "Remember me on this device" on, which keeps 2-step verification
skipped on daily runs (and the saved ID then shows as a dropdown, so no typing is needed).

One-time Keychain items (same shape as the others — just credentials):

```bash
security add-generic-password -a "tangerine" -s "budget-sync-tangerine"      -w   # password
security add-generic-password -a "tangerine" -s "budget-sync-tangerine-user" -w   # login ID
```

Run it:

```bash
npx tsx sync/run-tangerine.ts             # headed, watch it work
npx tsx sync/run-tangerine.ts --headless  # headless
```

It logs in (two steps), opens the download page, picks "Excel, other software (CSV)", downloads,
and POSTs it to the ingest endpoint as `tangerine`. Device trust persists in the profile, so MFA
is skipped on daily runs (and escalates to a visible browser + notification if it ever appears,
identical to the others).

Schedule (launchd): `run-tangerine.sh` + `launchd/com.budget.sync.tangerine.plist`, firing at
**11:03** — after Rogers (11:00), Amex (11:01), and Scotia (11:02) so the headed runs don't
collide in the GUI session. Install it the same way:

```bash
cp sync/launchd/com.budget.sync.tangerine.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.budget.sync.tangerine.plist
launchctl start com.budget.sync.tangerine   # optional: trigger once now to test
```

Logs: `~/Library/Application Support/budget-sync/logs/tangerine.log`.

## Daily digest notification (Web Push)

The digest **only pushes once all 4 accounts (Rogers, Amex, Scotia, Tangerine) have a
fresh `ok` sync** — so the notification normally fires the moment the last sync of the day
completes (each successful runner triggers a digest check). A launchd job at **12:30** is a
backstop in case the per-sync triggers don't fire. After the day's syncs, it triggers a
**Web Push** notification with a
budget summary — delivered to your **phone (Android) and any subscribed browser**, even
with everything closed. No Playwright, no tab open: the runner just POSTs the deployed
app's `/api/digest`, which computes the digest **and** pushes it server-side.

What it shows (all computed in `app/lib/digest.ts`, reusing the dashboard analytics):

- **Sync health** per card — `Amex ✓ · Master ⚠️ 4d`. Reads each source's last import
  freshness, so a stale/failed sync surfaces even if its runner never fired.
- **New spend** — total + count of charges imported in the last ~24h, plus the biggest.
- **Month pace** — discretionary month-to-date vs budget, with a straight-line month-end
  projection flagged `⚠️ over` when it exceeds the cap.
- **New / unusual** — first-seen merchants and a larger-than-usual charge.

The title carries a `✓` / `⚠️` so you can triage at a glance; `⚠️` means a sync is stale
**or** you're projected to overspend. Tapping the notification opens the dashboard.

### Pieces

- `app/lib/push.ts` — server sender (`web-push` + VAPID); prunes dead subscriptions.
- `public/sw.js` — service worker that shows the push and handles the tap.
- `app/components/PushToggle.tsx` — **Settings → Notifications** enable/disable (per device).
- `push_subscriptions` table — one row per opted-in browser/device.
- `POST /api/digest` — computes + pushes; `GET /api/digest` is a no-push dry run.

### One-time setup

1. **Generate VAPID keys** and set three env vars locally (`.env.local`) **and in Vercel
   (Production)** — they must match:
   ```bash
   npx web-push generate-vapid-keys --json
   ```
   ```
   NEXT_PUBLIC_VAPID_PUBLIC_KEY=…   # exposed to the browser
   VAPID_PRIVATE_KEY=…              # server-only, signs the push
   VAPID_SUBJECT=mailto:you@example.com
   ```
2. **Apply the new table** to the database:
   ```bash
   npm run db:push
   ```
3. **Redeploy** so prod has the keys + `POST /api/digest`.
4. On your phone, open the deployed site → **Settings → Notifications → Enable**, and allow
   the permission prompt. (Android Chrome delivers even when closed. iPhone would need
   "Add to Home Screen" first — N/A here.)

### Test it

```bash
# Computes the digest and pushes to every subscribed device:
INGEST_URL=https://<app>.vercel.app/api/ingest npx tsx sync/digest.ts
# → prints the summary and "pushed to N device(s)"
```

### Schedule it

```bash
cp sync/launchd/com.budget.sync.digest.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.budget.sync.digest.plist
launchctl start com.budget.sync.digest   # optional: trigger once now to test
```

Logs: `~/Library/Application Support/budget-sync/logs/digest.log`. The launchd job only
*triggers* the push (a single HTTP POST), so the Mac just needs to be awake at 12:30 — it
already is for the syncs. If the trigger itself fails, the runner fires a local macOS
banner so a broken pipeline still surfaces.

Adding a new source: add one line to `SYNC_SOURCES` in `app/lib/sync.ts` and the digest (and
the dashboard badge) pick it up automatically.

## Failure reporting (dashboard banner)

Every run reports its outcome to the deployed app via `POST /api/sync-status` (token-authed,
same bearer token as ingest — `lib/status.ts`, called from `lib/runner.ts`). On success it
records `ok` and stamps "last worked"; on failure it records `fail` with the error message,
preserving the prior last-worked time.

The dashboard reads the `sync_runs` table and, if any source's latest run failed, shows a red
notification in the header bell naming the bank(s) and when each last worked (`app/components/NotificationBell.tsx`) — and
tints that source red in the status bar. This surfaces a break **immediately**, instead of
waiting for the 3-day staleness heuristic. The next successful run clears it automatically.

No extra setup: the report URL is derived from `INGEST_URL`, and a failed report never breaks a
run (best-effort). One-time after pulling this change: `npm run db:push` to create `sync_runs`,
then redeploy.

## Next (phases 3–5)

All four sources (Rogers, Amex, Scotia, Tangerine) are live. Remaining: push/email alerts on
failure. See `AUTO_SYNC_PLAN.md` §10.
