# Business Rules — Family Budget

The source of truth for how this app ingests statements, groups merchants, categorizes
spending, and computes analytics & insights. Keep this in sync with code changes.

> Privacy: this repo is **public**. We never store cardholder names or addresses. All
> pages are behind master-password auth (`proxy.ts`), and every Server Action re-checks auth
> via `requireAuth()` (`app/lib/auth-guard.ts`). Statement CSVs are gitignored (`*.csv`).

---

## 1. Data sources & CSV formats

Each month the user uploads two credit-card CSV exports. Source is auto-detected from the
header row (`app/lib/csv.ts` → `detectSource`), and the two upload buttons pass a hint that
the server validates (mismatch = clear error).

### Master card (RBC-style)
Header includes `Merchant Category Description` and `Reference Number`.
Columns used: `Date` (ISO `YYYY-MM-DD`), `Posted Date`, `Reference Number`, `Card Number`
(masked → last 4 only), `Merchant Category Description`, `Merchant Name`,
`Merchant Country Code`, `Amount` (`$1,234.56`, payments negative).
Dropped (PII): `Name on Card`.

### Amex
Header includes `Card Member` and `Account #`.
Columns used: `Date` (`10 Jun 2026`), `Date Processed`, `Description`, `Account #`
(→ last 4 only), `Amount` (plain number, charges positive, payments negative).
Dropped (PII): `Card Member`. The `Description` is fixed-width
(`<merchant>   <city/phone>`); we keep the part before the first run of 2+ spaces.

### Sign convention (unified)
- **Positive = money out** (expense). **Negative = money in** (refund or card payment).
- Both exports already follow this, so amounts are stored verbatim (as `numeric(10,2)`).

### Payments vs refunds
- **Card payments** ("PAYMENT THANK YOU" / "PAYMENT RECEIVED - THANK YOU", or a Master
  negative row with no category) are flagged `is_payment = true` and **excluded from all
  spend analytics**. They remain visible on the Activity page (toggle "Hide payments").
- **Refunds** (other negative amounts, e.g. an Amazon return) are kept and **net against**
  spending in totals/categories.

### Dedup (`external_id`, unique)
- Master: `master:<Reference Number>`.
- Amex (no stable ref): `amex:<sha256(date|description|amount|account)[:24]>`.
Re-uploading the same file is idempotent — duplicates are counted as "skipped".

### Import batches
Every upload creates an `import_batches` row (source, filename, period label = latest
transaction month in the file, counts). "Undo" deletes a batch and its transactions.

---

## 2. Merchant normalization (`app/lib/normalize.ts`)

Goal: turn messy descriptions into a stable grouping **key**.
`normalizeKey(raw)` steps:
1. Fix mojibake (`Â ` → space), collapse whitespace.
2. For Amex, strip the trailing city/phone (cut at first run of 2+ spaces).
3. Strip processor prefixes: `PAYPAL *`, `SQ *`, `TST-`/`TST*`, `SP ` (Amex Square), `NTS `
   → keep the remainder (`PAYPAL *HOMEDEPOTCA` → `homedepotca`).
4. Cut at `/` and `(` (`PRESTO MOBI/RWHSK…` → `presto mobi`; `FORTINOS (LAWRENCE…` → `fortinos`).
5. Remove `#1234` store numbers.
6. Tokenize on non-alphanumerics; drop "random" tokens (reference codes that mix letters+digits
   ≥5 chars like `255ZD3II3`, and pure numbers like store/phone numbers).
7. Lowercase join → key. `prettify(key)` → Title Case display name for new merchants.

This is deterministic and unit-friendly. Brand-level grouping (all Amazon variants → one
merchant) is **not** hardcoded here — it lives in editable DB rules (below).

---

## 3. The learning layer — `merchant_rules`

On import (`app/actions/import.ts` → `resolveMerchants`), each row's key is matched against
`merchant_rules`:
- `exact_key`: `pattern === key`. Auto-created the first time a new key is seen.
- `contains`: `key.includes(pattern)`. Created by seeds and by user "teach" actions.

Matching order: exact key first; then `contains` rules sorted by **priority desc, then
pattern length desc** (so `costco gas` beats a hypothetical `costco`). Seed `contains` rules
use `priority = pattern.length`.

If nothing matches, a new merchant is created from `prettify(key)`, plus an `exact_key` rule,
and (for Master rows) its category is guessed from the Master category description
(`masterCategoryFor`). New merchants visible to later rows in the same batch.

### How teaching persists (so future uploads "just work")
All actions live in `app/actions/merchants.ts`:
- **Rename** (`renameMerchant`): updates `merchants.name`. The key still maps; past & future
  rows show the new name.
- **Set category** (`setMerchantCategory`): updates `merchants.category_id`. Applies to all
  past & future transactions via the effective-category rule.
- **Mark recurring / special default** (`setMerchantFlags`): updates `merchants.default_*`.
  Future same-merchant rows inherit it (e.g. mark "Dental" special once → auto-special next
  month).
- **Merge** (`mergeMerchants`): repoints the losers' transactions + rules to the winner and
  deletes the losers. Future imports of the losers' patterns resolve to the winner.
- **Teach a substring** (`addContainsRule`): adds a `contains` rule AND retroactively repoints
  existing matching transactions.

### Seeds (`app/lib/seed-data.ts`, applied by `db/seed.ts`)
- `CATEGORY_SEED`: starter categories with colors.
- `BRAND_SEED`: well-known merchants + `contains` patterns (Amazon, Costco/Costco Gas,
  Walmart, Fortinos, No Frills, Rexall, Dollarama, Presto, Tim Hortons, Petro-Canada,
  Canadian Tire/Gas, IKEA, Netflix/Spotify/Anthropic/YouTube as recurring, Oddbunch,
  Distributel, …). Seeding is idempotent and never clobbers user edits (skips existing names).

Run after a schema change: `npm run db:push && npm run db:seed`.

---

## 4. Categories & effective resolution

- A **merchant** has an optional default category. A **transaction** may override it.
- **Effective category** = `transaction.category_id ?? merchant.category_id ?? Uncategorized`.
- **Effective recurring/special** = `coalesce(txn flag, merchant default, false)`.
  Transaction flags are tri-state (`true` / `false` / `null = inherit`).
- Deleting a category sets referencing merchants/transactions to `null` (Uncategorized).

---

## 4b. Cardholder attribution ("who paid")

Each transaction shows who made the purchase, derived from the card's last-4 at display
time (`app/lib/cardholders.ts`). The name↔card mapping lives **only** in `.env.local`
(gitignored) — never in committed code or the DB:

```
PARTNER_CARDS=8616,11011   # last-4 of the partner's cards
PARTNER_NAME=Alice
SELF_NAME=Me
```

Any card not in `PARTNER_CARDS` is attributed to `SELF_NAME`. Defaults are neutral
("Partner" / "Me") so the public repo contains no real name. Surfaced on the Activity page
as a per-row badge plus a person filter.

## 5. Periods

- The **anchor** is the latest transaction month present in the data.
- The period selector chooses `months ∈ {1, 3, 6, 12}` (default 3). The **current period** is
  the inclusive window `[anchor-(months-1), anchor]`; the **previous period** is the N months
  immediately before it (used for deltas / "what changed").
- Trends show up to 12 months ending at the anchor.
- "Exclude special" removes `is_special` transactions from all analytics (for one-off /
  reimbursable spend like flights or dental that insurance covers).

---

## 6. Analytics (`app/lib/analytics.ts`)

Payments are always excluded. Aggregations are computed in JS over the loaded rows.
- **Gross spend** = Σ positive amounts. **Refunds** = Σ negative (non-payment). **Net** = gross+refunds.
- **Count / Avg** are over purchases (amount > 0).
- **Category & merchant breakdowns**, **top transactions**, **weekday distribution**
  (weekend = Sat/Sun), **merchant concentration** (top-3 share), **12-month series**.

## 7. Insights (`app/lib/insights.ts`)

Pure, computed (no external/LLM calls). Cards include: spending up/down vs previous period,
top spending theme (category), biggest category mover, new merchants (first ever seen this
period), top-3 concentration warning, unusual purchase (≥2× a merchant's typical and ≥ $80),
and a subscription check (recurring merchants that didn't appear this period). Dedicated
sections expose new merchants, category movers, subscriptions, and outliers.

---

## 8. Custom reports (`/custom`)

User-built line charts for ad-hoc comparisons, to answer "where should we spend
less?". Stored in `custom_reports` (`db/schema.ts`); all logic is pure in
`app/lib/custom-reports.ts`, CRUD in `app/actions/custom-reports.ts`.

- A **report** = ordered list of **lines (series)**. A line =
  `{ name, color, categoryIds[], merchantIds[] }` (stored as `jsonb`; IDs not
  names, so renames/merges follow automatically).
- **Line membership**: a transaction belongs to a line if its **effective
  category** is in `categoryIds` **OR** its merchant is in `merchantIds`, counted
  **at most once per line** — mixing a category with a merchant inside it never
  double-counts. Only purchases (`amount > 0`) are summed (payments already
  excluded by `loadEnriched`).
- **Range**: `1|2|3|6|12` months, `ytd` (Jan of the anchor year → anchor), or
  `all` (earliest month → anchor). Saved per report and changeable inline.
- **Real average & target tip**: the anchor (latest) month is treated as the
  in-progress "current month". Per line, **average** = mean of the *complete*
  (prior) months in the range; **target** = **median** of those months; the
  anchor month is shown as "so far". With no prior month (1M) the tip is omitted.
- **Save & pin**: reports are saved by name; **pinned** reports always render as
  charts on the page (no limit). Unpinned reports show in a compact list.
- **Where to cut**: per effective category, compares this (anchor) month against
  its own average over the prior 6 complete months; lists categories currently
  over their average, ranked by dollars over (`buildWhereToCut`).

Run after adding the table: `npm run db:push` (no seed change).

## 9. Future (part 2, not built yet)

Bank statements / income & mortgage. The schema is ready: `transactions.source` is an open
enum and the sign/payment conventions already separate money-in from money-out, so a `bank`
source can be added without reworking analytics.
