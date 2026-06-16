# Auto-Sync Plan — Daily Bank/Card CSV Ingestion

> Status: **proposal / not yet built**. This document is the design plan for replacing the
> manual CSV upload with an automated daily sync. No secrets live here — it's public-repo safe.

## 1. Goal

Replace the manual "download CSV from each bank → upload in the app" loop with a service that,
once a day on the Mac, logs into each source, exports the latest transactions, and ingests them
into the budget tracker — alerting the user when anything needs a human (MFA, layout change,
login failure).

**The hard part is the DOWNLOAD, not the upload.** For each source the service must:
auto-login (cred from Keychain) → handle the one-time device MFA → navigate to the
transaction export page → export CSV → hand the file to the (easy, local) ingest step.

Sources (all Canadian, no personal API available):

| Source        | Type        | App `ImportSource` | Login URL |
|---------------|-------------|--------------------|-----------|
| Rogers Bank   | credit card | `master` ✅        | `https://selfserve.rogersbank.com/sign-in?locale=en` |
| Tangerine     | bank        | `tangerine`        | `https://www.tangerine.ca/app/#/login/login-id?locale=en_CA` |
| Amex Canada   | credit card | `amex`             | `https://www.americanexpress.com/en-ca/account/login` (→ `https://global.americanexpress.com/statements`) |
| Scotiabank    | bank        | `scotia`           | `https://auth.scotiaonline.scotiabank.com/online` (reached from `https://www.scotiabank.com/`) |

> **Note on URLs:** Tangerine and Scotia URLs carry one-time/marketing tokens (`oauth_key`,
> `gclid`, …) that expire — the adapter should start from the **stable base URL** and let the site
> issue fresh tokens, not hardcode a captured query string.

> **Resolved (2026-06-16 spike):** Rogers' CSV export maps to the existing **`master`** source —
> no new parser. Its header carries both `Reference Number` and `Merchant Category Description`,
> so `detectSource` already returns `'master'`, and `parseMaster` reads every column it needs
> (Date ISO, Posted Date, Reference Number, Card Number, Merchant Name, Country Code, `$`-Amount).
> Rogers' extra columns (Activity Type/Status, Merchant City/State/Postal, Rewards) are ignored,
> and `Name on Card` is already dropped. Verified on a real 91-row export: all 91 `external_id`s
> came from the Reference Number (zero hash fallbacks), so dedup is robust.

## 2. Feasibility & honest risks

Feasible, but the banks are the hard part, not the code.

- **No personal APIs.** Must use browser automation (Playwright). Aggregators (Plaid/Flinks/MX)
  exist for Canadian banks but are built for businesses, cost money, and still need login —
  not worth it for a single-user personal app.
- **Fragility.** Login flows, selectors, and bot-detection (Akamai/PerimeterX/hCaptcha) change.
  Budget for occasional adapter maintenance. Design for graceful failure + clear alerts.
- **Terms of Service.** Automated access typically violates cardholder agreements. For personal,
  read-only, single-user use the practical risk is low — documented here so it's a conscious choice.
- **Fraud holds / lockouts.** Reuse ONE persistent browser profile per source, run at a steady
  time, behave like a human (no hammering). This is the biggest factor in not getting locked out.

## 3. The MFA problem (the core design decision)

Each site uses **trust-on-first-use**: a brand-new browser triggers a one-time device
authorization (approve on phone). Strategy:

- **Persistent browser profile per source** via Playwright `launchPersistentContext({ userDataDir })`.
  Do the device approval **manually once**; cookies + device token persist, so daily runs reuse
  the trusted session.
- The service must **detect the MFA/device-authorization screen** (by URL/selector) and, instead
  of failing silently, **pause and alert the user to intervene** (or run in headed mode for that
  source so the user can tap approve). Track per-source "last successful login" to predict when a
  session is about to expire.
- Sessions do eventually expire → the service must handle "password needed again" by pulling the
  credential from Keychain and re-running login, then surfacing the MFA prompt if one appears.

## 4. Deduplication — re-downloading the same month is always safe

This is a first-class design requirement: the service will download a rolling window of the current
month on every daily run. The same transaction will appear in every CSV export until the month ends.
**The app must never insert a duplicate**, and it already handles this correctly:

- Every parsed row is assigned an `external_id` before insert:
  - `master` → `master:<ReferenceNumber>` (or a hash of date+merchant+amount if no ref)
  - `amex` → `amex:hash(date, description, amount, account_last4)`
  - `tangerine` → `tangerine:hash(date, name, amount)`
  - `scotia` → `scotia:hash(date, description, sub-description, amount)`
- The `transactions.external_id` column has a **UNIQUE constraint** in the DB.
- The import uses `INSERT … ON CONFLICT (external_id) DO NOTHING` — duplicates are silently skipped.

**Result:** re-importing the same CSV 30 times only ever inserts new rows. The `inserted`/`skipped`
counts in the alert will confirm this each run (e.g. "Rogers: 0 inserted, 47 skipped" on a quiet day).

> **Edge case to watch:** if a bank's export shows a transaction as *pending* with a different
> description than when it *posts*, the hash-based `external_id` will differ and both rows may be
> inserted. This is a pre-existing behaviour in the manual upload flow. If it becomes noisy, the fix
> is a duplicate-amount-on-same-date suppression pass — but don't build that until it's a real problem.

## 5. Credential security — nothing in code, ever

The source repo is **public**. The sync scripts live in the same repo. This means:

**Absolute rules (no exceptions):**
- ❌ No credentials in source files, config files, or comments.
- ❌ No `.env` / `.env.local` files with passwords (they are gitignored locally but the pattern is risky).
- ❌ No credentials in shell history — always use the `security` CLI interactively or pipe from a file.
- ❌ No credentials in launchd plist XML (it's a plain text file under `~/Library/LaunchAgents/`).
- ❌ No credentials in log files (the runner must never log passwords or full cookie values).

**What to use: macOS Keychain (the system credential store)**

Keychain is encrypted at rest with your Mac login password, accessible only to your user account,
and never touches the filesystem in plaintext. The `security` CLI lets scripts read from it at
runtime without ever having the value in code.

```bash
# One-time setup per source (run interactively in Terminal; it will prompt for the value):
security add-generic-password -a "rogers"    -s "budget-sync-rogers"    -w
security add-generic-password -a "amex"      -s "budget-sync-amex"      -w
security add-generic-password -a "tangerine" -s "budget-sync-tangerine" -w
security add-generic-password -a "scotia"    -s "budget-sync-scotia"    -w
security add-generic-password -a "ingest"    -s "budget-sync-ingest"    -w  # app API token

# How the sync script reads a credential at runtime (never stored in any variable longer than needed):
const password = execSync('security find-generic-password -a "rogers" -s "budget-sync-rogers" -w').toString().trim()
```

**Persistent browser profiles** (session cookies, device tokens) live under
`~/Library/Application Support/budget-sync/<source>/`. These are as sensitive as passwords:

```bash
# Create with restricted permissions:
mkdir -p ~/Library/Application\ Support/budget-sync/{rogers,amex,tangerine,scotia}
chmod -R 700 ~/Library/Application\ Support/budget-sync/

# Add to global gitignore so no accident is possible:
echo "$HOME/Library/Application Support/budget-sync/" >> ~/.gitignore_global
git config --global core.excludesFile ~/.gitignore_global
```

**The ingest API token** (used by the runner to POST CSVs to the local app) is also stored in
Keychain under `budget-sync-ingest`. The app reads it from an env var set at **server startup only**,
not from any file in the repo.

## 6. Architecture

```
launchd (daily) ──> sync runner (Node + Playwright/TypeScript)
                       │
                       ├─ for each source adapter:
                       │     1. read credential from Keychain
                       │     2. launchPersistentContext(userDataDir=<source>)
                       │     3. login → detect MFA → (reuse session | alert)
                       │     4. navigate to transactions, set date range
                       │     5. export/download CSV to a temp dir
                       │     6. POST CSV to app ingest endpoint (source hint)
                       │
                       └─ collect per-source results → notify (success summary / failure alert)
```

- **Language:** TypeScript, run with the repo's toolchain so adapters can import `app/lib/csv.ts`
  types (`ImportSource`) and stay in sync with the parser.
- **Per-source adapter interface:** `login(page)`, `isMfaChallenge(page)`, `exportCsv(page, dateRange) → filePath`.
  Keeps bank-specific brittleness isolated.
- **Date range:** request a rolling window (e.g. last 14 days) every run. The dedup mechanism in
  §4 guarantees re-importing the same rows is always safe — only genuinely new rows land in the DB.

### 6.1 Per-source download flow (the actual work)

Each adapter handles login → MFA → navigate → export. Unknowns below are resolved during the
spike by walking each site manually with the browser devtools open (record selectors + the export
network call / download trigger).

- **Capturing the CSV:** prefer Playwright's `page.waitForEvent('download')` after clicking the
  export button and read `download.path()`. If the export is an XHR/fetch that returns the file,
  capture it via `page.waitForResponse(...)` instead. Pick per-source during the spike.

| Source | Login style | Export page (to confirm) | Notes / unknowns |
|--------|-------------|--------------------------|------------------|
| Rogers Bank | id + password, then device MFA | account → statements/transactions → "Download/Export" | Confirm CSV column layout vs. `master`. |
| Tangerine | login-id step, then PIN/password + MFA | account → "Download transactions" (pick CSV + date range) | Two-step login (id screen first). |
| Amex | user/password + MFA | `global.americanexpress.com/statements` → activity → "Download" → CSV | Heavy bot-detection; may need realistic UA + slow actions. |
| Scotiabank | card/username + password + MFA | account → transactions → export CSV | Start from stable base URL; ignore captured `oauth_key`. |

> Build/debug each adapter in **headed, non-headless** mode first; only flip to headless once the
> selectors and download capture are stable.

## 7. Scheduling (macOS-native)

Use **launchd**, not cron (cron is deprecated on macOS and won't wake the machine reliably).

- `~/Library/LaunchAgents/com.budget.sync.plist` with `StartCalendarInterval` (e.g. 07:00 daily).
- `RunAtLoad` false; redirect stdout/stderr to a log file under the sync data dir.
- Consider `StartInterval` retry or a wrapper that retries once on transient failure.

## 8. Alerting

Always tell the user what happened; never fail silently.

- **Success:** lightweight macOS notification with per-source counts (inserted/skipped).
- **Failure / MFA-needed / layout-change:** loud alert — macOS notification **and** a push/email
  (e.g. ntfy, Pushover, or local mail) so it's seen even if away from the Mac.
- Per-source status file (last run, last success, last error) for quick debugging.
- A `--headed` / interactive mode to re-establish a session and re-do device authorization on demand.

## 9. App-side / upload step (the easy part)

This is already mostly solved — the existing manual upload proves the parse/import path works. The
only addition is a way to feed a CSV in without clicking the UI:

- [x] Add a **token-authenticated ingest endpoint** (Route Handler). *(Done 2026-06-16.)*
      `app/api/ingest/route.ts` reuses `ingestStatement` from `app/actions/import.ts` — same parse +
      merchant/category resolution + `onConflictDoNothing({ target: externalId })` dedup, no business
      logic duplicated. Bearer-token auth via `INGEST_TOKEN`; `proxy.ts` whitelists the route. Runner
      posts via `sync/lib/ingest.ts`.
- [x] Decide Rogers Bank source mapping — **reuse `master`** (resolved 2026-06-16; see §1 note).
- [ ] Keep `BUSINESS_RULES.md` in sync if any parser/source/dedup behavior changes.

## 10. Build phases

> Effort is ~90% in phases 1 & 3 (the download adapters). Upload is a small slice.

1. ✅ **Spike — Rogers Bank, manual trigger.** *(Done 2026-06-16.)* Persistent profile + Keychain
   credentials; `sync/run-rogers.ts` auto-logs in (single-step form in an open shadow root),
   reuses device trust to skip MFA, exports "Current transactions", and the CSV parses as
   `master` with 100% Reference-Number dedup keys. Source-mapping question resolved (→ `master`).
   Code: `sync/adapters/rogers.ts`, `sync/run-rogers.ts`, `sync/lib/{keychain,profile}.ts`.
2. ✅ **Ingest endpoint.** *(Done 2026-06-16.)* `app/api/ingest/route.ts` (token-authed, reuses
   `ingestStatement`); `proxy.ts` whitelists it; `sync/run-rogers.ts` POSTs the CSV via
   `sync/lib/ingest.ts`. Auth/validation paths verified (401/400/405); dedup is the existing
   `onConflictDoNothing` so a same-day re-run inserts 0.
3. **Adapter framework + remaining sources.** Generalize the adapter interface; add the other three.
   Most of the calendar time lives here (per-bank selectors, MFA quirks, bot-detection).
4. 🟡 **Scheduling + alerting.** *(Mostly done 2026-06-16.)* launchd LaunchAgent
   `sync/launchd/com.budget.sync.rogers.plist` fires daily at 11:59 (Mac off → skipped, no
   catch-up; asleep → runs on wake, harmless via dedup). `sync/run-rogers.sh` is the launchd-safe
   wrapper (stable fnm node, prod `INGEST_URL`). macOS notifications on success/failure/MFA +
   failure screenshots to the logs dir. **Key finding:** Rogers login is behind **reCAPTCHA** —
   headless is rejected, so the runner (and cron) must run **headed**; a headed run in the
   trust-built persistent profile passes. Still TODO: push/email alert (beyond macOS notification)
   and a per-source status file.
5. **Hardening.** MFA-detection edge cases, session-expiry re-login, retries, logging, docs for
   re-authorizing a device.

## 11. Fallback / safer mode

**Decision: full-auto with a semi-automated fallback.** Default to hands-off daily runs, but every
adapter supports a runtime flag (`--interactive`) that opens the site (optionally pre-filling login)
and **pauses for the user to approve MFA / click download**, then auto-ingests the resulting CSV.
Used to (re)establish a trusted session/device, and as the safety net when a site gets too brittle.
Build the adapters so both modes share the same navigate/export code.

## 12. Decisions

**Settled:**
- ✅ **Spike target: Rogers Bank.**
- ✅ **Mode: full-auto + semi-automated fallback** (runtime flag).
- ✅ **Credentials: macOS Keychain only.** Nothing else is acceptable given the public repo.
- ✅ **Session profiles: `~/Library/Application Support/budget-sync/`, `chmod 700`, gitignored globally.**
- ✅ **Dedup: re-importing is safe.** `external_id` UNIQUE constraint + `ON CONFLICT DO NOTHING`.

**Still to confirm before building:**
- [x] Rogers Bank format → **existing `master`** (resolved during the spike, 2026-06-16).
- [ ] Alert channel (ntfy / Pushover / email)?
- [ ] Run time of day + rolling window size.
```
