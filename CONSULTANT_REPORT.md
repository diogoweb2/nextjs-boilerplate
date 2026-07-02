# Consultant Report — Feature Roadmap vs. the Best Budget Apps

**Prepared for:** Family Budget app (private, 1 household, 2 active users, no multi-user needed)
**Benchmarked against:** Monarch Money, YNAB, Quicken Simplifi, PocketSmith, EveryDollar, Goodbudget
**Date:** 2026-07-01
**Scope:** Product suggestions only — no implementation detail, no technical design.
**Constraints respected:** fully deterministic (no AI/LLM), single household, public repo privacy rules.

---

## 1. Executive summary

The app is **not behind the market** — in several areas it is ahead of every commercial product:

| Area | Your app | Best-in-market equivalent |
|---|---|---|
| Deterministic merchant "learning" rules | ✅ editable, retroactive | Monarch/Simplifi use ML you can't inspect |
| Year-end-net budget cap + auto-balance | ✅ | No app does this (YNAB is month-scoped) |
| Safe-to-move cash trough model | ✅ | Simplifi's projected cash flow, but yours is more actionable |
| Emergency runway w/ job-loss scenarios | ✅ | Nobody ships this |
| TFSA room / RESP CESG grant math | ✅ | Nobody (Canadian tools included) |
| Monthly recap ("80s report") for the low-patience partner | ✅ | Monarch's monthly review, but yours is better targeted |

The gaps are mostly in three themes the big apps have converged on:

1. **Envelope mechanics** — carryover/rollover of category budgets (YNAB & Goodbudget's core idea). Your budget resets its meaning each month; overspend/underspend has no memory except the year-end cap.
2. **Time-axis visibility** — a bills/recurring **calendar** and a long-range **forecast with what-if scenarios** (PocketSmith's core idea; Monarch/Simplifi have lighter versions).
3. **Transaction ergonomics** — notes, receipt attachments, free-form tags, expected-refund tracking, powerful search (Monarch/Simplifi table stakes).

**Top 5 by weighted score:** Reimbursement tracker → Bills & recurring calendar → Category rollover → Subscription price-creep watchdog → Year-in-review report.

---

## 2. Scoring method

Each suggestion is weighted:

- **Impact (1–5):** how much it improves *this household's* decisions or reduces friction. Family-of-4, two active users, data arrives via automated CSV sync.
- **Fit (1–5):** how naturally it builds on what exists (data model, deterministic philosophy, existing pages).
- **Effort (1–5, lower is better):** rough build size, judged as a product consultant, not an estimate.
- **Score = Impact × 2 + Fit − Effort.** (Impact dominates; fit rewards leverage; effort penalizes.)

Tiers: **A (score ≥ 9)** do soon · **B (6–8)** strong candidates · **C (3–5)** nice-to-have · **D (< 3)** skip / not for you.

---

## 3. Tier A — Do soon

### A1. Reimbursement / expected-refund tracker — *inspired by Quicken Simplifi's Refund Tracker* — **Score 11** (Impact 5, Fit 4, Effort 3)

You already net reimbursements against categories (dental insurance, goal spends), but nothing tracks **money you're owed that hasn't arrived**. Simplifi's refund tracker is loved precisely because "did the insurance ever pay us back?" is otherwise unanswerable.

- Flag a transaction (or a split part) as **"reimbursement expected"** with an expected amount.
- When a matching credit lands (same category, income-flow), offer to link it and mark settled.
- A small dashboard card: *"Outstanding: $612 — Dental claim (23 days), Amazon return (6 days)"* with a nag when something ages past ~30 days.
- Ties directly into your existing dental-coverage <80% warning and `is_special` reimbursable flag — this is the missing lifecycle for both.

**Why #1:** for a family with dental/health claims, returns, and work-expense floats, this recovers *real dollars* — the only suggestion on this list with direct cash ROI.

### A2. Bills & recurring calendar — *inspired by Monarch's Recurring page and Simplifi's Bills calendar* — **Score 10** (Impact 4, Fit 5, Effort 3)

You have all the ingredients (projection rules, cadences, inferred bill days, the safe-to-move schedule) but no **calendar view**. Every major app ships one because "what's hitting this month and when?" is the single most-asked household question.

- A month-grid calendar: each projected bill/subscription on its expected day, paydays marked, the CC-payment day highlighted.
- Status per item: paid (actual matched) / due / **missed** (expected but never posted — your subscription-check insight, but visual and per-bill).
- Deep-link each item to the merchant.
- This is largely a **new lens over existing data** — the projection engine and inferred schedule already compute everything the calendar needs.

### A3. Category rollover (envelope carryover) — *the core of YNAB and Goodbudget* — **Score 9** (Impact 4, Fit 4, Effort 3)

Your monthly goals reset each month (with seasonal auto-adopt), and only the year-end cap remembers history. Envelope carryover is the one behavioral mechanic YNAB users refuse to give up:

- Per category, an opt-in **"rolls over"** flag: underspend adds to next month's goal, overspend subtracts (or must be "covered" from another category — YNAB's overspend workflow).
- Best applied selectively: **Kids, Travel, Clothing, gifts** — lumpy categories where "we didn't spend it in June so we have it for July camp" is exactly how you already think.
- Complements (doesn't replace) your year-end-net model: rollover handles intra-year lumpiness per category; the cap still governs the total.
- Skip full zero-based enforcement (EveryDollar) — your surplus-allocation prompt already gives every *surplus* dollar a job, which is the part that matters.

### A4. Subscription & bill price-creep watchdog — *inspired by Monarch's bill-increase alerts (and Rocket Money's core pitch)* — **Score 9** (Impact 4, Fit 4, Effort 3)

Fully deterministic and high-value: recurring merchants whose amount **changed** vs. their trailing norm.

- Insight card + push: *"Netflix charged $20.99, was $16.99 (+23%). Koodo up $5/mo → $60/yr."*
- Annualize the delta — that's what makes people act.
- A "subscriptions" summary view: every recurring merchant, current price, price history sparkline, total monthly subscription load, last-seen date (your existing "didn't appear this period" check folds in here).
- You already detect recurring merchants and amount variance for projection rules; this reuses that signal as an *alert* instead of a forecast.

---

## 4. Tier B — Strong candidates

### B1. Year in Review — *inspired by Monarch's Year in Review / "Spotify Wrapped" trend* — **Score 8** (Impact 3, Fit 5, Effort 2)

You already built the monthly 80s recap and it's the perfect chassis. A January special edition: total in/out, net vs. last year, category winners/losers, top 10 merchants, best/worst month, no-spend days, goals funded, mortgage principal killed, TFSA/RESP contributed, grade for the year. High delight, very low lift, great for the two-user dynamic (it's *shareable at the dinner table*).

### B2. Long-range forecast & what-if scenarios — *PocketSmith's flagship* — **Score 7** (Impact 4, Fit 3, Effort 4)

PocketSmith projects your balance years ahead from recurring items and lets you overlay scenarios. You have the pieces (income averages, projected bills, budget cap, mortgage projection) but only within-month (safe-to-move) or within-year (net trajectory) horizons.

- A 1–3 year projected net-worth / cash line from current schedule + budget.
- Deterministic what-if toggles: *"partner drops to 80% hours"*, *"replace a car: −$25k in March"*, *"stop extra mortgage payments"* — each redrawing the line and the mortgage-payoff date.
- Recommendation: start with **2–3 hardcoded scenario levers** relevant to you, not a generic scenario builder.

### B3. Transaction notes + receipt photos — *Monarch/Goodbudget table stakes* — **Score 7** (Impact 3, Fit 4, Effort 3)

A free-text note and an optional photo attachment per transaction (you already have Vercel Blob wired for project covers). The killer family use case: warranty receipts, "this was for the school fundraiser", "half owed by grandma" (pairs with A1). Low glamour, permanent value.

### B4. Free-form tags — *Monarch's tags* — **Score 6** (Impact 3, Fit 4, Effort 4)

Projects cover the big "trip/reno" case, but tags cover the small cross-cutting ones: `#tax-deductible`, `#kid1` vs `#kid2`, `#gift`, `#work-reimbursable`. Filterable on Activity, usable as a Custom-report line source. Consider it a lighter sibling of Projects sharing the same overlay philosophy. If Projects grow a "quick tag" mode instead, that's an acceptable substitute.

### B5. Mid-month category pace alerts — *YNAB/Monarch overspend notifications* — **Score 6** (Impact 3, Fit 4, Effort 4)

You compute run-rate projections already (auto-balance §8b) and have push infrastructure. Alert only on **projected month-end overshoot of a goal by >X%** for discretionary categories, folded into the existing daily digest (not separate pushes — respect notification fatigue). Groceries pacing 30% hot on the 12th is actionable; finding out on the 31st is not.

---

## 5. Tier C — Nice to have

### C1. Cash-flow Sankey diagram — *Monarch's most-screenshotted feature* — **Score 5** (Impact 2, Fit 4, Effort 3)
Income sources → buckets → categories, one flowing picture per period. Pure visualization over data you have. Great "one screen explains everything" artifact for the partner conversation; adds no new decisions.

### C2. Fast transaction search — *Simplifi's global search, scoped down* — **Score 5** (Impact 3, Fit 4, Effort 5)
Instant substring search across description/merchant/note/amount on Activity ("what was that $84 charge?"). Scope it to one good search box, not a global command palette.

### C3. Savings-goal target-date math — *YNAB targets, Monarch goals* — **Score 5** (Impact 2, Fit 5, Effort 4)
Goals have optional `targetAmount`/`targetDate` but (mortgage aside) don't answer *"am I on pace, and what monthly contribution gets me there?"*. Add the pace line + "needed/mo" figure to savings goal cards — the same treatment the mortgage card already gets. Feeds the auto-contribute defaults.

### C4. Per-child spending lens — *no app does this well; your family shape justifies it* — **Score 4** (Impact 2, Fit 3, Effort 3)
With tags (B4) as `#kid1`/`#kid2`, a small "Kids" report: per-child totals, camps/activities/clothing split, YoY. Only worth it after B4 exists.

### C5. Data export & annual archive — **Score 4** (Impact 2, Fit 4, Effort 2 → but low urgency)
One-click CSV/JSON export of enriched transactions (effective category, merchant, flags) per year. Insurance against your own future migrations; also useful for taxes. Every incumbent has export; you currently only have import.

---

## 6. Tier D — Deliberately skip (anti-recommendations)

| Market feature | Who has it | Why skip for you |
|---|---|---|
| Bank aggregation (Plaid/Finicity) | Monarch, Simplifi, YNAB | Your launchd CSV syncs already automate ingestion without handing credentials to an aggregator; Canadian coverage is flaky anyway. |
| AI categorization / AI assistant chat | Monarch, Copilot | Explicitly against the app's philosophy; your rules engine is more trustworthy and teachable. |
| Multi-user accounts, roles, shared workspaces | Monarch (household sharing) | Two people behind one master password is your stated model; the recap + demo mode cover the second user. |
| Full zero-based budgeting ceremony | YNAB, EveryDollar | Your surplus allocation + auto-balanced monthly plan achieves the outcome without the monthly ritual tax. |
| Debt-payoff planners (snowball/avalanche) | EveryDollar, Simplifi | Your only debt is the mortgage, which already has a superior dedicated projection. |
| Credit score monitoring, offers, "ways to save" marketplaces | Simplifi, Rocket Money | Monetization features, not budgeting features. |
| Investment holdings performance analytics (TWRR, benchmarks) | Monarch, PocketSmith | Snapshot-based tracking answers your three questions (value, room, grant); performance analytics belongs in the brokerage. |

---

## 7. Suggested sequencing

1. **A1 Reimbursement tracker** — direct cash recovery, closes an existing half-built loop.
2. **A2 Bills calendar** — biggest visibility win per unit of new data (none).
3. **A4 Price-creep watchdog** — quick, reuses recurring detection, immediate savings.
4. **A3 Category rollover** — the one behavioral mechanic; do it after the calendar so lumpy bills are already visible.
5. **B1 Year in Review** — build in December, ship January 1.
6. Then B2/B3/B4 as appetite allows; C-tier opportunistically.

---

## 8. Closing note

The market's genuinely differentiated ideas — YNAB's envelopes, PocketSmith's calendar+forecast, Simplifi's refund tracker, Monarch's recurring management — are all **deterministic** features, which is why this roadmap needs no compromise on the no-AI rule. Everything else the incumbents sell (aggregation, AI, social, marketplaces) is either solved better by your sync pipeline or irrelevant to a single-household tool. The app's moat is that it answers *your family's* questions; the A-tier list simply adds the four questions it can't answer yet: *"who still owes us money?"*, *"what's hitting this month?"*, *"can June's leftover pay for July's camp?"*, and *"which bills quietly got more expensive?"*
