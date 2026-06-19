# New-Machine Migration Guide

> For AI assistants and the owner. Covers everything needed to move this app from scratch
> on a fresh Mac. The database and deployed app live in the cloud — only the **local sync
> daemon** and **dev tooling** need to be re-established on the new machine.

---

## What lives where

| Layer | Location | Needs migration? |
|-------|----------|-----------------|
| **App code** | GitHub (this repo) | No — just clone |
| **Database** | Neon PostgreSQL (cloud) | No — already there |
| **Deployed app** | Vercel | No — already there |
| **Environment secrets** | Vercel dashboard + `.env.local` | `.env.local` must be recreated |
| **Bank credentials** | macOS Keychain on old Mac | Must be re-entered |
| **Browser session profiles** | `~/Library/Application Support/budget-sync/` | Must be re-established per bank |
| **launchd sync agents** | `~/Library/LaunchAgents/` | Must be installed |
| **Node version manager** | `fnm` | Must be installed |

---

## 1. Prerequisites

```bash
# Install Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install fnm (Node version manager — the sync scripts depend on its alias path)
brew install fnm
# Add fnm init to ~/.zshrc, then restart your shell
echo 'eval "$(fnm env --use-on-cd)"' >> ~/.zshrc

# Install the Node version the repo uses and set it as default
cd /path/to/this/repo
fnm install   # reads .nvmrc / package.engines if present, else installs latest LTS
fnm default $(fnm current)

# Install Playwright browsers (needed by sync adapters)
npx playwright install chromium
```

---

## 2. Clone and install

```bash
git clone <repo-url> ~/dev/budget/nextjs-boilerplate
cd ~/dev/budget/nextjs-boilerplate
npm install
```

---

## 3. Recreate `.env.local`

`.env.local` is gitignored. You need to pull these values from Vercel (they mirror
what's in production) or from a password manager.

```bash
# Pull from Vercel (easiest — you're already logged in via Vercel CLI)
npx vercel link      # link to the existing project
npx vercel env pull .env.local
```

If Vercel CLI isn't available, manually create `.env.local` with these variables
(get values from the Vercel dashboard → Project → Settings → Environment Variables):

```
DATABASE_URL=
DATABASE_URL_UNPOOLED=
NEON_AUTH_BASE_URL=
NEON_PROJECT_ID=
PGDATABASE=
PGHOST=
PGHOST_UNPOOLED=
PGPASSWORD=
PGUSER=
POSTGRES_DATABASE=
POSTGRES_HOST=
POSTGRES_PASSWORD=
POSTGRES_PRISMA_URL=
POSTGRES_URL=
POSTGRES_URL_NON_POOLING=
POSTGRES_URL_NO_SSL=
POSTGRES_USER=
VERCEL_OIDC_TOKEN=
VITE_NEON_AUTH_URL=
MASTER_PASSWORD=
SESSION_SECRET=
PARTNER_CARDS=
PARTNER_NAME=
SELF_NAME=
NEXT_PUBLIC_VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=
INGEST_TOKEN=
```

> `INGEST_TOKEN` is the bearer token the sync scripts use to POST CSVs to the deployed
> app's `/api/ingest` endpoint. It is stored in Vercel env vars and in Keychain (see §5).

---

## 4. Verify the app runs locally

```bash
npm run dev
# open http://localhost:3000 — log in with MASTER_PASSWORD
```

---

## 5. Re-enter bank credentials into Keychain

The sync scripts read credentials from macOS Keychain at runtime — nothing is stored
in files. Run these one at a time in Terminal (each will prompt for the password):

```bash
security add-generic-password -a "rogers"    -s "budget-sync-rogers"    -w
security add-generic-password -a "amex"      -s "budget-sync-amex"      -w
security add-generic-password -a "tangerine" -s "budget-sync-tangerine" -w
security add-generic-password -a "scotia"    -s "budget-sync-scotia"    -w
security add-generic-password -a "ingest"    -s "budget-sync-ingest"    -w
```

The `-w` flag prompts interactively — the password is never in shell history.
The credentials stored are: bank login passwords for each source, and the `INGEST_TOKEN`
value (same token that's in Vercel env vars / `.env.local`).

---

## 6. Create browser session profile directories

Each adapter uses a persistent Chromium profile so device-trust MFA only needs to be
done once per bank. Create the directories with restricted permissions:

```bash
mkdir -p ~/Library/Application\ Support/budget-sync/{rogers,amex,tangerine,scotia,logs,status,_downloads}
chmod -R 700 ~/Library/Application\ Support/budget-sync/

# Globally gitignore so these never accidentally land in git
echo "$HOME/Library/Application Support/budget-sync/" >> ~/.gitignore_global
git config --global core.excludesFile ~/.gitignore_global
```

---

## 7. Do the one-time device MFA for each bank

The adapters run in **headed** mode (a visible browser window appears). On a fresh machine,
each bank will ask for device authorization (push notification, SMS code, etc.).
Run each adapter once manually in interactive mode to complete the setup:

```bash
cd ~/dev/budget/nextjs-boilerplate

# Rogers
node node_modules/tsx/dist/cli.mjs sync/run-rogers.ts
# → Browser opens → approve the device on your phone → browser closes automatically

# Amex (heavy bot-detection — slow and headed is required)
node node_modules/tsx/dist/cli.mjs sync/run-amex.ts

# Tangerine (two-step login: login-id screen first, then PIN)
node node_modules/tsx/dist/cli.mjs sync/run-tangerine.ts

# Scotia
node node_modules/tsx/dist/cli.mjs sync/run-scotia.ts
```

After each run succeeds, the session cookie/device token is saved in the profile directory
and future runs skip MFA entirely.

> **If a bank shows reCAPTCHA or blocks headless:** this is expected — all adapters
> intentionally run headed. If an adapter ever fails with a CAPTCHA in a headed run, the
> session profile may be stale; delete the source's profile dir and re-run to re-authorize.

---

## 8. Install the launchd sync agents

The plists live in the repo at `sync/launchd/`. Copy them to `~/Library/LaunchAgents/`
and load them:

```bash
PLIST_DIR=~/dev/budget/nextjs-boilerplate/sync/launchd

for plist in "$PLIST_DIR"/*.plist; do
  name=$(basename "$plist")
  cp "$plist" ~/Library/LaunchAgents/"$name"
  launchctl load ~/Library/LaunchAgents/"$name"
done
```

Verify they're loaded:

```bash
launchctl list | grep budget
# Expected: com.budget.sync.rogers, .amex, .tangerine, .scotia, .digest
```

### Sync schedule (all times local)

| Agent | Time | What it does |
|-------|------|--------------|
| `com.budget.sync.rogers` | 10:00 | Downloads Rogers CSV → ingests |
| `com.budget.sync.amex` | 10:01 | Downloads Amex CSV → ingests |
| `com.budget.sync.scotia` | 10:02 | Downloads Scotia CSV → ingests |
| `com.budget.sync.tangerine` | 10:03 | Downloads Tangerine CSV → ingests |
| `com.budget.sync.digest` | 11:15 | Sends daily push notification summary |

> Mac OFF at run time → skipped (no catch-up). Mac ASLEEP → runs on next wake (harmless
> because dedup prevents double-inserts via `ON CONFLICT DO NOTHING`).

---

## 9. Verify end-to-end

```bash
# Manually trigger one sync and watch the log
/Users/<you>/dev/budget/nextjs-boilerplate/sync/run-rogers.sh
tail -f ~/Library/Application\ Support/budget-sync/logs/rogers.log
# Expected: "inserted N, skipped M" with no errors

# Check status files
cat ~/Library/Application\ Support/budget-sync/status/rogers   # → "ok"
```

Then open the deployed app and confirm new transactions appeared.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `security: SecKeychainSearchCopyNext` error | Keychain entry missing | Re-run §5 for that source |
| Browser window flashes and closes with auth error | Password changed or session stale | Update Keychain entry, delete profile dir, re-run §7 |
| `node: command not found` in log | fnm `default` alias not set | `fnm default $(fnm current)` |
| launchd agent missing from `launchctl list` | Not loaded or plist not in LaunchAgents | Re-run §8 |
| Ingest returns 401 | `INGEST_TOKEN` mismatch | Confirm Keychain `budget-sync-ingest` matches Vercel `INGEST_TOKEN` |
| Digest push not arriving | VAPID keys changed or push subscription stale | Re-subscribe in app settings |

---

## Key file map

```
nextjs-boilerplate/
  CLAUDE.md / AGENTS.md       ← AI assistant instructions (read first)
  BUSINESS_RULES.md           ← source of truth for data rules
  AUTO_SYNC_PLAN.md           ← full design doc for the sync system
  .env.local                  ← secrets (gitignored; pull from Vercel)
  app/                        ← Next.js app
  db/                         ← Drizzle schema + seed
  sync/
    adapters/                 ← per-bank Playwright adapters
    lib/                      ← shared: keychain.ts, profile.ts, ingest.ts
    launchd/                  ← plist files (copy to ~/Library/LaunchAgents/)
    run-*.ts / run-*.sh       ← per-bank entry points / launchd-safe wrappers
    digest.ts / digest.sh     ← daily summary notification
```
