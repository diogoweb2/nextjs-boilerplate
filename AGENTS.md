<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Family Budget app

This repo is a private family budgeting app built on the boilerplate. Before changing
import parsing, merchant normalization, categorization, analytics, or insights, read
[`BUSINESS_RULES.md`](./BUSINESS_RULES.md) — it is the source of truth for how data flows
and how the "learning" merchant/category rules behave. Keep that doc in sync with changes.

Global search: every page, tab and titled section must be findable from the nav search
box. When you add a page/tab or a new `<Card title="...">` section, add an entry (with
keywords) to `app/lib/search-index.ts` — anchors are auto-derived from the card title.

Privacy: the repo is **public**. Never store cardholder names or addresses, and keep all
routes behind the existing auth (`proxy.ts`). Statement CSVs are gitignored (`*.csv`).
