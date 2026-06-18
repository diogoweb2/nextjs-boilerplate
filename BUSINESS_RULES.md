# Business Rules — Family Budget

The source of truth for how this app ingests statements, groups merchants, categorizes
spending, and computes analytics & insights. Keep this in sync with code changes.

> Privacy: this repo is **public**. We never store cardholder names or addresses. All
> pages are behind master-password auth (`proxy.ts`), and every Server Action re-checks auth
> via `requireAuth()` (`app/lib/auth-guard.ts`). Statement CSVs are gitignored (`*.csv`).

---

## 1. Data sources & CSV formats

The user uploads four CSV exports: two **credit cards** (Master, Amex) and two **banks**
(Tangerine chequing, Scotia chequing). Source is auto-detected from the header row
(`app/lib/csv.ts` → `detectSource`), and each upload button passes a hint that the server
validates (mismatch = clear error). Type alias `ImportSource = 'master' | 'amex' |
'tangerine' | 'scotia'`.

### Master card (RBC-style)
Header includes `Merchant Category Description` and `Reference Number`.
Columns used: `Date` (ISO `YYYY-MM-DD`), `Posted Date`, `Reference Number`, `Card Number`
(masked → last 4 only), `Merchant Category Description`, `Merchant Name`,
`Merchant Country Code`, `Amount` (`$1,234.56`, payments negative).
Dropped (PII): `Name on Card`.
> **Rogers Bank** credit-card exports use this same format and ingest as `master` (extra
> columns — Activity Type/Status, Merchant City/State/Postal, Rewards — are ignored). No
> separate source/parser. See `AUTO_SYNC_PLAN.md`.

### Amex
Header includes `Card Member` and `Account #`.
Columns used: `Date` (`10 Jun 2026`), `Date Processed`, `Description`, `Account #`
(→ last 4 only), `Amount` (plain number, charges positive, payments negative).
Dropped (PII): `Card Member`. The `Description` is fixed-width
(`<merchant>   <city/phone>`); we keep the part before the first run of 2+ spaces.

### Tangerine (bank)
Header `Date,Transaction,Name,Memo,Amount`. Date is `MM/DD/YYYY`; `Name` is the
description, `Memo` the sub-description; `Amount` is signed (`+` deposit, `−` debit).

### Scotia (bank)
Header `Filter,Date,Description,Sub-description,Type of Transaction,Amount,Balance`. The
leading `Filter` cell is ignored. Date is ISO; `Amount` is signed. `Balance` is **never**
used (so duplicate rows collapse — see Dedup).

### Sign convention (unified)
- **Positive = money out** (expense). **Negative = money in** (income / refund / card payment).
- Card exports already follow this and are stored verbatim. Bank CSVs use the opposite sign
  (`+` = deposit), so bank amounts are **negated** on import (`app/lib/csv.ts` → `bankRow`).
- Stored as `numeric(10,2)`.

### Flow (`transactions.flow`)
Every row has a `flow`: `expense` | `income` | `transfer`.
- **expense** — all spending (cards + bank bills/purchases/mortgage/investment). Drives every
  existing spend page (Overview, Trends, Custom, Insights), which now `filter(flow ===
  'expense')` via `loadEnriched`.
- **income** — bank deposits (salary, family support, insurance, benefits, …). Powers the
  Income page only; never netted against spend.
- **transfer** — inter-account moves and ignored card payments. Excluded from all analytics
  but still visible on Activity. `loadAllFlows` returns every non-payment row (all flows) for
  the Income page.

### Bank classification (`app/lib/bank-classify.ts`)
`classifyBank(row)` is pure and maps each bank row → `{ flow, category, merchant, recurring }`
by description + sub-description + sign. Highlights (owner-confirmed):
- **Income**: BGRS/Sirva/PAYROLL → Salary (self, Tangerine); UHN payroll → Salary (partner,
  Scotia); PEREIRA/Aparecida/TransferWise → Family Support; Canada Life/Manulife/Sun Life →
  Insurance; CCB/carbon rebate → Benefits; tax refund → Tax Refund; Interest Paid → Interest;
  unknown deposits → Other Income.
- **Inter-account transfer (ignored)**: Tangerine "EFT Withdrawal to THE BANK OF NO[VA
  SCOTIA]" ↔ the matching Scotia "investment / Tangerine" credit.
- **Bank expenses**: mortgage payment → Home; Toronto Tax → Home; Toronto Hydro/Water → Home
  (all four are the consolidated house costs); Goodlife/Planet Fitness → Health; New
  Haven/Kumon → Kids; Koodo → Subscriptions; Highway 407 → Cars; service charge → Bank Fees;
  abm withdrawal → Cash; `pos purchase` → the normal merchant-learning path (merchant text in
  the sub-description).
- **Scotia "customer transfer dr."** split: **−$1,100 → Home** (extra mortgage), **−$900 →
  Investment**;
  `Mb-Credit Card/Loc Pay` → CC Payment; any other amount → **Investment** (legacy lump
  transfers default here and can be reclassified per-transaction).
- **Investment** (incl. Scotia iTrade) is an **expense** in category `Investment` (so the
  income−spend gap reflects it; trivially re-bucketed later).

### Credit-card payments from banks (avoid double counting)
A bank payment toward a card whose own statement we import is a duplicate of tracked spending,
so it is marked `transfer` (ignored). Before we have a statement it is a real **CC Payment**
expense. Cutoffs (`CARD_TRACKED_SINCE`): **Amex `2024-12-01`**, **Rogers Mastercard
`2025-06-01`**. Visa & MBNA have no statements → always CC Payment.

### Payments vs refunds
- **Card payments** ("PAYMENT THANK YOU" / "PAYMENT RECEIVED - THANK YOU", or a Master
  negative row with no category) are flagged `is_payment = true` and **excluded from all
  spend analytics**. They remain visible on the Activity page (toggle "Hide payments").
- **Refunds** (other negative amounts, e.g. an Amazon return) are kept and **net against**
  spending in totals/categories.

### Dedup (`external_id`, unique)
- Master: `master:<Reference Number>`.
- Amex (no stable ref): `amex:<sha256(date|description|amount|account)[:24]>`.
- Tangerine: `tangerine:<sha256(date|name|amount)>`.
- Scotia: `scotia:<sha256(date|description|subdesc|amount)>` (Balance excluded).
Re-uploading the same file — or re-uploading a fuller month that overlaps an earlier partial
upload — is idempotent; duplicates are counted as "skipped". The intended rule is **same
date + vendor + amount ⇒ duplicate**, so two genuinely-identical same-day rows collapse to one.

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
- Each category has a **`kind`**: `expense` | `income` | `neutral` (default `expense`). It
  groups the Income page's source lines and keeps income/transfer buckets out of spend pickers.
  Income kinds: Salary, Family Support, Insurance, Benefits, Tax Refund, Interest, Other
  Income. Neutral: Transfer. Everything else is `expense` (incl. Home, Investment, CC Payment,
  Bank Fees, Cash).

### Category conventions (owner-confirmed consolidations)
- **Cars** — every cost of owning/driving a car: fuel (Costco Gas, Petro-Canada, Circle K, …),
  parking & parking tickets, tolls (Highway 407), maintenance/dealers/body shops (Woodbine
  Chevrolet, Mr Lube, Old Mill Cadillac, Wash Me Now), CAA, MTO, and the **car** half of
  Belair insurance. Answers "how much do we spend on cars?". (Replaced the old `Fuel` and
  `HouseCar` categories.)
- **Transport** — public transit only (Presto, TfL, GO/Union Station, Uber rideshare).
- **Home** — "cost to keep the house": Mortgage, Property Tax, Toronto Hydro, Toronto Water,
  and the **house** half of Belair. This is the single always-fixed category for the budget
  (replaced the standalone Mortgage & Property Tax categories). General home goods (IKEA,
  Home Depot, Wayfair, Canadian Tire) are **Shopping**, not Home.
- **Dental** — dental offices, split out of Health (e.g. In Path Dental, Lawrence Park Dental).
- **Subscriptions** — now also includes phone/internet (Koodo, Fido, Distributel).
- **Entertainment** — now also includes cannabis stores (Budhub, Fika), out of Health.

### Belair insurance annual split (`reconcileBelairSplit`, `app/actions/import.ts`)
Belair bills **once a year as two charges** — one for the car, one for the house, the **house
always the smaller**. After every import we group Belair's charges by calendar year and assign
the **lowest → Home** and the **rest → Cars** as transaction-level category overrides. It is
idempotent and re-applies automatically each year while the policy stays the same.
- Bank payees are resolved as fixed merchants by name (classifier-provided); a new one is
  seeded with the classifier's default category + recurring, then the transaction inherits
  them — so later edits to the merchant still win.
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
- **Activity page (`/transactions`)** filter precedence: explicit *All months* → an exact month
  → a window (2M/3M/6M/12M ending at the anchor) → **default = the current (latest) month**.
  The `PeriodSelector currentMonthDefault` prop drives this (no selection = current month, plus
  an explicit "All months" option). Deep-links carry `?category=<name>` to pre-select a category.

---

## 6. Analytics (`app/lib/analytics.ts`)

Payments are always excluded. Aggregations are computed in JS over the loaded rows.
- **Gross spend** = Σ positive amounts. **Refunds** = Σ negative (non-payment). **Net** = gross+refunds.
- **Count / Avg** are over purchases (amount > 0).
- **Category & merchant breakdowns**, **top transactions**, **weekday distribution**
  (weekend = Sat/Sun), **merchant concentration** (top-3 share), **12-month series**.
- **Same-period (apples-to-apples) deltas**: the previous-period figures (`prevGross`,
  `prevCount`, `prevAvg`) power the KPI tiles' ±% badges. When the current window reaches the
  **in-progress anchor month**, the previous period's matching month is clamped to the same
  **day-of-month** (the anchor's latest txn day) so a partial month is never compared against a
  full one (e.g. June 1–18 vs **May 1–18**, not all of May).
- **Biggest purchase** tiles/list (`largest`, `topTransactions`) exclude fixed bills via
  `isExcludedFromBiggest`: the `BIGGEST_PURCHASE_EXCLUDE_CATEGORIES` (= **Home**: mortgage,
  property tax, hydro, water) plus named recurring merchants in
  `BIGGEST_PURCHASE_EXCLUDE_MERCHANTS` (substring match, e.g. **Scholars**) so the headline isn't
  a fixed house/school bill. The same `isExcludedFromBiggest` filter is reused by the **top-3
  merchant concentration** insight (§7) so fixed bills don't dominate that headline either.
- **Dashboard category tiles** (`categoryCards`): Groceries, Cars, Shopping, Dining, Kids, Health,
  Uncategorized — each the current-period spend + same-period ±% delta; clicking one deep-links to
  `/transactions?category=<name>`. Total spend leads the same tile grid.

## 7. Insights (`app/lib/insights.ts`)

Pure, computed (no external/LLM calls). Cards include: top spending theme (category), biggest
category mover, new merchants (first ever seen this period), top-3 concentration warning
(fixed bills excluded via `isExcludedFromBiggest`; lists each merchant's amount),
unusual purchase (≥2× a merchant's typical and ≥ $80), and a subscription check (recurring
merchants that didn't appear this period). Dedicated sections expose new merchants, category
movers, subscriptions, and outliers. The overall **spending up/down** verdict is *not* an
insight card — it lives as subtext on the dashboard's Total-spend KPI tile (same-period
compare, §6).

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

## 8b. Budget (`/budget`)

Answers one question: **"How much can I spend this month — excluding unavoidable bills — to finish
the calendar year at a chosen net (default 0)?"** Logic is pure in `app/lib/budget.ts`
(`computeBudget`, fed by `loadAllFlows()`); page is `app/budget/page.tsx`, client UI in
`app/components/BudgetPlanner.tsx`, server actions in `app/actions/budget.ts`. State lives in two
tables: `budget_settings` (singleton: `targetNet`, `periodMode`) and `budget_goals` (per-category
goal override, unique on `category_id`).

### The model (anchor = latest txn month; year = anchor's year; R = months anchor..Dec inclusive)
- **Expected monthly income `I`** = avg of the **last 3 complete months** of income *excluding
  Insurance* + the **trailing-12 complete-month** average of Insurance (Insurance is lumpy, so it's
  smoothed over a year per the owner's instruction).
- **Averages use complete months only** (the partial anchor month is excluded), so a half-finished
  month never drags an average down. `currentMonthActual` is the anchor month's spend so far.
- **completedBaseline** = net (income − spend) over the year's **completed** months (before anchor).
  Spend = Σ positive `expense` amounts (matches the Income page; refunds/payments already excluded).
- **ytdNet** = net over **all** year months incl. the partial anchor month — the familiar headline
  that matches the Income page (e.g. −$8,979.39 for Jan–Jun 2026).
- **Monthly cap `B`** = `I + (completedBaseline − targetNet) / R`. Using the *completed* baseline
  (not ytdNet) means the current month gets a fresh, non-double-counted budget. Exposed as
  `monthlyCap`.
- **Unavoidable total `F`** = `monthlyUnavoidable(anchor).total` (§8c) — the **anchor month's**
  fixed categories + projected bills + subscriptions, projected from history (actual once posted).
  This replaced the old "Σ averages of the fixed categories", so `F` is now month-specific and
  reflects the bills actually due (e.g. Water/Belair only in their months). The breakdown is shown
  in the "Unavoidable this month" card with a link to Settings.
- **Ideal discretionary spend this month `X`** = `B − F` — the page's headline number.
- **Projected year-end net** = `completedBaseline + R·(I − G)` where `G` = Σ all category goals;
  **on track** when projected ≥ target. `B`/`X`/`G`/projected recompute live on the client as the
  user drags the target or a goal (`F` is server-computed and constant across those drags).

### Fixed categories & AI suggestions
- `FIXED_CATEGORIES` = **Home** only — the sole always-fixed category (it consolidates Mortgage,
  Property Tax, Hydro, Water). Hydro & Water therefore have **no** projection rule (they would
  double-count against the fixed Home total). Every other unavoidable cost (Belair, Scholars,
  Koodo, subscriptions) is a per-merchant **projected bill** managed on Settings (§8c).
- **AI initial goals** (`suggestGoals`, the default until the user edits a category): fixed cats =
  average; **Travel and Investment default to ~$0** (no more flights/Airbnb this year, and "pause
  investing" is an explicit lever — Investment is an `expense` here, so it still counts toward net);
  remaining discretionary cats = their average, **proportionally haircut** so the discretionary
  total fits the pool. The page therefore opens already balanced to hit the target.
- **Period toggle** (`periodMode`: `year` | `12mo`) switches which average (calendar-year vs
  trailing-12-month) drives the displayed averages and the suggestions across the page. The net
  target is always end-of-this-year.

Goal overrides persist per category (`saveGoal`); "Reset to suggested" deletes them (`resetGoals`).
Run after adding the tables: `npm run db:push` (no seed change).

## 8c. Projected bills, Settings & the dashboard Net-trajectory

Only the consolidated **Home** category (Mortgage, Property Tax, Hydro, Water) is always-fixed.
Every other unavoidable cost is a per-merchant **projected bill** the owner can't control but
that may not hit every month (Belair insurance, Scholars, Koodo). Modelled in `projection_rules`
(one row per merchant, unique
on `merchant_id`) + a `merchants.projection_dismissed` flag. All logic is pure in
`app/lib/projection.ts`; page `app/settings/page.tsx`, client UI `app/components/ProjectionSettings.tsx`,
server actions `app/actions/projection.ts`. Run after adding the table: `npm run db:push`.

### Rule fields & projection
- `cadence`: `monthly | quarterly | annual | periodic` (`periodic` = irregular gaps inferred from
  history). `amountMode`: `seasonal` (mean of that **calendar month** across years — Hydro
  winter≠summer), `average` (mean of recent occurrences), `last`, or `fixed` (`fixed_amount`).
- `projectedAmountForMonth(rule, all, ym)`: **actual replaces projection** — if the merchant has
  real spend in `ym`, that sum is used; else, if **due** that month (per cadence vs the merchant's
  historical occurrences) the amount is projected; else `0`.
- `monthlyUnavoidable(all, rules, ym, FIXED_CATEGORIES)`: the month's unavoidable spend = fixed
  categories (actual-or-average) + each **confirmed rule**. Subscriptions are **not** auto-included
  — per the owner's "auto-detect + manual confirm" choice they're surfaced as suggestions and added
  as rules. Drives `F` on the budget page and the dashboard widget's budget.

### Auto-detect (`suggestProjectionRules`)
Scans history for **bill-like** recurring merchants: posts ≤ ~1.5 txns per active month (so
supermarkets/restaurants — which the owner *controls* — are excluded), recurs across ≥ 2 months,
not a fixed category / already-ruled / dismissed / a financial category (`EXCLUDED_CATEGORIES` =
CC Payment, Investment, Cash, Bank Fees, Transfer). Infers cadence from occurrence gaps and
`amountMode` from amount variance (monthly + high variance ⇒ seasonal). Surfaced on Settings with
**Add** / **Dismiss** (dismiss sets `projection_dismissed`). Annual/rare bills seen in a single
month (e.g. Belair) can't be inferred, so Settings also has a **manual add** of any merchant.

### Dashboard "Net trajectory" (discretionary burn-down)
On `/` (`app/components/BurndownTrajectory.tsx`), scoped to the selected period. **Money left to
spend** = `(B − F) − cumulative discretionary spend`, burning toward $0, vs a straight **pace**
line (budget → 0 across the window). Discretionary spend **excludes** unavoidable merchants/
categories.
- **Pace % + three levels** (`pacePercent` in `app/lib/projection.ts`, shared with the push
  digest): headroom vs the pace line at the as-of point as a signed % of budget —
  `(remainingNow − paceNow) / budget`. `great` (green, ≥ 5% cushion) → "On pace ✓", `close`
  (amber/`--warning`, 0–5%) → "Cutting it close ⚠", `below` (red, negative) → "Behind pace ✗".
  Drives the remaining-line color, the % shown next to the dollar figure, and the badge.
- **Current / 1M / a single picked month** → **day-by-day** (`computeMonthBurndown`).
- **3M/6M/12M** → month-by-month over the window (`computePeriodBurndown`, budget = `(B−F)·months`).
- The budget reflects live `/budget` settings (target, goals), so editing the budget moves the widget.

### "Current" period
The dashboard period selector adds **Current** (`?period=current`) — the in-progress anchor month
from day 1 — and **defaults to it** when no period is chosen (`app/lib/params.ts`,
`PeriodSelector` `showCurrent`). It scopes the page like picking that exact month, and the widget
renders day-by-day.

## 9. Income page (`/income`)

Answers "are we ahead or behind, and which way is it trending?" Logic is pure in
`app/lib/income.ts` (`buildIncome`), fed by `loadAllFlows()`; the page is
`app/income/page.tsx`, charts in `app/components/IncomeCharts.tsx`.

- **Lines**: per-source income (self salary = Tangerine BGRS/Sirva, partner salary = Scotia
  payroll, Family, Insurance, Benefits, Other) + a bold **Total income** + a single dashed
  **Spending** line. Self/partner labels come from `SELF_NAME`/`PARTNER_NAME` in `.env.local`
  (privacy: never hardcoded). `incomeSourceOf()` maps (category, source) → line.
- **Net per month** = income − spending, drawn as a diverging bar chart (green ahead / red
  behind). KPIs: total income, total spend, net, **savings rate** (net/income), **best** and
  **worst** month (by net, over complete months), avg income/spend per month.
- **Filters** (URL-driven, server recomputes): range (`1|2|3|6|12|ytd|all`, reusing
  `monthsForRange`), account (Both / Tangerine / Scotia), exclude-special. Line visibility is
  local UI state.
- **Common-start clamp**: when viewing both accounts, the lower bound is the first month both
  accounts have data (≈ 2024-06, the oldest Scotia month) so Tangerine-only history doesn't
  skew the Net.
