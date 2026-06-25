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

A transaction's flow can be **overridden manually** from the Activity row editor (`setTxnFlow`,
`app/actions/transactions.ts`) — the fix for a mis-pressed dashboard transfer review. Choosing
`transfer` also moves the row to the neutral `Transfer` category; `expense`/`income` change only the
flow (adjust the category with the picker). Setting `transfer` drops the row out of spend, the Income
page, the runway burn and safe-to-move, while the Emergency Fund still moves the account balance (§12 —
it ignores flow).

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

### Manual split (`splitTransaction` / `unsplitTransaction`, `app/actions/transactions.ts`)
One real charge sometimes spans categories — e.g. a Walmart grocery run that also
includes $50 of kids' clothes. From the Activity row editor (Split), the user peels
**parts** off a transaction: each part becomes its own child row with its own amount,
category, and merchant label, and the **parent's amount is reduced** by the total peeled
off so the sum is unchanged — analytics never double-count. Tracked by a self-referencing
`transactions.split_parent_id` (cascade, so undoing a batch drops the children too).
- A part's **label** defaults to the parent merchant; reusing the same name keeps the
  same merchant (just a per-txn category override), while a **new** label creates a
  rule-less merchant (`merchant_rules` untouched). So future statements still resolve the
  original merchant to its normal category, and the carved-out spend stays a one-off that
  is **never** auto-categorized again.
- Children inherit the parent's date/source/card/batch; their `external_id` is
  `<parent>:split:<rand>` so re-imports (which skip the still-present parent id) leave the
  split intact. The original must keep a **positive remainder** (to fully reassign a row,
  just recategorize it). **Unsplit** deletes the children and folds their amounts back into
  the parent; merchants left orphaned are cleaned up by the merchants page's prune path.
- Run after pulling this change: `npm run db:push` (adds `split_parent_id`).

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
A batch `saveAllGoals` upserts many overrides at once (used by Auto-balance and the seasonal
proposal). Run after adding the tables: `npm run db:push` (no seed change).

### Auto-balance (client, `computeAutoBalance`)
A button in the Category-goals card. Disabled when nothing is over budget (all green). It turns every
over-budget (red) category green while keeping `ΣG ≤ B` — which is *exactly* the year-end-net-goal
constraint, since `projected ≥ target ⟺ ΣG ≤ B`. Mechanics:
- Red categories can't un-spend → their goal rises to the month's actual spend (green).
- The extra is funded by trimming the **cushion** (`goal − actual`) of the flexible green categories,
  proportionally. **Fixed** categories (Home) are never trimmed below their committed goal.
- Floor: a trimmed goal never drops below that category's own actual spend, so it can't go red again.
- **Impossible** when even zero-cushion flexible spending plus commitments exceed `B`; the UI then
  shows a warning naming the minimum achievable total and the overage, instead of rebalancing. The
  warning auto-clears once edits (e.g. raising the target) make rebalancing viable again.

### Non-budget categories
Financial / transfer-like expense categories — **CC Payment, Cash, Bank Fees** (`NON_BUDGET_CATEGORIES`)
— are excluded from the budgetable category list (goals, suggestions, proposal). They still count toward
net/spend via the un-categorized `spendOver` totals (an untracked card payment is the only signal of that
spending — see `bank-classify.ts` `cardPayment`), but you don't set a discretionary *goal* for "paying a
credit card", and a seasonal lift on them was producing nonsense lines. (Transfer is `kind:'neutral'`,
already excluded.)

### Seasonal proposal (`proposeSeasonal`, shown whenever there are budgetable categories)
A "new month" starting budget that respects the year-end goal. Per category it picks a *seasonal
average*, then fits all of them to `B` via `suggestGoals` (empty zero-list — the zeroing is already
baked into the chosen averages):
- **Groceries** → 3-month rolling average (tracks steadily rising prices); flagged when it moves >$15.
- **Everything else** → the same-calendar-month average across prior years (≤5), used when ≥2 prior
  years exist and the swing is material (≥10% **and** ≥$25; a normally-$0 category needs only the $25
  absolute move). This is what captures **summer camping (Travel), Kids summer/spring-break camp, and
  extra summer fuel (Transport)** — note a normally zero-defaulted category like **Travel can be
  lifted** by a strong seasonal signal here, unlike the regular suggestion.
- **Investment** stays a deliberate $0 lever (never lifted by history).
- Recurring/quarterly bills (Toronto Water) and weekly-mortgage "5-payment" months are handled by the
  unavoidable `F` projection (§8c), not here.
Each lifted line carries a human reason shown in a reasoning box; the table lists **every** budgetable
category (Regular→Proposed→Δ, biggest changes first, seasonal ones marked ●) so it reads as a full plan,
not a partial one. If a lift forced the pool haircut to trim other flexible lines, a note says so.
"Apply this proposal" batch-saves all lines as overrides.

### Auto-adopt on a new month (`commitMonthlyBudget`, `budget_settings.budgetedMonth`)
`budgetedMonth` (YYYY-MM, nullable) records the anchor month the proposal was last adopted for. On load
the client compares it to the anchor:
- **null** (first run) → just record the marker; existing goals are **not** touched.
- **marker < anchor** (month advanced) → adopt the seasonal proposal as the new starting budget
  (`commitMonthlyBudget(anchor, proposedGoals)`), show a one-time banner; the owner then adjusts.
- **marker == anchor** → nothing (so in-month manual edits are preserved).
The server action re-reads the marker before writing, so a double client fire is a no-op. Demo sessions
pass `autoPropose={false}` (never write). Run after the schema change: `npm run db:push`.

### Live year-end feedback (Category-goals card)
While dragging any goal/target slider, the card surfaces the year-end-net status without scrolling: a
pill badge ("Year-end close" yellow / "Year-end ✗" red) plus a ~1.5s coloured ring that flashes when
the status worsens. Thresholds: **red** when `projected < target`; **yellow** within
`max($500, 10%·|target|)` above the target.

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

## 8d. 50/30/20 rule (dashboard card)

A dashboard card comparing the **Needs / Wants / Savings** split to the classic 50/30/20 targets,
scoped to the **selected period** (same window as the rest of the Overview). Logic is pure in
`app/lib/fifty-thirty-twenty.ts` (`computeBudgetRule`, fed by `loadAllFlows()`); the card body is
`app/components/charts/BudgetRuleChart.tsx` (reuses `Donut`). Each expense category carries a
`bucket` (`needs` | `wants` | `savings` | `none`) on the `categories` table, seeded with defaults
(see `app/lib/seed-data.ts`) and **editable per category** on `/categories`.

- **Income base** = income-flow rows whose **category kind = `income`** only (Salary, Family
  Support, Benefits, Tax Refund, Interest, Other Income).
- **Reimbursements:** an income-flow row filed under an **expense-kind** category (e.g. dental
  insurance under `Dental`) is a reimbursement — it **nets against that category**, never income.
  This also drives the **Dental coverage** flag: `reimbursed / expense`, warned when **< 80%**.
- **Per-category net** = Σ expense amounts + Σ income (reimbursement) amounts; each category
  contributes `max(0, net)` to its bucket (an over-reimbursed category can't go negative).
- **Extra mortgage → Savings:** the voluntary extra mortgage prepayment (`isExtraMortgagePayment`,
  `app/lib/mortgage.ts`) is moved out of Needs and counted as **Savings** (principal paydown builds
  equity). The contractual mortgage payment stays in Needs.
- **Savings** = the `Investment`-bucket category net (covers transfers tagged to goals and
  `asExpense` goal deposits, since both create an `Investment` expense) **+** the extra mortgage
  principal **+** manual savings-goal contributions with **no backing transaction**
  (`loadManualSavingsContributions` — txn-backed ones are excluded to avoid double-counting).
- Each bucket shows actual % of income, the target (50/30/20) and the signed difference (points +
  dollars). Run after the schema change: `npm run db:push` and re-run `npm run db:seed` to backfill
  bucket defaults (the seed only fills buckets still set to `none`, never clobbering owner edits).

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

## 10. Goals (`/goals`)

The owner moves money to investment/savings accounts (mostly Scotia → iTrade) for different
reasons that used to all collapse into one `Investment` expense. Goals let the owner say what a
transfer was *for*, track progress to a target, and handle market-valued and mortgage goals. The
**Goals** tab is 2nd in the nav. Page `app/goals/page.tsx`, client UI
`app/components/GoalsManager.tsx`, server actions + loaders `app/actions/goals.ts`, pure math in
`app/lib/goals.ts` (savings value/progress/sparkline) and `app/lib/mortgage.ts` (payoff projection).

### Tables (`db/schema.ts`)
- **`goals`** — `kind: 'savings' | 'mortgage' | 'netzero'`, `name, emoji, color, sortOrder, archived,
  notify`, optional `targetAmount` / `targetDate`, and mortgage-only `annualRate`.
- **`goal_entries`** — the ledger driving a goal's value: `contribution` (money in; signed
  `amount`; `transactionId` set when it came from a real transfer, null for a manual "extra"
  deposit), `adjustment` (savings market reconcile; `amount` = signed delta so the running Σ
  equals the new value), `balance` (mortgage only; `amount` = the absolute statement balance).
- **`transfer_reviews`** — the dashboard prompt queue (`pending|resolved|dismissed`, unique on
  `transactionId`, optional `suggestedGoalId`, **`direction: 'out' | 'in'`** — outbound money moving
  to investments vs inbound money returning from them).

A **savings** goal's value = Σ contribution+adjustment amounts (a `contribution` may be **negative** —
a goal "spend", see below). Budget/analytics impact is carried **only** by the underlying
transaction's `flow`, so goal contributions never double-count.

### Spending from a goal (the goal as a purpose-built savings account)
A savings goal you funded (each contribution counted as an Investment **expense**, so the money already
left your net) can later be **spent** for its purpose. Spending records the amount as **income** so it
offsets the real purchase and net stays correct over the full lifecycle (e.g. save $3k to "Travel" as
expense → buy a $5k flight, a real expense → spend $3k from the goal as income → the trip nets −$5k, no
double count). Two entry points (`asIncome` / inbound review create an `income`-flow transaction in the
new **`Goal Spend`** income category, so it shows on the Income page as its own line):
- **Manual "Spend"** (`spendFromGoal`, the goal card) — reduces the goal via a **negative**
  `contribution` (capped at the goal's value) and, when "count as income" is on (default), inserts the
  offsetting `Goal Spend` income transaction. Use it when you paid by card and no bank transfer will be
  imported. `totalContributed` still counts positive contributions only, so withdrawals don't inflate it.
- **Inbound transfer review** — when the real money lands (see below).

### Import hook (`app/actions/import.ts` → `createTransferReviews` / `createWithdrawalReviews` / `createInboundReviews`)
After each import:
- **Outbound** (`createTransferReviews`, `direction='out'`): every newly-inserted Scotia transfer the
  classifier routed to the **`Investment (iTrade)`** payee (the recurring **$900** and any
  **non-$1,100** customer transfer — `classifyScotia`) gets a `pending` review. The exact
  **$1,100 → Mortgage** still auto-classifies with **no** prompt. `suggestedGoalId` is learned: the goal
  most often tagged on a prior transfer of the same rounded amount.
- **Outbound withdrawals** (`createWithdrawalReviews`, `direction='out'`): every newly-inserted
  *unidentified* bank outflow — the catch-all `AMBIGUOUS_OUTBOUND_MERCHANTS` (**E-Transfer Out**,
  **Bank Withdrawal**, **Cheque Withdrawal**) — also gets a `pending` review. This is the **debit leg of
  an internal Tangerine↔Scotia transfer**, which the classifier otherwise leaves as a spurious
  `Other`/wants expense (polluting spend analytics *and* the runway burn). Recognized expenses (Koodo,
  Highway 407, …) never use these labels, so they aren't queued.
- **Inbound** (`createInboundReviews`, `direction='in'`): every newly-inserted **unknown deposit** (the
  `Other Deposit` fallback merchant — recognized income like salary/benefits/insurance is already
  classified and never lands here) gets a `pending` review. These are the ambiguous credits — e.g. money
  pulled back from the investment account — the owner labels (default classification stays Other Income
  until resolved).

Both are idempotent (`transactionId` is unique).

### Dashboard prompt (`app/components/TransferReview.tsx`)
Pending reviews render a prominent `--warning` card at the **top** of the dashboard until resolved.
Treatments depend on `direction` (`resolveTransferReview`):
- **Outbound** (money to investments): **Count as expense** (default — keep `flow=expense`, category
  `Investment`) · **Internal transfer** (moved between the owner's own accounts → `flow=transfer`,
  category `Transfer`) · **Don't count** (better-interest move → `flow=transfer`, category `Transfer`;
  leaves analytics) · **Extra mortgage** (not a goal → recategorize to Home / `Mortgage`) · **Leave
  as-is** (dismiss). The two counting options allocate the amount across one or more savings goals,
  **growing** them (positive contributions).
- **Inbound** (money returning): **Spend from a goal** (default — keep `flow=income`, category
  `Goal Spend`; allocate the amount to **reduce** one or more savings goals — negative contributions) ·
  **Internal transfer** (moved between the owner's own accounts → `flow=transfer`, category `Transfer`) ·
  **Other income** (keep `flow=income`, category `Other Income`, not tied to a goal) · **Don't count**
  (an investment move we don't track → `flow=transfer`, category `Transfer`) · **Leave as-is** (dismiss).
- **Internal transfer** (the shared `transfer` treatment): handles **both legs** of a bank-to-bank move
  (e.g. Tangerine → Scotia). Each leg is set to `flow=transfer` so it's excluded from spend, the Income
  page, the runway burn, and the safe-to-move schedule — while the **Emergency Fund still moves each
  account's balance** (it queries every bank row regardless of flow, §12). Net fund total is unchanged;
  legs that import on different days reconcile once both are in.

Allocations split a single transfer across goals; the shared sign helper grows (out) or reduces (in)
each tagged goal.

### Mortgage goal (auto-created, smart projection)
Bootstrapped on first `/goals` load from `.env.local` (privacy — never committed): **`OWNER_BIRTHDATE`**
(e.g. `1981-09-05`) and **`MORTGAGE_START_BALANCE`** (e.g. `176702.19`); target = the month the owner
turns **50**. `projectMortgage` walks the real Home/`Mortgage` payments month-by-month
(`b = b·(1+r/12) − payment`). Those payments are **split by description**: the contractual
**regular** payment ("mortgage payment") vs the voluntary **extra** prepayment (the "customer
transfer" top-ups). The card surfaces them separately and, crucially, the **"Extra needed"** figure
is just the prepayment required *on top of the regular payment* (`requiredMonthly − regularPayment`),
not the total — so the owner sees exactly what to set their extra payment to. The chart shows the
balance line vs a straight **pace** line to $0 by 50, an on-track/behind badge, and (when behind) the
extra bump to add. "Update balance" records a
`balance` entry and **back-solves the implied annual rate** (`inferRate`, bisection) from the prior
snapshot + payments since, sharpening the next projection.

### Net-zero recovery goal (`kind = 'netzero'`)
A persistent, **multi-year** tracker for "get the year's net back to zero", distinct from the
`/budget` planner (which is forward-looking and resets each year with no memory of shortfalls).
Its **value = cumulative net (income − spend) from its start year through the anchor month**, using
the same definition as the Income/Budget `ytdNet` (`netOverRange` in `app/actions/goals.ts`:
income-flow summed, positive expenses summed, refunds/payments/transfers excluded). Negative = still
in the red. Because it's cumulative, the **Dec 31 → Jan 1 rollover is automatic** — a year-end
deficit simply carries into next year's running total (the card shows "this year net" + "carried
over").
- **Start:** the owner creates it via a dashboard-of-goals CTA that appears only when the current
  calendar year's net is negative and no net-zero goal exists yet (`suggestNetZero`). Tracking
  starts Jan 1 of the anchor year (stored in `targetDate`).
- **Reconcile** (`reconcileNetZeroGoals`, run on every import and Goals-page load, idempotent):
  value ≥ 0 → **congratulate via push + auto-archive**; an archived goal whose *current* year has
  slipped negative again → **auto-revive**, re-anchoring the start to this year (last year's debt was
  cleared). So it self-manages forever after the first creation.
- The value is computed, not from `goal_entries` — there's no Add money / Adjust; the card is
  read-only with a link to `/budget` to plan the gap.

### Notifications (immediate, per goal)
When a goal with `notify` on changes value (`addContribution`, `spendFromGoal`, `adjustValue`,
`updateMortgageBalance`, or a `resolveTransferReview` allocation), an immediate Web Push fires via
`sendPushToAll` (reusing the digest's subscriptions) showing the new value + signed %/$ delta;
mortgage uses a ⬇ "closer to payoff" framing. No new endpoint or table.

Run after pulling this change: `npm run db:push` (adds `goals`, `goal_entries`, `transfer_reviews`).
The goal-spend feature adds `transfer_reviews.direction` and a `Goal Spend` income category — rerun
`npm run db:push && npm run db:seed`.

## 11. Demo mode (read-only showcase)

The login page has an **"Explore the demo"** button (`enterDemo`, `app/actions/auth.ts`) that
starts a session **with no password**. It mints the normal signed session cookie but with a
`demo: true` flag in the payload (`app/lib/session.ts`), so it authenticates for navigation like
any session. `isDemoSession()` (`app/lib/demo.ts`) reads that flag.

- **All data is synthetic.** Every read path branches on `isDemoSession()` and returns the
  fabricated dataset in `app/lib/demo-data.ts` instead of touching the database — so a visitor
  never sees real numbers. The data is generated deterministically (seeded PRNG) from one
  canonical set of transactions/merchants/categories, so every page is internally consistent.
  Branch points: `loadAllFlows` (covers Overview/Trends/Income/Budget/Custom/Settings),
  `getBudgetSettings`, `loadProjectionRules`, `loadGoalsData`, `loadPendingReviews`, and the
  direct table reads in each page (dashboard, budget, settings, activity, merchants, categories,
  custom).
- **Read-only.** Every mutating Server Action calls `requireAuth()` first, which **throws** for a
  demo session — so one check blocks all writes. Read loaders never call `requireAuth`, so demo
  reads work. A sticky amber banner (`app/components/DemoBanner.tsx`, rendered from the root
  layout) says editing is disabled and offers "Exit demo" (logout).
- The synthetic dataset is committed (safe — it's all made up). When adding a new page/loader,
  add an `isDemoSession()` branch so it doesn't fall through to real data.

## 12. Emergency Fund (Goals page card)

Tracks the owner's **emergency funds** across three accounts: the two chequing accounts
(Tangerine + Scotia) plus a manual **low-risk investment**. Pure math in `app/lib/emergency.ts`,
server actions/loaders in `app/actions/emergency.ts`, UI in `app/components/EmergencyFund.tsx`
(rendered on `/goals`). State is one table, `account_snapshots` (id, `source` ∈ {tangerine, scotia,
investment}, absolute `balance`, `occurred_at`, note) — the same ABSOLUTE-snapshot model the
mortgage uses. Sources are listed in `ACCOUNT_SOURCES` with an `autoTracked` flag.

- **Seed + self-tracking:** the first snapshot per account is the owner-entered **starting
  balance**; thereafter the balance updates from imported bank flows. **Current balance** = latest
  snapshot + Σ of real bank flows since it (`balanceAsOf`). **Fund total** = Σ over all accounts.
- **Same-day boundary (causality, not date alone):** a flow dated on the snapshot's *own* day counts
  only if it was imported **after** the snapshot was recorded (`flow.createdAt > snapshot.createdAt`).
  So a transfer imported the same day you seed/enter a balance still moves the fund, while a manual
  correction you type *after* a transfer is already imported does **not** double-subtract it. Both
  `transactions` and `account_snapshots` carry `createdAt`; ties on the same day pick the latest-
  recorded snapshot as the base.
- **Manual `investment` source:** a low-risk holding the system can't see in any CSV
  (`autoTracked: false`). It has **no bank flows**, so `balanceAsOf` naturally returns just its last
  snapshot — the owner updates it manually when it changes (same "update balance" control, tagged
  *manual* in the UI). No special-casing in the math; `loadBankFlows` only queries the two banks.
- **Manual correction:** "Update balance" just inserts a newer absolute snapshot, which re-anchors
  and absorbs any drift (like `updateMortgageBalance`). No relevant interest is modelled (these are
  chequing accounts).
- **Which flows move the fund:** `loadBankFlows()` queries `transactions` **directly** (not
  `loadAllFlows`, which drops card payments) for `source ∈ {tangerine, scotia}` AND `external_id NOT
  LIKE 'goal:%'`. Real cash delta per row = **`-amount`** (bank amounts are stored negated). So a
  Scotia payment toward a card, or an investment transfer out, **lowers** the fund; salary/deposits
  **raise** it. Synthetic goal moves (`goal:%`) are excluded — no real cash moved.
- **Interaction with goals / 50/30/20 (owner scenarios):**
  - Move $900 savings → investment: the real Scotia "customer transfer" row **lowers the fund**
    automatically; tagging it to a goal makes it an `Investment` expense → counts as **Savings**.
  - Add $900 to a goal as an `asExpense` deposit **without moving money**: creates an `Investment`
    expense (counts as **Savings**) but its `goal:%` external id is **excluded** from `loadBankFlows`,
    so the **fund is unchanged**.
- **History chart:** `historySeries` gives the month-end fund total from the first snapshot month,
  rendered with `LineChart` to help decide when to move surplus cash into investments.

Run after pulling this change: `npm run db:push` (adds `account_snapshots`).

## 13. Emergency-fund runway (dashboard card)

A dashboard card paired with the 50/30/20 rule (half-width each) answering **"how many months
would the emergency fund last if income stopped?"** — against the owner's **9-month** target
(the common rule of thumb is 3–6 months; this household aims higher).
Pure math in `app/lib/runway.ts` (`computeRunwayInputs` + `buildScenarios`), client widget
`app/components/charts/RunwayWidget.tsx`, fund total from `loadEmergencyFund()` (§12).

- **Monthly burn** = recent **Needs + Wants** spend (the 50/30/20 consumption buckets),
  averaged over the most recent **complete** months (default 6; the in-progress anchor month is
  excluded). Investing/Savings and **extra mortgage prepayment** are assumed **paused** in an
  emergency, so they're excluded. Travel is tracked separately so the widget's **"Exclude trips"**
  checkbox can drop it (a discretionary cut). This window is independent of the dashboard period
  selector — it's a stable monthly figure.
- **Salary split** matches the Income page: `Salary` category, **Tangerine = self**, **Scotia =
  partner** (display names from `SELF_NAME` / `PARTNER_NAME`). Non-salary income (family support,
  benefits, …; excludes Goal Spend) is assumed to **continue**.
- **Scenarios** (`buildScenarios`): runway = `fund / max(0, burn − remainingIncome)`:
  - **No salary — self** → remaining = partner salary + other income.
  - **No salary — partner** → remaining = self salary + other income.
  - (Both losing pay at once is omitted — treated as not a realistic case.)
  - When remaining income ≥ burn the runway is **∞** (income covers expenses).
- **Available cash** (the fund the runway divides by) = emergency-fund total (§12) **−
  outstanding credit-card balance** (`loadOutstandingCardBalance`: net of all master/amex rows —
  charges +, payments/refunds −, clamped ≥ 0). A big recent card purchase (e.g. a $10k car) drops
  the runway immediately, before the statement is even paid; paying it later just moves the money
  from "card balance due" to a real bank outflow, so available cash — and the runway — stay
  consistent. This nets out **only in the runway**; the Emergency Fund card (§12) is unaffected.
- **Visual:** one bar per scenario on a fixed months axis with a **9-month target green zone** and
  ticks at 6 & 9; the fill is colored red (< 6), amber (6–9) or green (≥ 9 / ∞).
- **Headroom to target** (`headroomToTarget`): for the **worst single-earner case** (the *higher*
  earner losing their job — shortest runway), `targetCash = 9 × worstNetBurn`; if available cash
  exceeds it the surplus is **"move-out" headroom**, otherwise the gap is **"add to reach 9 months."**
  Recomputed live as the exclude-trips toggle changes the burn.
- **Runway trend** (`runway_snapshots`, `recordAndLoadRunwayHistory`): the worst-case runway is
  recorded **once per day it changes**, starting the first day the dashboard is viewed (no
  back-fill), via the write-during-load pattern (`ensureMortgageGoal`-style). `RunwayHistoryChart`
  plots it with a dashed 9-month target line, the line/area in the **current** status color and each
  dot in its own status color (green/amber/red). `months` is null = ∞ (plotted at the top).

## 14. "Safe to move" cash-flow tool (bottom half of the Emergency runway card)

The Emergency runway card is split vertically: the runway (§13, a *job-loss* horizon) stays on top
and a **"safe to move"** tool sits below it, answering a different question — *for each chequing
bank, how much cash can I move to investment today without dipping below a comfort buffer before my
next pay?* Pure math in `app/lib/cashflow.ts`, loader/actions in `app/actions/cashflow.ts`, client
widget `app/components/charts/SafeToMoveWidget.tsx` (rendered inside the dashboard's Emergency
runway `Card`, after `RunwayWidget`). State is one singleton table, `cashflow_config`.

- **The trough model** (`projectAccount`): build a forward calendar of scheduled events per account
  (income +, bills/CC payment −), walk a **45-day** window day-by-day from today, and take the
  **lowest running balance** (the trough). `safeToMove = max(0, trough − buffer)`. The day-of-month
  variation falls out naturally — less is movable before bills hit, more right after payday. The
  function is pure so the **client recomputes it live** as the owner edits the inputs.
- **Schedule = inferred, then editable** (`inferSchedule` + `applyOverrides`):
  - **Income** — `Salary` + other income-kind deposits (reimbursements excluded), split by the bank
    they land in (Tangerine/Scotia), typical day = median day-of-month, amount = recent-month
    average. Needs ≥ 2 months of signal.
  - **Bills** — bank-paid recurring merchants: the fixed **Home** category, projection-rule
    merchants (§8c), or any `isRecurring` bank-sourced merchant. Account = the bank they post from,
    day = median, cadence inferred from month-gaps (so quarterly Water lands every 3rd month),
    amount via `projectedAmountForMonth` when a rule exists else the recent-month average. Card-paid
    merchants are **skipped** — they're already inside the CC balance.
  - **CC payment** — one event per card for its **current outstanding balance**
    (`loadOutstandingByCard`, the unpaid-cycle sum split per card), routed to whichever bank pays it
    (`cardAccounts` mapping, **default both cards → Tangerine**), on the owner's **`ccPaymentDay`**
    (default the **11th** — the owner pays both cards the same day; the most important date to be
    covered for). Plus a **pending-charges cushion** (`ccPendingBuffer`, default **$400** combined)
    added on the payment day, split across the paying accounts, because charges still *pending* on a
    card haven't exported to CSV yet so the outstanding figure understates the real payment. Each CC
    event fires **once** in the window (next cycle's charges are unknown).
- **Owner edits persist** in `cashflow_config` (singleton): per-account `buffers` (fixed $ cushion),
  `cardAccounts` (card→bank), `ccPaymentDay` (int) + `ccPendingBuffer` (the card-payment day &
  pending cushion above), per-event `overrides` (`dayOfMonth`/`amount`/`account`/`enabled`), and
  `unplannedExpense`. Inference is always the default; overrides only correct it. The editor
  round-trips them via `saveCashflowConfig` (blocked in demo by `requireAuth`).
- **Info "i"** — a toggle in the widget header (`InfoPanel`) explains, in plain language, exactly how
  each figure is derived (the trough model, money in/out, the card payment day, the pending cushion,
  buffer, unplanned expense, and stale-bill dropping) so the number is never a black box.
- **Unplanned expense** — a manual "big expense before my next card payment" input (account +
  amount) applied as a one-time outflow; it drops the affected bank's safe-to-move figure live.
  Persisted so it survives reload, with a "clear" control. Philosophy: approximate + a safety
  buffer, and reversible — if a month surprises you, move the cash back from investment.
- **Demo:** `demoCashflowPlan()` returns a synthetic two-account schedule so the card renders for
  visitors; edits are blocked.

Run after pulling this change: `npm run db:push` (adds `cashflow_config`).

## 15. Projects (`/projects`)

Answers "how much did one real-world thing cost?" — a trip ("UK 2026"), a renovation, a
wedding — by **grouping arbitrary transactions**, independent of categories. State is two
tables (`db/schema.ts`): `projects` (name, emoji, color, optional `cover_image_url`,
`start_date`/`end_date`, notes, sortOrder, archived) and `project_transactions` (a
many-to-many join, unique on `(project, transaction)`, cascade on either delete). Logic/loaders
+ actions are in `app/actions/projects.ts`; pages `app/projects/page.tsx` (grid of cards) and
`app/projects/[id]/page.tsx` (detail); UI `ProjectsManager.tsx` + `ProjectDetail.tsx`.

- **Pure overlay (no AI).** Membership never recategorizes a transaction or changes its `flow`,
  so spend analytics, Budget, Income and the runway are **untouched**. A transaction can belong
  to more than one project. Removing it from a project never alters the transaction. All
  categorization here is deterministic — there is no LLM anywhere in the app.
- **Project total** = Σ member `amount` (refunds net normally; payments aren't added). The detail
  page breaks the total down **by effective category** and **by who paid** (`cardholderName`, §4b),
  and lists the member transactions with a per-row "✕ Remove".
- **Cover photo** lives in **Vercel Blob** (`@vercel/blob`): `setProjectCover` `put()`s the file
  and stores only the public URL on `projects.cover_image_url`; replacing/removing `del()`s the old
  blob. Needs `BLOB_READ_WRITE_TOKEN` in the environment (create a Blob store in Vercel). Without
  it, cover upload errors but every other part of the feature works.
- **Adding members** — the Activity page (`/transactions`) has a **Select** mode: checkboxes →
  a sticky bar → pick an existing project (or type a new name) → `addTransactionsToProject`. Rows
  already in a project show a small project badge. (`loadProjectsForPicker` +
  `loadProjectMemberships` feed this.)
- **"Suggested — review"** (`loadProjectCandidates`): transactions inside the project's
  `[start,end]` window whose `country` is **unknown** (Amex/bank rows carry no country code, so we
  can't prove they were foreign), excluding payments and any txn that already has a membership row
  (member *or* dismissed). The owner **Adds** the ones that belong or **Dismisses** the rest
  (per-row or "Dismiss all"). Dismiss writes a `dismissed = true` tombstone row so the txn never
  reappears here; Adding it later flips it back to a real member. This is the manual safety net for
  the country-data gap below.

### Auto-fill (trip mode)

An optional setting on a project (`projects.auto_fill ∈ {self, partner, both, null}`) that
auto-populates credit-card transactions for the chosen cardholder(s) within the project's
`[start_date, end_date]` window. Only **master/amex** (credit card) sources are included —
bank rows are left for the existing "Suggested — review" path. Card ownership is determined
from `PARTNER_CARDS` in `.env.local` (the same mapping as the cardholder badge on Activity).

Two destinations:
- **Auto-added** (`needsReview = false`) — transactions that are NOT effectively recurring (i.e.
  `coalesce(txn.is_recurring, merchant.default_recurring, false) = false`). These appear
  immediately in the project member list and count toward the total.
- **Auto-filled — needs review** (`needsReview = true`) — effectively recurring transactions
  (bill-like: subscriptions, Koodo, insurance, etc.). Shown in a separate "needs review" section
  above "Suggested — review". The owner **Adds** (flips `needsReview → false`) or **Dismisses**
  them.

`project_transactions.needs_review = true` rows are excluded from the project total, member list,
and Activity badges — they are staging, not confirmed members.

Auto-fill runs automatically on project creation (if dates + auto_fill are set) and can be
re-triggered via **"Refresh auto-fill"** on the detail page to pick up new transactions imported
since the last fill. It is idempotent: uses `onConflictDoNothing` so existing user decisions
(manual adds, dismissals, approvals) are never overwritten.

`loadProjectMemberships` (Activity badges) excludes `needsReview = true` rows so the badge only
appears once the owner confirms the transaction belongs to the project.

### First project — UK 2026 (one-time deterministic seed, since removed)
The "UK 2026" project (2–12 Apr 2026) was bootstrapped once by a throwaway script
(`scripts/seed-uk-2026.ts`, deleted after it ran — future projects are made in the UI). It
applied these deterministic rules; recorded here so the membership is explainable:
1. **Air Canada** flights bought in **Feb 2026** (the May Air Canada charges are a *different*
   trip — excluded).
2. **Airbnb** charged **Mar 1 → Apr 12** (after Feb, capped at the trip end so a later Airbnb for
   the other trip is left out).
3. **Foreign spend in the window (Apr 2–12)**: `country` present and **≠ `CAN`** (codes are
   ISO-3). In-Canada rows (e.g. Ontario camping) are excluded automatically.

> **Country-data caveat:** `country` is only populated for **Master/Rogers** card rows (from
> "Merchant Country Code"). **Amex and bank rows have no country**, so foreign Amex/bank spend in
> the window is **not** auto-added — it surfaces in "Suggested — review" for manual confirmation.

- **Demo:** `demoProjects()` / `demoProjectDetail()` (`app/lib/demo-data.ts`) return a synthetic
  "Italy 2025" project so the feature renders for visitors; writes are blocked by `requireAuth`.

Run after pulling this change: `npm install` (adds `@vercel/blob`) and `npm run db:push` (adds
`projects`, `project_transactions`).

## 16. Investments (`/investments`)

Tracks the owner's **registered brokerage accounts at iTrade** — a TFSA, a RESP, later a second
TFSA (the partner's) — answering three questions a single institution never answers together:
*how much is it worth (in CAD)?*, *how much TFSA room is left right now?*, and *how much free
government grant is still on the table this year?* It is a **deterministic overlay** on the
existing transfer/goal machinery — **no live prices, no trading feed, no AI**. Page
`app/investments/page.tsx`, client UI `app/components/InvestmentsManager.tsx`, server
actions/loaders `app/actions/investments.ts`, pure math in `app/lib/tfsa.ts`, `app/lib/resp.ts`,
`app/lib/holdings.ts`, FX in `app/lib/fx.ts`.

### Tables (`db/schema.ts`)
- **`registered_accounts`** — `kind ∈ {tfsa, resp, rrsp, fhsa, nonreg}`, `name`, `owner ∈
  {self, partner}` (default `self`, so a future partner account is distinct — display names from
  `SELF_NAME`/`PARTNER_NAME`, never committed), `brokerageAccountNo` (the iTrade number from the
  CSV filename), `currency`. TFSA carries a `roomBaselineAmount` + `roomBaselineDate`; RESP carries
  `beneficiaryBirthYear`, `grantBaselineReceived`, `contributionBaseline`, `grantCarryForward`.
- **`holding_snapshots`** — one CSV import per account at a point in time: `occurredAt`, the
  `fxUsdCad` rate **used and stored** (so the CAD total stays reproducible), and a denormalized
  `totalValueCad` (drives the value-over-time trend). `holding_positions` are its rows (symbol,
  asset class, currency, quantity, book/market value native **and** in CAD, all-time change %/$).
- **`registered_contributions`** — the ledger behind room/grant. `kind ∈ {contribution,
  withdrawal}`, positive `amount`, `occurredAt`, and `transactionId` (**unique**) set when the row
  came from tagging an imported transfer (idempotent), null for a manual entry.

### Contribution room & grant are DERIVED, never stored
Tagging a transfer instantly recalculates everything; the number is always at least as current as
CRA's (which only updates after you file).
- **TFSA** (`computeTfsaRoom`): `room = CRA baseline + Σ annual limits since the baseline year −
  Σ contributions on/after the baseline date + withdrawals already returned`. The owner enters the
  **CRA-confirmed "room as of Jan 1"** as the baseline (e.g. `$23,756 @ 2026-01-01`) so tagged
  transfers never double-count prior years. Federal annual limits are a constant table
  (`TFSA_ANNUAL_LIMITS`, 2009–2026; a future year falls back to the latest known and is flagged
  *estimated*). Two CRA rules are enforced as warnings: **(1)** a withdrawal's room only returns on
  **Jan 1 of the next year** (same-year withdrawals are surfaced as `withdrawalsPendingReturn`, not
  added back); **(2)** re-contributing it the same year is an **over-contribution** (1%/month
  penalty) unless there's other room. `room < 0` → over-contribution warning.
- **RESP / CESG** (`computeRespGrant`): 20% match, **$500/yr** on the first $2,500 (up to
  **$1,000/yr** with one year of carry-forward), **$7,200** lifetime grant, **$50,000** lifetime
  contribution cap, grant paid through the year the child turns **17**. The headline output is the
  actionable one — *"deposit $X more before Dec 31 to capture $Y in free CESG grant"*
  (`roomToMaxGrantThisYear` / `freeGrantAvailableThisYear`). `grantBaselineReceived` /
  `contributionBaseline` are the totals before tracking started (for the lifetime caps).

### Holdings import (FX-normalized, deterministic value)
Per account, the owner uploads the iTrade **portfolio CSV** (`parseHoldings`, header `Security
name,Symbol,…,Market value ($)` — distinct from the transaction statements in `app/lib/csv.ts`).
**USD positions** (e.g. QQQ, KWEB) are converted to CAD with a single **USD→CAD rate**: an explicit
override wins, else the **live Bank of Canada Valet rate** (`fetchUsdCadRate`, key-less, cached 1h),
else the previous snapshot's rate, else 1 — and the rate is **stored on the snapshot**. So summing
a mixed-currency portfolio is always a correct single CAD figure, and historical snapshots never
drift. An FX fetch failure never blocks an import.

### Contributions come from tagging transfers (the loop-closer)
The existing dashboard **transfer-review** (§10) already queues every Scotia→iTrade transfer (the
recurring $900 and lump sums). It now also asks **"which registered account?"** on the outbound
"counts as investment" treatments; choosing TFSA/RESP writes a `registered_contributions` row via
`recordTransferContribution` (`resolveTransferReview` `registeredAccountId`). This is a **pure
overlay** — it never changes the transaction's `flow`/category, so spend analytics, the Goals
system and the 50/30/20 savings bucket are untouched; it only feeds the room/grant math. Manual
contributions (for deposits the bank import missed) can be added on the account's Contributions tab.

### Monthly holdings auto-sync (iTrade)
A **monthly** launchd job (`sync/run-itrade.{ts,sh}`, `com.budget.sync.itrade.plist`, the **25th**
at 11:30) downloads each account's iTrade portfolio CSV and refreshes its holdings snapshot — the
holdings analogue of the daily transaction syncs (AUTO_SYNC_PLAN.md). It **reuses the Scotia login**
(same adapter + Keychain creds + device trust, its own browser profile `itrade`), then for each
account opens its iTrade overview page, clicks **Download CSV**, and POSTs the export to the
token-authed **`/api/ingest-holdings?account=<brokerage#>`** → `ingestHoldings` (the same parse/FX/
snapshot path as the manual upload). The account list — **URLs are account-identifying, so NOT
committed** — lives in `sync/itrade.accounts.json` (gitignored; template
`sync/itrade.accounts.example.json`). Failure handling matches the other syncs **at the runner
level** — a macOS notification, a failure screenshot, and the wrapper's 4× retry — but it is
deliberately **not** wired into the dashboard's daily-staleness banner (the 3-day threshold would
false-alarm a once-a-month job). Holdings move slowly, so monthly is enough; re-running adds a fresh
snapshot (the value-over-time trend), it does not dedup like transactions. **The deployed app must
have this code + `INGEST_TOKEN` for the sync to ingest in prod (deploy required).**

### Privacy / demo
`owner` and display names keep real names out of the repo (env only). `*.csv` and
`sync/itrade.accounts.json` are gitignored, so the brokerage exports and account URLs never land in
git. `loadInvestmentsData` branches on `isDemoSession()` to `demoInvestmentsData()` (a synthetic
TFSA + RESP run through the same pure engines); every mutation calls `requireAuth`, so demo is
read-only.

Run after pulling this change: `npm run db:push` (adds `registered_accounts`, `holding_snapshots`,
`holding_positions`, `registered_contributions`).
