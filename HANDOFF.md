# CHS Hub — Session Handoff

> **For Tony:** Open Cursor on `~/projects/chs-hub`, start a brand new chat, and paste the contents of this file as your first message. Then say _"Read HANDOFF.md and confirm you're caught up. I want to work on **&lt;X&gt;** today."_

> **For the next AI session:** **`CHS-Session-Handoff.md`** (maintained outside this repo) is the **canonical planning doc** — priorities, sprint queue, operator decisions. **`HANDOFF.md`** (this file) is the **repo-side code-state reference** — what shipped, what's deployed, migration tags, local dev URLs. Keep both aligned; when they conflict, **`CHS-Session-Handoff.md` wins on planning**; **`HANDOFF.md` wins on what's actually in git/production**. Code state as of **May 31, 2026** (Sprint 9 deployed). Trust this over any older context in this file below the Sprint 9 section. All work since the migration playbook (archived at `docs/archive/migration-playbook.md`) has happened in this repo, `chs-hub`.

> **Note on coverage:** Sprint 9 (invoices + payments) is recorded in full below. **Sprint 8** (photo capture, receipts, smart notes, daily logs — commit `75e95e3`, tag `v0.8.0-sprint8*`) shipped between Sprint 7 and Sprint 9 but is **not yet written up in this file** — see git history / its deploy runbook until backfilled.

### Shipped — Sprint 11 (Jun 1, 2026) — Cost-Plus Billing Engine

**Tags:** `v0.11.0-sprint11` (code on `main`), `v0.11.0-sprint11-deployed` (production infra). Feature commit **`8e3b099`** (`feat(sprint11): cost-plus billing engine — cycles, mini-budget, reconciliation, credit carry-forward, final 50/50`).

**Production:** Worker version **`46132dd6`** at Sprint 11 deploy (later **`0afedbb3-ec2b-4379-9d96-ac98b59c0032`** after the mobile capture-bar hotfix below) on `https://chs-hub.tony-bc5.workers.dev` + `dashboard.homesolutionsar.com` + `client.homesolutionsar.com`. Migration **`migrations/0034_cost_plus_billing.sql`** applied remote by **direct execute** (NOT `migrations apply` — same unrecorded-ledger reason as prior sprints). It is a single additive, non-destructive index: `idx_invoices_cost_plus_cycle ON invoices(cost_plus_cycle_id)` (no new tables/columns — the cost-plus schema already existed). Backup before migrate: **`backup_pre_sprint11_remote_20260601.sql`** (local, gitignored) + R2 **`chs-backups/`**. Rollback tag if needed: **`v0.10.0-sprint10-deployed`** (0034 is index-only and harmless to the Sprint 10 Worker). **Stripe stays test mode**; **notifications still SIMULATE**.

**The single most important fact:** cost-plus jobs now bill in **bi-weekly cycles** — each cycle has a **mini-budget** (projected materials/labor/subs) that drives an **upfront invoice** (reusing the Sprint 9 invoice create→send path), then at cycle close a **reconciliation** compares projected vs. **actual** costs (via the Sprint 10 `computeJobActuals(jobId, {from,to})` helper, the single source of truth) to produce a signed **delta** that **carries forward** as a credit/overage into the next cycle. The **final cycle** bills 50% upfront / 50% at completion and nets the final reconciliation. All money math lives in `src/lib/cost-plus.ts`; it does **not** fork the Sprint 9 invoice logic — it wraps it.

**Verified in production:**
- Backend deploy healthy; `/app` 200, job costing + pipeline endpoints 200; clean cost-plus slate (no orphan cycles).
- `0034` index present on `invoices(cost_plus_cycle_id)`.
- **⭐ Sprint 8 gate re-cleared in prod** (was the open verification item carried into this session): smart-note → task ✅, smart-note → expense ✅, and **receipt capture → AI extraction → confirm → linked expense ✅** — confirmed expense **Lowe's $121.09**, `receipt_photos.processing_status='confirmed'`, `expense_id` ↔ `receipt_photo_id` linked, created `2026-06-01T14:16:19Z` via the Sprint 10 `insertFullExpense` path.

**Mobile capture-bar hotfix found + fixed (this session):** the **Quick Capture bar** (📷 Photo / 💵 Receipt, `frontend/src/views/jobs/QuickCaptureBar.tsx`) was rendered but **invisible on mobile** — it and the global app nav (`.bottom-tabs`) were both `position:fixed; bottom:0`, and the nav's `z-index: var(--z-capture-bar)` (**500**) painted over the capture bar's `z-index: 40`. This blocked **all** mobile users from the photo/receipt capture flow, not just verification. Fix (`frontend/src/styles/app.css` + `JobDetail.tsx`): capture bar now stacks **above** the nav (`bottom: var(--capture-bar-height)`), z-index raised to `calc(var(--z-capture-bar) + 1)`, breakpoint aligned to `767px`, and a `.job-detail` bottom-padding reserve so content clears both stacked bars. Deployed in version `0afedbb3`. **Carry-forward:** audit for any other `position:fixed; bottom:0` element that could collide with `.bottom-tabs`.

**Key new files:** `src/lib/cost-plus.ts` (fee/credit/reconcile math, `periodActuals`, `buildReconciliationReport`), `src/routes/billing-cycles.ts` (cycle CRUD + `generate-invoice`/`reconcile`/`bill-final` handlers, wrapping Sprint 9 invoices), `frontend/src/views/jobs/CycleManager.tsx` (cycle UI in the Financial tab), `migrations/0034_cost_plus_billing.sql`. Extended (not forked): `src/index.ts` (cycle routes), `frontend/src/views/jobs/FinancialTab.tsx` (conditionally renders `CycleManager` for `cost_plus` jobs), `src/lib/invoicing.ts` (`INVOICE_TYPES` adds `cost_plus_cycle`). **Local seed (gitignored):** `scripts/dev-seed-sprint11.local.sql` (two cost-plus jobs: under/over budget + credit carry-forward + final 50/50).

**Still pending — need a logged-in browser:**
- Full Cycle Manager browser walkthrough on a cost-plus job: create cycle → generate upfront invoice → reconcile → verify credit carry-forward into the next cycle → final-cycle 50/50 bill-final. Backend + guards smoke-tested locally; in-prod UI walkthrough not yet logged.

### Shipped — Sprint 9 (May 31, 2026) — Invoice Generation & Basic Payments

**Tags:** `v0.9.0-sprint9` (code on `main`), `v0.9.0-sprint9-deployed` (production infra). Deploy commit **`a86f215`** (`fix(sprint9): fold invoice billing into nightly cron`); feature commit `1fc5b0d`.

**Production:** Worker version **`26895297-bdb4-4c51-99f2-2216ebf0e05a`** on `https://chs-hub.tony-bc5.workers.dev` + `dashboard.homesolutionsar.com`. Migration **`migrations/0032_invoices_payments.sql`** applied remote by **direct execute** (NOT `migrations apply` — same unrecorded-ledger reason as prior sprints). Backup before migrate: **`backup_pre_sprint9_remote_20260531.sql`** (local, gitignored) + R2 **`chs-backups/`**. Rollback tag if needed: **`v0.8.0-sprint8-deployed`** (0032's added columns + UNIQUE indexes are additive and harmless to the Sprint 8 Worker). **Stripe stays test mode** (live-key swap is Pre-Launch); **notifications still SIMULATE**.

**The single most important fact:** invoices generate, payments collect (Stripe **test-mode** + manual), late fees accrue, and reverse-conversion exists — but it's all **owner-facing**: no real client messaging (engine still `NOTIFICATIONS_DISPATCH_MODE="simulate"`) and no live card processing (Stripe test keys).

**Verified in production:**
- Health 40/40 tables; `0032` columns (`invoices.payment_token`/`viewed_date`, `jobs.conversion_reversed`/`reversal_reason`/`reversed_at`) + four UNIQUE indexes (`idx_jobs_job_number`, `idx_invoices_invoice_number`, `idx_invoices_payment_token`, partial `idx_payments_stripe_payment_id`) + `invoice_sent` email+sms templates all live.
- **Static-asset manifest healthy:** `/app/` → 200, `/app/index.html` → 307 redirect (correct trailing-slash behavior), `/api/public/pay/bogus` → 404 JSON.
- **Zero duplicate** `job_number` / `invoice_number` on remote — the UNIQUE-index pre-check (runbook Step 3) is clean.
- **Invoice create→send loop exercised in browser:** invoices **#1 ($66)** + **#2 ($68)**, both `sent`, both carry a `payment_token`, due `2026-06-07`. Atomic numbering sequential (1, 2). `invoice_sent` email+sms logs show `status='sent'` = SIMULATE (no real send).
- **Legacy data shape:** ~120 invoice rows all `invoice_number=NULL` (clean slate for native numbering); 158 payment rows all legacy Jobber import (1 has a `stripe_payment_id`); 6 `past_due` invoices are all legacy (`invoice_number=NULL`, `total_due=NULL`) — **skipped by the billing cron, correctly**.

**Still pending — need a logged-in browser on `dashboard.homesolutionsar.com` (Access injects auth; can't be driven by curl):**
- Record manual payment → `paid` + `payment_received` queued (SIMULATE). `payment_received` logs are currently **empty** — the payment side of the loop is unexercised on native invoices.
- `/pay/:token` render in-browser (invoices #1/#2 have tokens; **use the `workers.dev` host** until the custom domain is live — the generated `APP_PUBLIC_ORIGIN` link is still NXDOMAIN, see carry-forward).
- Void (Owner) + close-gate `409 unpaid_invoices`.
- Reverse-conversion on a **disposable** test job only (NOT #100). Zero `conversion_reversed=1` rows — not exercised.

**Cron status:**
- Billing cron is **folded into the `15 7 * * *` nightly run** (02:15 Central) because the Cloudflare **Free plan caps at 5 cron triggers**. There is **no standalone `0 8 * * *`**. Live crons: `*/15`, `*/30`, `15 * * * *`, `15 7 * * *`, `0 12 * * *` (commit `a86f215`).
- Runtime proof (`--test-scheduled`): late fee `0 → $500` (10×$50), `total_due 1500 → 2000`, `invoice_past_due` SMS enqueued SIMULATE; log `late_fees updated=1; due_check past_due_notices=1`.
- The next real `15 7 * * *` tick is the **first live proof against native invoices** — re-run the past-due data query after that tick to close this item.
- Legacy-invoice skip is intended (billing skips rows with NULL `invoice_number` / NULL `total_due`). **Cursor to add an explicit `WHERE invoice_number IS NOT NULL` guard** so this is intentional code, not accidental NULL behavior.

**Deploy bug found + fixed (this deploy):** a prior deploy shipped a **stale static-asset manifest** — the dashboard SPA 404'd ("page won't load") while the Worker reported success. Fixed by re-running `npm run deploy` (manifest rebuilt, 65 files). A post-deploy smoke check (`curl /app/index.html` + `/app/` expecting 200) is now in the runbook (Step 6 + Done Criteria + carry-forward) and is **standard for all future runbooks**.

**Key new files:** `src/lib/invoicing.ts` (money rules, status recompute, suggestions, `runLateFeeCalculator`/`runInvoiceDueCheck` → combined `runInvoiceBilling`), `src/routes/invoices.ts`, `src/routes/payments.ts`, `src/routes/public-pay.ts`, `frontend/src/views/jobs/FinancialTab.tsx`, `frontend/src/views/public/PayPage.tsx`, `frontend/{pay.html,src/pay-main.tsx}`, `migrations/0032_invoices_payments.sql`. Extended (not forked): `src/routes/public-quote.ts` (Stripe webhook now branches invoice-payment + reversal vs the untouched deposit→conversion path), `src/lib/quote-to-job.ts` (`reverseJobConversion` + atomic `job_number`), `src/lib/notification-engine.ts` (`triggerInvoiceSent`), `src/index.ts` / `wrangler.toml` (billing in nightly cron, `/pay/:token` asset serving). **Local seed (gitignored):** `scripts/dev-seed-sprint9.local.sql`.

### Carry-forwards (Sprint 9 → next work / Pre-Launch)

**Also record these in `CHS-Session-Handoff.md`** — keep planning and code-state in sync.

1. **🔴 `APP_PUBLIC_ORIGIN` / public custom domain — UNRESOLVED; customer-facing links are currently dead.** `APP_PUBLIC_ORIGIN=https://chs-hub.homesolutionsar.com` is **NXDOMAIN** (no DNS, no route — only `dashboard.homesolutionsar.com` is configured), so every generated pay/quote link 404s at the network level. Needs, in order: **hostname decision** (candidates `pay.homesolutionsar.com` or `portal.homesolutionsar.com`) → DNS record → `custom_domain` route in `wrangler.toml` → **host-aware Worker routing guard** (Option A: on the public host the Worker 404s everything except `/pay`, `/quote`, and the public API endpoints — so `/app` + authenticated writes stay off the public host) → update `APP_PUBLIC_ORIGIN`. Hotfix prompt pending the hostname decision. Until then, test `/pay/:token` via the `workers.dev` host.
2. **Reverse-conversion accounting — DECIDE BEFORE STRIPE LIVE-KEY SWAP.** As built, reverse-conversion voids **all** non-void invoices including **paid** ones while preserving payment rows → cash-collected can exceed invoiced (books mismatch). Pre-Launch: (a) a refund/chargeback should post a **negative/refund payment** that nets the original, not just void; (b) reversal should be **reason-aware** (an NSF on Draw 2 shouldn't void a cleared, possibly non-refundable deposit). Not a deploy blocker (won't fire in normal test-mode use).
3. **Surface `conversion_reversed` in `handleJobDetail`.** The DB flag is set correctly but the job-detail API/UI doesn't return/show it, so a reversed job still looks active and could be re-invoiced. Small add (return the three fields + optional banner) — prevents a real foot-gun.
4. **Explicit `WHERE invoice_number IS NOT NULL` guard in the billing cron (Cursor).** Make the legacy-row skip intentional code, not incidental NULL behavior.
5. **Confirm the late-fee `due_date` anchor against the Service / Cost-Plus Agreement** before any live late-fee collection (default = `sent + 7 days`; grace lives in the due date). Flagged in `invoicing.ts`.
6. **Notifications live-flip trigger:** Resend domain verified + `NOTIFICATIONS_EMAIL_FROM` set unlocks **live email** (receipts/reminders) independently of SMS (SMS has the longer 10DLC tail). Both still SIMULATE — intentional.
7. **Stripe still test mode (intentional, Pre-Launch).** Confirm the **test-mode** webhook subscribes `charge.refunded` + `charge.dispute.created` (only the automatic refund/dispute → reverse-conversion path needs them; manual reverse + invoice payment work without). Live-key swap gated on Arkansas attorney contract review.
8. **Global "Financial" sidebar item stays grayed / "coming soon."** Sprint 9 delivered the **per-job** Financial tab (Job → Financial), not a cross-job AR dashboard. The top-level `/financial` route is a `Placeholder` (`nav.ts` `enabled:false`). A cross-job AR/aging dashboard is a later sprint and depends on Sprint 10 expense data.
9. **Post-deploy static-asset smoke check is now standard** — fold `curl /app/index.html` + `/app/` (expect 200; re-deploy on 404) into every future runbook's Step 6, plus `/pay`/`/quote` once the public host exists. Nuance: multiple rapid deploys in a single session can drop /app/* from the asset manifest even when wrangler reports 'no updated assets' — always run the /app/index.html check after the final deploy of a session, not just the first.
10. **`payment_token` = per-invoice random token** (generated at create, reused on send), independent of the job `portal_token`; the Sprint 12 client-portal invoices tab is separate work.

### Shipped — Sprint 7 (May 30, 2026) — Notification Engine & Communications

**Tags:** `v0.7.0-sprint7` (code on `main`), `v0.7.0-sprint7-deployed` (production infra).

**Production:** Worker version **`d88e5e1e-cf31-4994-9bea-6a2d7beeeb4d`** on `https://chs-hub.tony-bc5.workers.dev` + `dashboard.homesolutionsar.com`. Migration **`migrations/0030_notifications.sql`** applied remote by **direct execute** (NOT `migrations apply` — the remote `d1_migrations` ledger only records 0001–0013; 0014–0030 are physically applied but unrecorded, so `migrations apply` would re-run old migrations and crash on duplicate columns). Backup before migrate: **`backup_pre_sprint7_remote_20260530.sql`** (local, gitignored) + R2 **`chs-backups/`**. Rollback tag if needed: **`v0.6.0-sprint6-deployed`**.

**The single most important fact:** the engine deploys in **simulate mode** and sends **nothing** to real clients until Pre-Launch. Gate = env var **`NOTIFICATIONS_DISPATCH_MODE`** in `wrangler.toml [vars]` (currently **`"simulate"`**). **Only the exact value `"live"` enables real dispatch**; anything else simulates. Simulated sends are logged `status='sent'`, `external_id='simulated:<uuid>'`, no external API touched. **The `*/15 * * * *` "Notification Processor" cron is now a LIVE production behavior** — it drains queued `notification_logs` every 15 min; in simulate it logs but never sends.

**What works in production now (all simulating):**
- **Notification engine** (`src/lib/notification-engine.ts`): trigger → template lookup → merge-field render → enqueue (`notification_logs`) → `*/15` cron drain → channel dispatch → auto-log to `communications`. Business rules enforced **at send time**: quote follow-up stop-conditions (won/lost/approved re-checked in `dispatchRow`, suppressed not sent), transactional-vs-marketing opt-out, SMS rate limit 5/client/day (6th **defers** to next morning, stays queued), exponential backoff retries (1m/5m/30m) then dead-letter, idempotent enqueue via `dedupe_key` UNIQUE index (no double-send on webhook redelivery).
- **Wired triggers** (their source events exist): `lead_created`, `appointment_confirmed`, `appointment_reminder`, `estimate_sent`, `quote_follow_up_1/2`, `quote_expiring`, `deposit_received`, `welcome_portal`, `work_starting`.
- **Seam-only triggers** (catalog rows + no-op TODO seams, wired when source modules land): `sub_scheduled` (Sprint 13), payment/invoice events (Sprint 9), `weekly_photo_summary` (Sprint 8), push (Sprint 18).
- **Inbound Twilio webhooks** — PUBLIC routes (bypass Access), Twilio-signature-verified (Stripe-grade HMAC): `POST /api/webhooks/twilio/inbound` (match client → log comm → owner bell) + `/status` (delivery callback updates the log). Verified in prod: unsigned request is **rejected** (currently `503 twilio_not_configured` since no token yet; becomes `403 invalid_signature` once creds land), never Access-redirected, never accepted, no DB write. **Stripe webhook untouched** (`400 invalid_signature` as before).
- **APIs:** `/api/notification-templates` (owner: list-by-phase / edit / preview / test-to-owner), `/api/notification-logs` (owner: filter + retry), `/api/notifications/inbox` + `/:id/read` + `/read-all` (per-user in-app), `GET /api/jobs/:id/communications` (job-scoped timeline).
- **Frontend:** Notification Settings (template editor by phase, preview, "test to me") + Log viewer (filters, retry) under **Settings → Notifications** (owner-only); in-app **notification bell** in TopNav (30s poll, unread badge, deep-link); communication timeline with channel icons on **client detail** and **job detail → Activity tab**, both with a **"+ Log"** button (manual log attributed to client, and job when logged from the job).

**Design decision:** in-app notifications are **`notification_logs` rows** (`channel='in_app'`), not a separate table — one source of truth for bell + timeline + log. The generic `tmpl-system-alert` template gives engine-generated owner alerts a valid `template_id`.

**Key new files:** `src/lib/notification-engine.ts`, `src/lib/twilio.ts`, `src/routes/notifications.ts`, `src/routes/webhooks-twilio.ts`, `frontend/src/views/notifications/{NotificationSettings,NotificationLogs}.tsx`, `frontend/src/components/layout/NotificationBell.tsx`. **Local seed (gitignored):** `scripts/dev-seed-sprint7.local.sql` (seeds a client/lead/job, 4 communications, one `notification_logs` row per status, one unread owner in-app alert; idempotent).

### Carry-forwards (Sprint 7 → next work / Pre-Launch)

**Also record these in `CHS-Session-Handoff.md`** — keep planning and code-state in sync.

1. **✅ Email dispatch double-gate (FIXED — trailing patch on `v0.7.0-sprint7-deployed`).** The client-notification email path in `sendByChannel` (`src/lib/notification-engine.ts`) now uses **`NOTIFICATIONS_EMAIL_FROM` only** — the `ALERT_EMAIL_FROM` fallback was removed *from this path* so client email **simulates** until that secret exists. The owner-facing daily-summary / system-alert path (`src/lib/ops/notify.ts`) still uses `ALERT_EMAIL_FROM` and is untouched. End state, as documented: client email sends only when `NOTIFICATIONS_DISPATCH_MODE="live"` **AND** `NOTIFICATIONS_EMAIL_FROM` is set **AND** `RESEND_DRY_RUN != "1"`. (Verified: test-to-owner email now simulates.)
2. **Pre-Launch graduations (flip together, after final template-copy review):** provision **Twilio** account + number, set `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM_NUMBER` secrets, **register inbound + status webhook URLs** in Twilio console (`…/api/webhooks/twilio/inbound` and `/status` — routes already deployed + signature-gated, just nothing points at them); set **`NOTIFICATIONS_EMAIL_FROM`** secret + verify domain; then **flip `NOTIFICATIONS_DISPATCH_MODE` to `"live"`**. Add STOP/opt-out language to SMS templates for compliance.
3. **Template versioning deferred** (spec §6.9) — editing a template updates it in place; no message-history-at-send-time. Revisit if needed.
4. **Future scheduled sends reuse the same `*/15` cron + engine** — Sprint 8 (weekly photo summary), Sprint 9 (payment receipts, invoice reminders/past-due) plug into the dormant TODO seams; they do **not** add new crons.

### Shipped — Sprint 5 (May 30, 2026) — Quote Delivery & Client Approval

**Tags:** `v0.5.0-sprint5` (code on `main`), `v0.5.0-sprint5-deployed` (production infra).

**Production:** Worker version **`b8ee7a83-b733-4993-898e-14bded5e4c01`** on `https://chs-hub.tony-bc5.workers.dev` + `dashboard.homesolutionsar.com`. Migration **`migrations/0028_quote_delivery.sql`** applied remote (new: `estimates.viewed_date`, `estimates.approved_date`, `estimates.contract_text`, `payments.estimate_id`, `idx_estimates_portal_token`). Backup before migrate: **`backup_pre_sprint5_remote_20260530.sql`** (local, gitignored) + R2 **`chs-backups/`**. Rollback tag if needed: **`v0.4.0-sprint4-deployed`**.

**What works in production now:**
- Public client quote page **`/quote/:token`** — standalone, no Cloudflare Access (verified: HTML serves; bogus token loads page, not login wall).
- Public API **`/api/public/quote/*`** and Stripe webhook **`/api/webhooks/stripe`** — unauthenticated, Access-bypass verified (404 JSON / 400 signature, not Access redirect).
- Authenticated app: send quote (freezes contract + portal link), Mark Lost, Revise, client progress (viewed/signed/paid), copyable link.
- Client flow in prod: **view → sign → pay by check** (mailing instructions, intent logged, does **not** auto-convert).
- Stripe deposit path is **deployed but not configured** — no `STRIPE_*` Worker secrets yet; card pay gracefully falls back to check instructions (same as local without keys).

**Local dev URLs (Sprint 5 — do not mix these up):**
- **Internal app (auth writes):** `http://localhost:5173/app/` — Vite dev server; proxies `/api` → `:8787` and injects **`Cf-Access-Authenticated-User-Email: tony@homesolutionsar.com`** so guarded writes work. **Do not use `:8787/app` for builder/send/lost/revise** — those POSTs 401 without Access.
- **Client portal (no auth):** `http://localhost:8787/quote/:token` — Worker serves built **`public/app/quote.html`**. Vite (`:5173`) does **not** serve `/quote/*` (its `base` is `/app/`).
- **Dashboard:** `http://localhost:8787/` → legacy CHS COMMAND shell.

**Local seed (gitignored):** `scripts/dev-seed-sprint5.local.sql`. Test tokens: **`sprint5seedtokenpublicquote000000001`** (already approved from E2E test), **`sprint5seedtokenpublicquote000000002`** (clean sent — full sign → pay flow).

**Key new files:** `src/routes/public-quote.ts`, `src/lib/stripe.ts`, `src/lib/contracts.ts`, `frontend/src/views/public/QuotePage.tsx`, `frontend/quote.html`. Deposit webhook calls the **same** `convertQuoteToJob()` as the manual Mark-as-Won modal (`src/lib/quote-to-job.ts`).

### Carry-forwards (Sprint 5 → next work)

**Also record these in `CHS-Session-Handoff.md`** — keep in sync; do not let planning and code-state diverge.

1. **Stripe production wiring (infra deployed; keys not set)** — When ready: `npx wrangler secret put STRIPE_SECRET_KEY`, **`STRIPE_PUBLISHABLE_KEY`** (required for Stripe.js Elements — runbook Step 4 omitted this; code reads `env.STRIPE_PUBLISHABLE_KEY` or `system_settings.stripe_publishable_key`), register webhook at `https://chs-hub.tony-bc5.workers.dev/api/webhooks/stripe` subscribing to **`payment_intent.succeeded` only**, then `npx wrangler secret put STRIPE_WEBHOOK_SECRET` + **`npm run deploy`**. Recommended: **test keys first** (`sk_test_…`), full prod E2E with card `4242…`, then live keys only after attorney contract review. Deploy runbook: **`CHS-Sprint-5-Remote-Deploy.md`**.

2. **Google Reviews bulk import — not built in Sprint 5** — Out of scope; Sprint 5 uses manual **`saved_reviews`** (Sprint 4). Bulk import from Google still carries forward to a future sprint. Confirm scope in **`CHS-Session-Handoff.md`** before starting.

3. **KBPI quotes-sent cutover — due Sprint 6** — Deferred twice. Native sends log via `triggerQuoteSent` (Sprint 4); WC KBPI still reads Jobber `quotes` in **`src/lib/wc/compute.ts`**. Sprint 6 should implement date-boundary cutover (native on/after cutover date + Jobber before — never both). Pick cutover date in planning doc before coding.

4. **Contract legal review — blocking real client use** — Contracts render from embedded TS strings in **`src/lib/contracts.ts`** (not parsed `.docx` at runtime). Service vs cost-plus auto-selected by billing model. Rendered text includes "pending legal review" — **Arkansas attorney must review before any real client signs and pays a live deposit.** Live Stripe keys + unreviewed contracts = do not send to real clients.

**Sprint 6 prep (from Sprint 5 report — detail in `CHS-Session-Handoff.md`):** extend **`convertQuoteToJob()`** for full conversion depth (task groups, budget baseline, billing activation, portal activation); confirm job entry status **`deposit_paid`**; check-deposit Won stays manual after funds clear.

**Dev ergonomics (optional, not blocking):** wire **`quote.html`** under Vite dev for hot-reload on the public quote page styling (production path unchanged).

### Next session — do in this order (Tony + agent)

1. **Confirm production Worker** — After **May 11** changes: **`npm run deploy`** so **`[limits]`** (`cpu_ms`, `subrequests`) and Drive stub batch = **4** are live. Inspect **`sync_log`** / **`npm run tail`** after **`*/30`** or manual **`POST /api/sync/jobber`** (Jobber attachments, throttle retries, no **`Exceeded CPU Limit`** / **`Too many subrequests`** storm).
2. **Drive mirror** — **`docs/drive-mirror-resume.md`**: new **SITE PHOTOS / PROJECT FILES** paths; stub queue drains **4 jobs/hour** from empty-tree pass (raise batch later if needed and limits allow).
3. **Jobber financial PDFs** — GraphiQL → real PDF/signed URL → implement **`financial-pdfs-ingest.ts`** (`contracts` / `pay_stub`).

**⚠️ PENDING REMOTE (run during the next remote/deploy step):** The owner user was seeded with the wrong last name (`Whitaker`). It's been fixed on **local D1** and in the seed sources (`migrations/0024_seed_data.sql`, `docs/CHS-Seed-Data.md`), but the **remote** `users` row still says Whitaker (the seed `UPDATE` uses `COALESCE`, so re-running the migration will NOT overwrite it). Run this once against remote:

```bash
npx wrangler d1 execute chs-hub-db --remote \
  --command "UPDATE users SET last_name = 'Columbus', name = 'Tony Columbus' WHERE email = 'tony@homesolutionsar.com';"
```

**Local dev:** Start the Worker with **`npm run dev`** (or bare `wrangler dev` — both work now). All served web assets live under **`public/`** (`public/dashboard/`, `public/docs/`, `public/index.html`, `public/README.md`, and the Vite build output `public/app/`), and `wrangler.toml` sets **`[assets] directory = "./public"`**. Scoping the assets root to `public/` keeps `.wrangler/state` (local D1 sqlite) out of the dev asset-watcher's tree, which is what previously caused the endless "Reloading local server" loop (the watcher has no ignore list and ignores `.assetsignore`). Local D1 lives in the default `.wrangler/state`; use **`npm run db:migrate:local`** / **`npm run db:execute:local "<sql>"`**. Frontend dev server (with `/api` proxy): **`npm --prefix frontend run dev`**; the Preact build emits to `public/app` via `npm --prefix frontend run build`.

**Done (May 2026) — do not re-queue:** **Gmail quick link** — Dashboard tile uses **`gmailQuickLink`** in **`dashboard/index.html`** (optional **`localStorage`** key **`chs_gmail_quick_url`** for a custom **`https://`** inbox URL). **Verified working** (opens Gmail) May 2026.

**Also done (May 2026):** Dashboard **Connect Google** — **Google Identity Services** token client, scopes **Calendar (readonly)** + **Tasks** only; **`DASHBOARD_OAUTH_CLIENT_ID`** in **`wrangler.toml` `[vars]`** (must match **Web application** Client ID in Google Cloud **exactly**). Legacy browser **Sheets** reads removed; KPIs = **`/api/kpis`**, notes = **`/api/notes`**. See **`docs/google-oauth-dashboard.md`** and **Recently fixed — Dashboard OAuth, Sheets cleanup & header (May 2026)** below.

**Also done (May 2026):** **Hub Files** (`/files`, **`dashboard/files.html`**) — **Upload from computer** via the sidebar: **job project files** (`POST /api/job-files`), **company documents**, and **on-site photos** (image file picker). List + Explorer browse, shareable links when **`FILE_LINK_SECRET`** is set.

### Shipped — evening **May 11, 2026** (Jobber attachments, Hub Files tree, Drive mirror, Worker limits)

- **Jobber → Hub note attachments:** GraphQL uses **`JobNote.fileAttachments`** and **`JobNoteFile`** fields **`id` / `fileName` / `url`** (not `noteAttachments` / `name` / `mimeType`). Downloads → R2 → **`job_files`** (`source = jobber`, **`jobber_attachment_id`**). **`src/lib/jobber/job-files-ingest.ts`**, **`queries.ts`**, **`sync.ts`** (`jobber_job_files_written`, **`upsertJob`** passes token). Cron log includes **`jobber_full: … jobber files …`** (`src/index.ts`).
- **Jobber client:** Throttle retries now match **message** **“Throttled”**, not only `extensions.code`; more retries + backoff; **~450ms** pause between GraphQL pages (`src/lib/jobber/client.ts`, **`sync.ts`**).
- **Hub Files / Capture:** Job folders drop **Issue, Marketing, Safety, Incident** (photos) and **Miscellaneous** (project files). API: **`photos`** categories = **before | progress | final**; **`job_files`** uploads no longer accept **`other`** (legacy rows still list). **Capture PWA** category grid matches (**`dashboard/capture/index.html`**).
- **Drive mirror:** Per-job layout under **`Jobs/<year>/<client>/<#N title>/`** now uses **`SITE PHOTOS/`** (Before, Progress, Final) and **`PROJECT FILES/`** (hub-aligned subfolders). Job-linked **expense receipts** → **Project receipts**. **`mirrorJobFolderStubsBatch`** = **4 jobs/run** to avoid **“Too many subrequests”** during bursts (`src/lib/ops/drive-mirror.ts`).
- **`wrangler.toml` `[limits]`:** **`subrequests = 10000`**, **`cpu_ms = 300000`** (5 min CPU cap) — addresses **drive_mirror** subrequest errors and **`*/30` cron `Exceeded CPU Limit`** during heavy **Jobber + WC** runs. **Requires deploy**; limits apply per account usage model (see Cloudflare docs).
- **Docs:** **`docs/drive-mirror-resume.md`** updated for new tree + Jobber PDF caveat; **`docs/ops-post-session-checklist.md`** — ops steps after a long sync.
- **Jobber quote/invoice PDFs → contracts / pay_stub:** **`src/lib/jobber/financial-pdfs-ingest.ts`** is a **stub** — **`previewUrl`** removed from API; needs **GraphiQL**-confirmed PDF URL field before wiring.

**Still to verify after deploy (Tony):** **`npm run deploy`**, optional **`SYNC_TRIGGER_SECRET`** rotation if exposed, **`POST …/api/sync/jobber`** on **`*.workers.dev`**, check **`sync_log`** / **`npm run tail`** (throttle lines OK; watch for CPU/subrequest errors). **Very long** interactive **`curl`** can hit **HTTP/proxy timeouts** at the edge even when the Worker is busy — if the client gives up, prefer **`*/30`** cron or rerun **`curl`**; confirm with **`sync_log`** what finished.

**Optional Access polish is deliberately last** — see the final bullet under **Backlog** (global session is already **30 days**).

### Recently fixed — Dashboard OAuth, Sheets cleanup & header (May 2026)

- **Removed legacy dashboard → Google Sheets usage in the browser:** Job Tracker / WC KPI ranges / Smart Notes tab reads and related **`sheets.googleapis.com`** calls were deleted from **`dashboard/index.html`**. **Business Pulse + KPI tiles** use **`window.chsFetchKpis` → `GET /api/kpis`** (D1/Jobber path). **Smart Notes** use **`/api/notes`** (D1). Server-side **WC workbook export** (`src/lib/wc/sync.ts` + service account) is unchanged.
- **Worker injection:** **`src/lib/dashboard-inject.ts`** only replaces **`%%OAUTH_CLIENT_ID%%`** from **`DASHBOARD_OAUTH_CLIENT_ID`**. Removed optional env bindings **`DASHBOARD_GOOGLE_API_KEY`**, **`JOB_TRACKER_SHEET_ID`**, **`WC_SHEET_ID`** from **`src/env.ts`** (dashboard no longer uses them). **`wrangler deploy`** should carry **`DASHBOARD_OAUTH_CLIENT_ID`** in **`wrangler.toml` `[vars]`** so production never injects an empty client ID.
- **OAuth flow:** **Google Identity Services** (`accounts.google.com/gsi/client`, **`initTokenClient`** / popup). Scopes: **`calendar.readonly`** + **`tasks`** only (no Gmail/Sheets browser scopes; **Drive** removed from OAuth for simpler consent — **meeting import from Drive** stays **403** until **`drive.readonly`** is re-added after verification). **`loadMeetingFile`** uses **`oauthToken`** (fixed broken **`chs_google_token`**).
- **Client ID:** **`401 invalid_client`** was a **wrong/mistyped** Web Client ID vs **`wrangler.toml`**; production ID must match **Google Cloud → chs-hub → Clients → Web application** character-for-character.
- **Cloudflare Access + PWA:** Service worker does **not** intercept **`manifest`** requests (avoids Access redirect → CORS → bogus **503**). **`dashboard/sw.js`** cache id evolves with fixes (**`chs-dashboard-v8`** as of May 2026).
- **Header UX:** OAuth control stays **32×32**; connected = **green circle + ✓** (desktop + mobile shell).
- **FOUC:** **`theme.css`** sets **`html`** background + **`color-scheme: dark`**; critical inline dark **`html`/`body`** before **`theme.css`** on main dashboard pages (see **Backlog**).
- **Health:** **`GET /health`** includes **`dashboard_oauth_client_id_configured`** (boolean).

### Recently fixed — dashboard “Sync Now” (May 2026)

The dashboard **Sync Now** / **`POST /api/sync/now`** path was failing for many Cloudflare Access setups (**401**) because the Worker only checked **`Cf-Access-Authenticated-User-Email`**, while Access often sends **`Cf-Access-Jwt-Assertion`** instead. **Fix:** `src/routes/sync.ts` now authorizes on **non-empty JWT assertion or email header** (or **`x-sync-token`** matching **`SYNC_TRIGGER_SECRET`**). Manual sync also runs **`syncWorkbook`** after Jobber→D1 so the WC Google Sheet updates immediately (same piggyback as the 30‑minute cron). **`dashboard/sw.js`** always uses the network for **`/api/*`** (no cache-first for API) and bumped cache id to **`chs-dashboard-v2`**. **`dashboard/jobs.html`** uses **`credentials: 'same-origin'`** on the sync fetch. **Ops:** deploy the Worker, hard-refresh the dashboard so the new service worker registers; if problems persist, inspect the **`/api/sync/now`** response in DevTools.

### Backlog — dashboard polish & reliability (later)

- **OAuth client ID hygiene** — Keep **`DASHBOARD_OAUTH_CLIENT_ID`** in **`wrangler.toml`** in sync with **Google Cloud → Clients → Web application** (copy/paste). After **`wrangler deploy`**, **View Source** should show the same **`*.apps.googleusercontent.com`**. Details: **`docs/google-oauth-dashboard.md`**.
- **Monthly revenue tile** — Often empty; **probably tied to data freshness / KPI fetch** (D1, `/api/kpis`); verify after a successful Jobber sync and WC server-side sync (see **Recently fixed — Sync Now** above).
- **Live KPI tiles + Business Pulse** — **Numbers not populating** (or stuck blank/spinners); investigate **`GET /api/kpis`**, D1 freshness after Jobber sync, dashboard **`chsFetchKpis`** / local cache, Cloudflare Access / SW interception.
- **Theme / CSS flash or missing styles** — Mitigated May 2026: `dashboard/theme.css` sets `html` background + `color-scheme: dark`; critical inline dark `html`/`body` in `index.html`, `jobs.html`, `notes.html`, `subs.html`, `files.html` before `theme.css` to cut white FOUC. Report if any route still flashes.
- **PDFs in the dashboard file system** — **Open / preview PDFs** from the hub file UI (inline viewer, new tab, or signed URL) instead of only download-or-unknown behavior.
- **Spreadsheet-native flows for docs** — **Open compatible files in Google Sheets** (or similar): upload/import path, “Open with…” link, or explicit export so operational docs aren’t stuck as opaque blobs in R2-only workflows.
- **External hard drive backup** — **Second-line backup** of the file corpus (and/or D1 export bundles) to a **local external drive** — operator-run script, scheduled Mac job, or documented rsync from existing R2/nightly NDJSON exports; complementary to cloud mirror + R2.
- **Bulk / Finder-centric upload (optional)** — **Multi-file or whole-folder** picks from the desktop (`<input webkitdirectory>` or multi-select), **open Finder** at a standard “inbox” folder, or a documented **Shortcuts / AppleScript** helper. *Basic single-file upload from computer is already on* **`/files`** *— this item is only for heavier drag-drop / bulk workflows.*
- **CHS Capture PWA** (`/capture/`) — **Test, harden, and clean up:** real-device QA (iOS install, multi-job uploads, offline/Background Sync drain, expense + voice flows), fix rough edges and duplicate/confusing UX, align with **`docs/01-file-system.md`** deferred items; see TL;DR **Photos system** / native expense **Remaining follow-up** for Jobber write-back gaps.
- **Social media product** — **Implement the planned social workflow** (monthly plan generation, dashboard surfacing, copy-to-Metricool handoff, later phases per **`docs/03-social-media.md`** and architecture **Session 8a+** in **`docs/00-architecture.md`**). Photos/PWA foundation is already in production; remaining blockers are mostly **product choices + API keys + build time**.
- **Cloudflare Access — optional polish (tackle last, after everything else)** — **Global session duration is already 30 days** (Tony; email/OTP re-auth at most about monthly unless cookies cleared or multi-device edge cases). **Defer:** add **Google** as an IdP if OTP alone is still annoying (separate from in-app **Connect Google**); revisit app/policy **session overrides**, cookie blockers, or a **crew-only** Access app for `/capture/*` (see TL;DR **Open decisions**).

---

## TL;DR — where we are

We are deep into **Phase 7** of the original migration playbook (the "dashboard rebuild" phase). What was originally going to be a separate `chs-automation` repo (Phase 6) got merged into this one, so `chs-hub` now contains:

- The Cloudflare Worker backend (Jobber sync + KPIs + drill routes + WC workbook auto-export + HighLevel proxy + Smart Notes API + Jobs API + Subcontractor API)
- The D1 database (jobs, invoices, line_items, payments, expenses, quotes, notes, subcontractors, sync_dead_letters)
- The static dashboard frontend (vanilla HTML/CSS/JS served from the **`chs-hub`** Worker as static assets at `dashboard.homesolutionsar.com`)
- The Cloudflare Pages docs site (`docs.homesolutionsar.com`)
- A reliability subsystem (heartbeat alerts, dead-letter queue, nightly D1→R2 backup, daily summary email — see "Reliability subsystem" below)

The dashboard is **live, in daily use, and stable**. The Jobber → D1 pipeline runs on a cron schedule, the WC Google Sheet auto-syncs every 30 minutes, HighLevel is wired through a server-side PIT proxy, and operational alerts go to `tony@homesolutionsar.com` via Resend.

---

## Current architecture

```
                        ┌─────────────────────────┐
                        │  Jobber GraphQL API     │
                        └────────────┬────────────┘
                                     │ poll (cron)
                                     ▼
┌──────────────────┐        ┌──────────────────┐
│ HighLevel CRM    │◄──────►│  Cloudflare      │
│ (services.lead-  │  proxy │  Worker          │
│  connectorhq)    │        │  (chs-hub)       │
└──────────────────┘        │                  │
                            │  ┌────────────┐  │
                            │  │  D1 (sql)  │  │
                            │  └────────────┘  │
                            └────┬─────────┬───┘
                                 │         │
                  every 30 min   │         │  every request
                                 ▼         ▼
                       ┌──────────────┐  ┌──────────────────────┐
                       │ Wealthy      │  │ Dashboard (HTML/CSS/ │
                       │ Contractor   │  │ JS via chs-hub       │
                       │ Google Sheet │  │ dashboard.homesol…   │
                       └──────────────┘  └──────────────────────┘

                       ┌──────────────────────┐
                       │ Claude (via existing │
                       │ chs-claude-proxy)    │
                       └──────────────────────┘
                              ▲
                              │ Smart Notes processing

                       ┌──────────────────────┐
                       │ Resend               │
                       │ alerts@send.homesol… │
                       └──────────────────────┘
                              ▲
                              │ ops emails (heartbeat,
                              │  DLQ, daily summary)
```

**Production URLs**
- Dashboard: `https://dashboard.homesolutionsar.com`
- Worker (raw, not behind Access): `https://chs-hub.tony-bc5.workers.dev`
- Docs: `https://docs.homesolutionsar.com`
- Wealthy Contractor Google Sheet: updated by **Worker cron / sync** (`src/lib/wc/sync.ts` + service account), **not** by the browser dashboard
- HighLevel location ID: `lZ8L8FAf6K2niuHoFbaw`
- Resend dashboard: `https://resend.com/domains` (sending domain `send.homesolutionsar.com`)

**Access control**
- Cloudflare Access protects `dashboard.homesolutionsar.com` — only `tony@homesolutionsar.com` is on the allowlist right now.
- The raw `*.workers.dev` URL is **not** behind Access — use this for `curl` testing.

---

## Repo layout (key files)

```
chs-hub/
├── HANDOFF.md ............................ this file
├── README.md
├── wrangler.toml ......................... Worker config (D1 binding, vars, cron)
├── package.json .......................... npm scripts (db:migrate:remote, deploy, tail, etc.)
├── public/ ............................... static-assets root (wrangler.toml [assets] directory = "./public")
│   ├── index.html ....................... docs viewer (fetches /README.md + /docs/*.md at runtime)
│   ├── README.md ........................ served copy for the docs viewer (repo-root README.md is the canonical source)
│   ├── docs/ ............................ all project docs/specs (served at /docs/*.md)
│   ├── app/ ............................. 🆕 Preact app build output (Vite), served at /app — gitignored, rebuilt
│   └── dashboard/
│       ├── theme.css ................... 🎨 brand source of truth (palette + base + page wash). Edit :root here to recolor everything.
│       ├── index.html .................. main dashboard (KPIs, quick launch, kanban)
│       ├── jobs.html ................... native Job Tracker
│       ├── notes.html .................. native Smart Notes
│       ├── subs.html ................... native Subcontractor Reference List
│       ├── manifest.json + sw.js ....... dashboard PWA basics ("CHS Command")
│       └── capture/ .................... 🆕 CHS Capture PWA (photos + voice notes)
│           ├── index.html .............. single-page shell (Home/Camera/Review/Voice/Switch/Pending)
│           ├── manifest.json ........... distinct icon, scope=/capture/, installed as separate PWA
│           ├── styles.css .............. mobile-first; pulls palette from /theme.css
│           ├── app.js ................. camera + canvas thumb + voice + queue UI
│           ├── queue.js ............... shared IndexedDB queue (loaded by both app.js and sw.js)
│           └── sw.js .................. service worker: drains queue on Background Sync / message
├── frontend/ ............................ Preact app SOURCE (Vite); builds into ../public/app
├── migrations/
│   ├── 0001_init.sql ..................... jobs/invoices/line_items/payments/expenses/quotes
│   ├── 0002_quote_client.sql
│   ├── 0003_notes.sql
│   ├── 0004_subcontractors.sql
│   ├── 0005_dead_letters.sql ............. sync_dead_letters table
│   ├── 0006_photos.sql ................... 🆕 photos table for CHS Capture PWA
│   └── 0007_notes_job_id.sql ............. 🆕 adds notes.job_id (NULL = "general")
├── src/
│   ├── index.ts .......................... Worker entry + router + scheduled handler (cron dispatch)
│   ├── env.ts ............................ Env interface (secrets + bindings)
│   ├── routes/
│   │   ├── kpis.ts ....................... GET /api/kpis  (dashboard KPI tiles)
│   │   ├── drill.ts ...................... GET /api/drill/:type  (KPI drilldowns)
│   │   ├── jobs.ts ....................... /api/jobs + /api/jobs/:id
│   │   ├── notes.ts ...................... /api/notes CRUD (now job_id-aware)
│   │   ├── photos.ts ..................... 🆕 /api/photos + /api/jobs/active (CHS Capture backend)
│   │   ├── subs.ts ....................... /api/subs CRUD
│   │   ├── search.ts
│   │   ├── hl.ts ......................... /api/hl/* (HighLevel PIT proxy)
│   │   ├── ops.ts ........................ /api/ops/* (heartbeat, DLQ, backup, summary, alert-test)
│   │   ├── sync.ts ....................... Jobber → D1 sync
│   │   ├── sheets-debug.ts ............... /api/debug/sheets-inspect
│   │   └── wc-sync.ts .................... POST /api/wc/sync (manual + scheduled)
│   └── lib/
│       ├── google/
│       │   ├── auth.ts ................... Service account JWT signing
│       │   └── sheets.ts ................. Sheets v4 REST client
│       ├── ops/
│       │   ├── notify.ts ................. Resend wrapper + dedupe + dry-run
│       │   ├── heartbeat.ts .............. 4h staleness check on sync_log
│       │   ├── dlq.ts .................... record + replay dead letters
│       │   ├── backup.ts ................. nightly D1 → NDJSON.gz → R2
│       │   └── daily-summary.ts .......... 24h roll-up email
│       └── wc/
│           ├── compute.ts ................ Monthly + KBPI rollups from D1
│           └── sync.ts ................... Writes to WC workbook
└── docs/
    ├── 00-architecture.md
    ├── 01-file-system.md
    ├── 02-estimating-app.md
    ├── 03-social-media.md
    └── 04-phase-6b-ui-plan.md
```

---

## What is shipped and working

### Backend (Worker + D1)
- ✅ Jobber GraphQL sync into D1 (jobs, invoices, line_items, payments, expenses, quotes)
- ✅ Pagination past 50 jobs (cursor-based, up to 5000)
- ✅ THROTTLED retry/backoff
- ✅ Idempotent upserts on Jobber IDs
- ✅ Scheduled handler runs sync + WC export every 30 min
- ✅ KPI calculations (YTD profit, gross revenue, unpaid, scheduled, needs-costing) — all Bad-Debt-aware
- ✅ Drill-down endpoints for every KPI tile
- ✅ Full CRUD for notes and subcontractors
- ✅ Jobs read API with filters/sort/drill
- ✅ HighLevel proxy at `/api/hl/*` using a Private Integration Token (PIT) stored as `HL_PRIVATE_TOKEN` secret
- ✅ Wealthy Contractor workbook auto-export (Monthly Net Profits + Key Business Performance Indicators tabs)

### Dashboard frontend
- ✅ Top KPI strip with click-to-drill on every tile
- ✅ "Needs Costing" warning pill on YTD Profit + inline ⚠ icons in Jobs view
- ✅ Lead pipeline (Kanban) backed by HighLevel via the proxy
  - 8 stages, no Dead Lead column (intentionally hidden — view in HL itself)
  - Drag-to-update writes back to HL
- ✅ Quick Launch tiles (Internal Tools, Google, Social, Advertising sections)
- ✅ Native pages: `/jobs`, `/notes`, `/subs`
- ✅ Smart Notes quick-capture card on main dashboard (POST /api/notes)
- ✅ Claude-powered note processing (categorize, extract tasks, summarize)
- ✅ Google Tasks integration on Smart Notes
- ✅ Meeting import → Smart Notes (Google Meet transcript ingest)
- ✅ Refresh button with spin + flash UX
- ✅ Compact icon-only header buttons (Connect Google + Refresh)
- ✅ CSV export + TSV clipboard copy on Jobs and Subs pages
- ✅ PWA manifest + service worker (installable from Chrome's three-dot menu)
- ✅ **CHS Capture PWA** at `/capture/` (shipped 2026-04-25) — separate-manifest mobile PWA for crew photo + voice-note capture, IndexedDB offline queue, Photos tab on Job drill-down. See "Photos system" below for the full feature breakdown.

### Reliability subsystem (shipped 2026-04-25)
- ✅ Notification primitive (`src/lib/ops/notify.ts`) — Resend wrapper with kv_cache dedupe, dry-run fallback, severity prefix in subject
- ✅ Heartbeat alert — fires when `sync_log` has no `success` row in 4+ hours; runs hourly at :15
- ✅ Dead-letter queue (`sync_dead_letters` table) — failed Jobber upserts captured with full payload; hourly replay; alerts at ≥5 attempts
- ✅ Nightly D1 → R2 backup at 02:15 Central — all 21 tables → NDJSON.gz to `backups/d1/YYYY-MM-DD.ndjson.gz`; 30-day retention sweep in same run
- ✅ Daily summary email at 07:00 Central — sync counts, activity (jobs/quotes/invoices/notes), DLQ depth, latest backup age/size; flags if anything is amiss
- ✅ Manual ops endpoints (gated by `SYNC_TRIGGER_SECRET`):
  - `GET /api/ops/heartbeat`
  - `GET /api/ops/dlq` + `POST /api/ops/dlq/replay`
  - `POST /api/ops/backup` + `GET /api/ops/backup/latest`
  - `POST /api/ops/summary`
  - `POST /api/ops/alert-test`

### Auth + secrets
- ✅ Cloudflare Access protecting dashboard for tony@homesolutionsar.com only
- ✅ Worker secrets: `JOBBER_*`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `HL_PRIVATE_TOKEN`, `CLAUDE_*`, `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`, `SYNC_TRIGGER_SECRET`
- ✅ Wrangler vars: `HL_LOCATION_ID`, `RESEND_DRY_RUN`
- 📍 Resend sending domain: `send.homesolutionsar.com` (verified via Cloudflare DNS auto-config)
- 📍 Alert recipient: `tony@homesolutionsar.com` (consider migrating to `ops@homesolutionsar.com` Workspace alias when convenient)

### Legacy (frozen, do not touch)
- 🟡 `chs-estimator-seeder` — quarterly Jobber pricebook → Sheets sync. Still runs. Not under active development.
- 🟡 Old Python `jobber_sync.py` in `chs-dashboard` — superseded by this repo's sync. Cron is OFF. Don't re-enable.

---

## Active backlog (priority order)

### ✅ Reliability debt — DONE (shipped 2026-04-25, commit `f24bacd`)
All four items from the original Phase 6 carryover are live. See "Reliability subsystem" above.
- [x] **Heartbeat alert** — sync staleness check, 4h threshold, hourly cron
- [x] **Dead-letter table** + hourly replay (with ≥5-attempts alert)
- [x] **Nightly D1 → R2 backup** with 30-day retention
- [x] **Daily summary email** at 7 AM Central

Items intentionally not done (lower priority Phase 6 carryovers):
- ~~Jobber webhook receiver~~ — polling is fine at current scale
- ~~Append-only event log with `event_id` dedup~~ — overkill for current volume; DLQ covers the failure-recovery case
- ~~SMS alerts~~ — email-only for v1; can add Twilio later if needed

### Hub Files (`dashboard/files.html`) — desktop first, then mobile

- **Current focus:** Keep tightening **desktop** — layout (upload beside browse, folder tree, PDF first-page thumbs, active vs archived jobs, etc.) until that experience feels “done.”
- **On-site photos from /files:** Upload type **“Job site photo (on job)”** — client generates an 800px thumb and `POST /api/photos` (same as the Capture PWA). Shown under that job’s **Site photos**, not Project files.
- **Legacy `README` stubs:** `migrations/0011_delete_legacy_job_readme_stubs.sql` removes old **“Project folder (auto)”** rows. They were never required for sync. Apply remote: `npm run db:migrate:remote`. New jobs no longer get a stub (sync no longer calls `ensureJobProjectStub` — **removed 2026-04-26**). Orphan R2 objects under `job-files/.../README` can be deleted in the bucket if you care.
- **Deferred — mobile upload drawer (do after desktop):** On narrow / touch viewports, avoid making users scroll past the full file list to reach upload. Add a **fixed “Upload” control** (e.g. bottom bar or header) that opens a **bottom sheet / slide-up panel** with the same job-file vs company-document forms and endpoints — **behavior unchanged**, only presentation and reachability on small screens.

### ✅ Photos system (PWA Capture v1 — built 2026-04-25)

> **Spec:** `docs/01-file-system.md` is the long-term roadmap (signed-URL sharing, EXIF stripping, full role matrix, video uploads). v1 of the capture path is now in production; the items below are deliberately deferred from v1 and remain in that spec.

**Locked decisions** (2026-04-25; do not relitigate without writing them up here first):

1. **Auth: Cloudflare Access.** The existing CF Access policy on `dashboard.homesolutionsar.com` automatically protects `/capture/*`. No second auth surface. Crew Workspace emails get added to the ACL when each onboards (see "Parked questions" below). The Worker reads `Cf-Access-Authenticated-User-Email` to attribute uploads to `photos.uploaded_by`.
2. **Scope: photos + voice notes.** Native expense capture is wireframed but **not** in v1; it remains as a separate locked-Option-A backlog item below.
3. **URL/path: same domain, separate manifest.** Crews install a *second* PWA called **CHS Capture** whose icon opens straight to `/capture/`. The existing dashboard PWA stays as-is for admin use. Two manifests, two icons, one origin.
4. **Migration timing: decoupled.** Drive backfill is a separate session. v1 ships with new-photos-only flowing into R2 + D1; no automated migration of historical Jobber/Drive photos.

**Storage model** (resolves the prior "R2-primary vs Drive-primary" sleep-on item — answer is **R2 + D1, no Drive mirror in v1**):

- R2 bucket `chs-hub-files`:
  - `photos/{job_id|"general"}/{YYYY-MM-DD}/{uuid}.jpg` (original)
  - `photos-thumbs/{job_id|"general"}/{YYYY-MM-DD}/{uuid}.jpg` (~800 px thumb, generated client-side via `<canvas>`)
- D1 `photos` table (`migrations/0006_photos.sql`): `id`, `created_at`, `taken_at`, `job_id` (NULL for "general"), `category`, `r2_key`, `thumb_key`, `uploaded_by`, `gps_lat`, `gps_lng`, `tags`, `caption`, `before_after_pair_id`. Indexes on `(job_id, taken_at DESC)`, `category`, `created_at`.
- D1 `notes` table now carries `job_id TEXT` (`migrations/0007_notes_job_id.sql`) so voice notes attach to a job (or stay general when NULL).

**API surface** (`src/routes/photos.ts`, `src/routes/notes.ts`):

- `POST /api/photos` — multipart (`original`, `thumb`, `metadata` JSON). Writes both blobs to R2 then inserts the D1 row. Returns `{ photo: { id, thumb_url, original_url } }`.
- `GET  /api/photos?job_id=&since=&limit=` — list. `job_id=general` filters for unattached photos.
- `GET  /api/photos/:id` — stream original from R2.
- `GET  /api/photos/:id/thumb` — stream thumbnail. Both also accept `HEAD`.
- `GET  /api/jobs/active` — minimal in-progress job list, used by the PWA's job switcher.
- `POST/GET/PATCH /api/notes` — extended to accept/return/filter on `job_id` (additive; existing notes stay NULL = "general").

**PWA** (`dashboard/capture/`):

- `index.html`, `manifest.json`, `app.js`, `styles.css`, `sw.js`, `queue.js`. Linked into `theme.css` for palette parity.
- Screens: Home, Camera (uses `<input type="file" capture="environment">`), Review (category tagging + caption), Voice (Web Speech API → optional `chs-claude-proxy` categorization → `/api/notes`), Switch-job, Pending.
- **Offline queue** (Phase 5): IndexedDB store `pending_uploads` holds failed photo and note POSTs. The service worker registers a `chs-capture-drain` Background Sync tag and drains the queue on `sync` events; the page also drains on `online` and visibility events as the iOS-Safari fallback. Pending count surfaces as a badge on the Home tile, with a list view at `/capture/?screen=pending`.

**Dashboard viewer** (`dashboard/jobs.html`):

- New **Photos** tab on the Job drill-down: lazy-fetches `/api/photos?job_id=…`, renders a thumbnail grid, click opens a lightbox of the original.
- **General Photos** button in the toolbar opens the same modal scoped to `job_id=general` for unattached uploads.
- **📷 column on the main jobs table** (added 2026-04-25): shows a gold pill `📷 N` per row with the photo count, dim outline `📷` when empty. Sortable header (`data-sort="photo_count"`). Clicking the cell opens the drill-down with the Photos tab pre-selected. Backed by a new `photo_count` rollup on `GET /api/jobs` (single subquery against `photos.job_id`, no extra round-trips).

**Out of scope for v1, deferred to follow-up sessions:**

- Drive → R2 backfill of historical photos.
- Signed URLs / external sharing (and the EXIF stripping that bundles with it).
- Cloudflare Images (resize-on-the-fly). Sticking with client-pre-computed thumbs until image transforms become a real bottleneck.
- Multipart upload for >100 MB videos (the "Wifi only" toggle comes back when video lands).
- Full role-based access matrix (still tracked separately below).
- R2-to-R2 cross-region backup.

**Parked operational follow-up — Cloudflare Access ACL onboarding:**

- The CF Access policy on `dashboard.homesolutionsar.com` currently allows only `tony@homesolutionsar.com`. Adding a crew member is a Cloudflare-dashboard-only change (no code) — append their Workspace email to the policy. Do this **at hire**, not preemptively, so we don't have stale identities lingering on the allowlist.
- When you add a crew email, also confirm the same email exists in any future `users` / `crew` D1 table once roles are real (today there's no such table; uploaded_by is just a string).

### ✅ Native expense capture in PWA (Option A core — built 2026-04-25)

> **Status:** core capture path shipped. PWA can snap a receipt + amount + vendor + description and persist it to D1 + R2; the dashboard drill-down expense tab shows it next to Jobber-imported expenses with clear `PWA` and `PENDING JOBBER` badges. Jobber GraphQL write-back is the remaining piece — see "Remaining follow-up" below.

**What shipped:**
- **Schema** — `migrations/0008_expenses_pwa.sql` adds `vendor`, `receipt_r2_key`, `entered_via` (`'jobber'`/`'pwa'`), `pushed_to_jobber_at`, `jobber_id` to the existing `expenses` table, plus an index on `(entered_via, pushed_to_jobber_at)` for the "pending Jobber sync" badge query.
- **API** — `src/routes/expenses.ts`:
  - `POST /api/expenses` (multipart): metadata JSON (job_id, amount, vendor, description, incurred_at) + optional `receipt` Blob. Validates amount > 0, generates R2 key at `expenses/{job_id|"general"}/{yyyy-mm-dd}/{uuid}.jpg`, writes R2 then D1 (same ordering rule as photos so D1 never points at missing R2). Sets `entered_via='pwa'`, leaves `pushed_to_jobber_at`/`jobber_id` NULL until Jobber write-back lands.
  - `GET /api/expenses?job_id=&since=&limit=` — used by future tooling; today the dashboard reads expenses through `/api/jobs/:id`.
  - `GET /api/expenses/:id/receipt` — streams the receipt JPEG from R2 (used by the lightbox).
- **PWA UI** — `dashboard/capture/`:
  - New `Log expense` tile on Home + `💵 Expense` slot in the bottom nav (nav grew from 3 to 4 columns).
  - New `expense` screen with the same active-job/general toggle pattern as voice notes, optional receipt photo button (separate hidden file input — `cap-receipt-input` — so it can't collide with the photo capture pipeline), and amount/vendor/description inputs. Receipts are downscaled client-side to ~1600px JPEG before upload.
  - Offline queue extended in `queue.js` (new `'expense'` kind with `{ metadata, receipt, filename }` payload). On network failure, expenses queue alongside photos and notes; the SW drains them on the next Background Sync or page poke.
  - Pending screen now labels expense items as `💵 EXPENSE` with vendor + amount.
- **Dashboard viewer** — `dashboard/jobs.html`:
  - `/api/jobs/:id` now returns the new fields on every expense row.
  - Expense table grew a vendor cell (with description as a sub-line), a thumbnail cell that links to the same lightbox photos use, and badges:
    - `PWA` — entered via the PWA.
    - `PENDING JOBBER` — entered via PWA but not yet pushed back to Jobber. Once the Jobber write-back ships, this clears automatically when `pushed_to_jobber_at` fills in.

**Smoke-tested 2026-04-25** on `chs-hub.tony-bc5.workers.dev` with two POSTs (one with receipt, one without) + a GET list + HEAD on the receipt stream.

**Out of scope for this build (intentional):**
- Voice-dictation on the description field (mentioned in the original plan as "optional"). Easy to add later by reusing `buildRecognition()` from the voice-note flow.
- Hash-deduped R2 keys (we use the row UUID instead of a content hash; collisions on a UUID are basically zero, and Tony might genuinely re-snap the same receipt for two expenses).

### ✅ Jobber write-back code shipped — 🟡 awaiting scope toggle + self-serve OAuth (built 2026-04-25)

**All code is in place.** A scope-test against Jobber's API confirmed:

- `expenseCreate(input: ExpenseCreateInput!) -> ExpenseCreatePayload` is the right mutation. Required input fields: `title` (vendor), `date` (incurred_at), plus optional `description`, `total`, `linkedJobId`. Returns `expense { id title total }` and `userErrors { message path }`.
- `src/lib/jobber/expenses.ts` runs the mutation, writes `jobber_id` + `pushed_to_jobber_at` back to D1 on success, and surfaces `userErrors` cleanly on failure. Idempotent: re-running on an already-pushed row no-ops.
- `POST /api/expenses` runs the push best-effort *after* the local D1+R2 write; the response includes `jobber_pushed: true|false` and `jobber_error` so the PWA could in future surface "synced ✓" vs "queued for retry" copy.
- `POST /api/expenses/:id/push-to-jobber` exposes a manual retry. Wired into the dashboard's `RETRY` button next to the `PENDING JOBBER` badge — click it, get a green ✓ on success or a tooltip with Jobber's error on failure, drill auto-rerenders so badges clear.
- `src/lib/jobber/sync.ts` no longer wipes PWA-captured expense rows on its 30-min refresh, and skips re-inserting any Jobber expense whose ID matches a `jobber_id` we already own (so push-then-cron doesn't create duplicates).

**🟡 Live status (2026-04-25):** the first push to Jobber returned:

> `Jobber GraphQL errors: An object of type ExpenseCreate was hidden due to permissions`

The current refresh token was minted with read-only scopes. **Self-serve unblock flow now exists** (`src/routes/oauth-jobber.ts`):

#### Operator runbook — re-authorize Jobber with new scopes

1. **Jobber Developer Center → your app → Settings**:
   - Under **OAuth Callback URL**, set exactly:
     `https://dashboard.homesolutionsar.com/oauth/jobber/callback`
     (already-existing callback URLs can stay; Jobber accepts a list).
   - Under **Scopes**, enable `write_expenses` (the exact name appears next to `read_expenses` in the same list). Save.

2. **Walk the OAuth flow** (one click — does the rest automatically):
   - Visit https://dashboard.homesolutionsar.com/oauth/jobber/start
   - Cloudflare Access challenges you (regular SSO).
   - Jobber's consent page lists the new scope set — click **Allow Access**.
   - Lands on a green "Jobber re-authorized ✓" page that shows the granted scopes.
   - The new refresh token is written to D1 (`integrations` row id='jobber') automatically. No `wrangler secret put` needed — `src/lib/jobber/auth.ts` reads from D1 first and rotates from there.

3. **Verify**: https://dashboard.homesolutionsar.com/api/jobber/status returns the integration row including a masked token preview and the granted scope list. Confirm the `refresh_token_preview` changed from the value you saw before.

4. **Smoke-test**: tap a PWA expense's `RETRY` button in the job drill-down. Should turn green ✓ and clear the badge after the auto-reload. Or via curl: `curl -X POST .../api/expenses/<id>/push-to-jobber` should return `{ "ok": true, "jobber_id": "..." }`.

**Once unblocked, all in-flight PWA expense rows auto-flush** — the `RETRY` button is idempotent and the next 30-min cron sync will not clobber them. No code change needed.

This same flow is reusable for any future Jobber scope additions — toggle the scope in the Dev Center, visit `/oauth/jobber/start`, done.

### ✅ Hub Files browser + company documents (shipped 2026-04-26)

- **UI:** `dashboard/files.html` at **`/files`**; quick link on the home dashboard **replaces the old Google Drive tile** ("Hub Files" — photos, receipts, company docs, D1 backups).
- **API:** `GET /api/files?kind=&q=` (kinds: `photo` | `receipt` | `company` | `backup` | `all`). `GET /api/files/backup?key=` streams nightly **`backups/d1/…`** gzip exports (key prefix validated). **`company_documents`** table + `POST/GET /api/company-documents` and **`GET /api/company-documents/:id/file`**. Upload form on the same page (SOPs, insurance, licenses, W-9, tax, HR, etc.).
- **Migrations:** `migrations/0009_company_docs_drive_mirror.sql` — add `company_documents`, `drive_mirror_folders`, `drive_mirrored_at` on `photos` + `expenses`. Apply remote: `npm run db:migrate:remote`.
- **Nice-to-haves (still defer):** folder-tree UI, multi-select zip download, per-row share links (see item below).

### ✅ Google Shared Drive mirror — **insurance + human access** (v1 code 2026-04-26)

> R2 + D1 stay canonical. One-way async copy: **not** bidirectional.

**Code:** `src/lib/google/drive.ts` + `src/lib/ops/drive-mirror.ts` — on the **`15 * * * *` hourly cron** (with heartbeat/DLQ), up to 5 new items each of **photos**, **expense receipts**, **company documents**; multipart upload to folders **`Photos`**, **`Expenses`**, **`Company/<doc_type>/`** under an operator-configured root. Row-level **`drive_mirrored_at`**; **`drive_mirror_folders`** caches created segment folder IDs. **Manual:** `POST /api/ops/drive-mirror` with sync secret. **No deletes** in Drive when CHS deletes (append-only v1). **`getGoogleAccessToken`** is now **per OAuth scope** so Drive + Sheets do not clobber each other.

**You must (Cloudflare → Worker + Google):** (1) Enable **Google Drive API** for the same GCP project as the Sheets service account. (2) Add the service account to the **Shared Drive** (e.g. **Content manager**). (3) Set Worker vars: **`DRIVE_SHARED_DRIVE_ID`**, **`DRIVE_MIRROR_ROOT_FOLDER_ID`** (folder inside that drive for CHS-Hub uploads).

**If those vars are unset:** mirror is a no-op; core uploads are unaffected.

**Follow-up — revisit and verify (2026-04-26, Tony: waiting + retest):** After the next **hourly** mirror window (or a manual `POST /api/ops/drive-mirror` with the sync secret on the real **`*.workers.dev`** host and `x-sync-token`), re-check: (1) test upload appears under **Shared drive** → configured root → **`Company/<doc_type>/`** (company docs) or **`Photos` / `Expenses`** for those kinds; (2) JSON response has **`skipped: false`**, `errors: []`, and non-zero counts when something was pending; (3) `wrangler tail chs-hub` if files still missing — look for `drive_mirror` and Google API error text. If D1 row has **`drive_mirrored_at` set** but nothing in Drive, treat as a bug to investigate (ID mismatch or wrong drive).

---

### ✅ Hub Files shareable links (2026-04-26)

**Shipped:** `POST /api/file-link` (JSON `{ kind, id, "ttl_sec"? }` — `kind` = `job_file` | `company` | `photo` | `receipt`; requires CF Access session) returns `{ url, expires_at }`. **Public** `GET /api/f?t=<HMAC token>` serves the file (CORS `*`) until expiry. Set **`FILE_LINK_SECRET`** (≥16 chars) via `wrangler secret put`. Optional **`HUB_FILE_LINK_ORIGIN`** var = your **`*.workers.dev`** origin so pasted links work for people without Access; otherwise `url` uses the request host (may 302 to Access for anonymous). Hub Files UI: **Link** on list + explorer rows.

**Project files:** New `doc_type` **`design`** (“Design & finishes”) — for finishes, inspiration boards, etc.; **`other`** remains “Miscellaneous.”

### 🟡 Receipt upload to Jobber (small follow-up after scope is fixed)

Right now the write-back sends metadata only (title, date, total, linkedJobId, description). Two ways to attach the receipt photo:

- **Easy:** make `/api/expenses/:id/receipt` reachable without Cloudflare Access (signed-URL endpoint scoped to a single expense ID, valid for ~1h) and pass it as `receiptUrl` in the input. Jobber fetches the image during the mutation.
- **Cleaner:** implement Jobber's two-step ActiveStorage upload to get a `receiptSignedBlobId` and pass that. Higher effort, no public URL needed.

Pick easy when this becomes a priority; the cleaner path is overkill until receipts genuinely need to round-trip through Jobber's UI (currently they're viewable in the dashboard via the `📎` thumbnail next to the row).

### ✅ Voice dictation on the expense description (built 2026-04-25)

The expense description input now has a `🎙️` mic button that toggles Web Speech transcription directly into the field. Reuses `buildRecognition()` from the voice-note flow but in transcript-only mode (no Claude round-trip; recognized phrases append straight into the input). Tap once to start — button pulses red — tap again to stop, or navigate away from the Expense screen and the recognizer auto-stops. Final transcript caps at the same 200-char limit as typed input.

### 🟢 Social media system — **planning phase** (implementation when Cursor usage resets)

> **Status (2026-04-26):** Tony hit Cursor Pro usage for the cycle; we're **not coding this block until usage resets**. Use the sections below as the single planning handoff so the first implementation session can start without re-discovering context.
>
> **Canonical spec:** `docs/03-social-media.md` (milestones Session 8a / 14 / 15+). Anchored on `CHS_ProjectInstructions_and_SOP` + `ColumbusHomeSolutions_SocialMedia_System` sheet. Read the spec end-to-end before touching code.

**Prerequisite (met):** The photos + PWA capture foundation is in production (`/capture/`, D1 `photos`, R2 `photos/`). The old "wait until photos exist" gate in the spec is **satisfied**. Remaining dependency is **product decisions + API keys**, not infrastructure.

**Decisions to lock before Session 8a (monthly plan generator)**

| Topic | Question | Default in spec | Decide by |
|-------|----------|-----------------|-----------|
| Caption / plan AI | Run Anthropic (Claude) from the Worker using a stored API key, or keep monthly planning as a manual Claude Project session for v0? | Worker `POST /api/social/monthly-plan` with prompt template from SOP | First build session |
| Image generation (Session 14) | Flux Pro via Replicate vs DALL-E 3 vs other — see `docs/03-social-media.md` sections 5 and 8 (Q1) | Flux Pro 1.1 via Replicate | Before Session 14; can defer if 8a ships first |
| Publishing | Original spec: **Metricool = manual paste** (no Meta Graph API). Revisit only if Tony wants API schedule push; else keep clipboard + download workflow | Manual | Anytime; not blocking 8a |
| Data model name | Spec mentions `social_posts` / `social_plans`; implementation may use `social_drafts` or align names to the doc — pick one schema in the first migration | Per `docs/03-social-media.md` section 2 | First migration PR |
| "Ready for Social" | Photos: flag in hub (`social_ready` / category) vs Drive folder — **hub-only** per spec section 4 | D1 + dashboard toggle on photo | Part of queue/library milestone |

**First implementation slice (when resuming — estimated 1–2 hrs in spec)**

1. D1 migrations: `social_plans`, `social_posts` (or equivalent), plus seed path for hashtag/caption tables if doing settings in the same pass.
2. `POST /api/social/monthly-plan` — inputs: month, featured job IDs; output: structured posts; persist to D1.
3. Dashboard `/social/plan` — minimal: month picker, job multi-select, Generate, editable table, export CSV/clipboard (per Session 8a in spec).

**Second slice (later):** Session 14 — `/social/queue`, AI image gen to R2, approval + clipboard flow; photo picker filtered to **Ready for Social** from R2/D1.

**Content creation tooling inventory (fill in during planning, not ad hoc in code):** Image gen, optional video, caption drafting — record the **final** stack in `docs/03-social-media.md` (new "Approved tools" subsection at the top) so the dashboard and runbooks show one canonical list (Flux vs Canva vs Runway, etc.).

**Open questions** already listed in spec section 8 — copy into the first PR description and tick them off.

### ✅ Live updates — HighLevel lead pipeline (shipped 2026-04-26)

> **Source:** raised by Tony — HighLevel and dashboard should stay in sync without a manual full page refresh.

**Shipped in `dashboard/index.html`:**
- **`HL_PIPELINE_POLL_MS` (15s):** while the tab is in the **foreground** (`document.hidden === false`), the worker proxy re-fetches all opportunities (with pagination) on a timer — typically see HL-side moves within one interval.
- **`visibilitychange` + `window` `focus`:** refetch when you return to the tab or refocus the browser window (e.g. after moving a deal in HighLevel in another window).
- **Drag on the board** still calls `updateHLStage` then `fetchHLData()` so dashboard → HL stays consistent.

**Not in scope of this pass:** the **marketing / public** site, KPI tiles backed by D1+Jobber cron, or true **push** (webhooks + SSE). Those sit in **Fine tuning (end of project)** at the end of this file.

**Open product question (deferred):** if "live" should ever apply to a **non-dashboard** property (e.g. Squarespace), that is a separate integration — clarify URL and data source first.

### 🟡 Mobile quick-capture (small win, ~1–2 hours)

> **Note:** The "big" mobile capture flow (photos + voice notes on a job site) shipped 2026-04-25 as the **CHS Capture** PWA at `/capture/` — see "Photos system" above. This smaller task is what's *left*: extra non-photo quick actions and OS integrations.

- Long-press shortcuts on the **dashboard** PWA (not CHS Capture): `🔨 New Job`, `👷 New Sub`, `🎯 Add Lead` in `dashboard/manifest.json`. (CHS Capture already has `📷 Take a Photo` and `🎙️ Voice Note` shortcuts.)
- Optional iOS Shortcut on top for true Lock Screen widget + share-sheet capture from Apple Notes / Keep / Safari into `/api/notes`.

### 🟡 Notes strategy revisit — replace Apple Notes / Keep with our own capture app
**Tony, ask me about this next time.** Now that the PWA ships with the voice-note flow (`/capture` → Voice → Claude categorize) **and** the Smart Notes API (`/api/notes` with job_id, tags, summary, task extraction), the original "integrate Apple Notes / Google Keep" plan is probably the wrong move. The integration plan was always shaky — neither has a usable API; it would have been an iOS Shortcut hack at best.

What we have now in CHS Hub already covers the use cases that drove the Keep/Notes integration:
- **Quick capture from the field** — PWA Voice screen, transcript editable, attached to a job or general.
- **Categorization + task extraction** — Claude proxy already does this on save.
- **Cross-device** — anything captured shows up in the dashboard's Smart Notes view immediately.
- **Search** — D1-backed, can query by job, tag, or text.

The conversation to have:
1. Are you still using Apple Notes / Keep for anything CHS-related, or has the PWA voice-note flow taken over?
2. If yes, what's the gap? (Speed of opening? Specific UI affordances? Sharing?)
3. Should we **replace** Keep/Notes with a dedicated CHS Notes screen in the PWA — searchable, taggable, optionally pinned to the home dashboard — instead of integrating with them?
4. Voice-first capture: the current Voice screen is great for "snap a thought during a job"; do we also want a "browse / edit / pin" surface in the PWA so the field flow is closed-loop without ever opening the dashboard?

If we go the "build our own" route, scope sketch (~3-4 hours):
- New PWA screen `dashboard/capture/notes.html` (or a `notes` screen in the existing PWA): list view of all your notes, filter by job / tag / date, pin-to-top, quick-edit.
- Existing `/api/notes` already has the data; just need a list endpoint + a PATCH endpoint for edits.
- Optional: pin a note to the dashboard's KPI strip ("today's reminders").

### 🟡 Role-based access
- Right before Tony's first hire — needs a separate dashboard view that hides revenue/profit KPIs.
- Cloudflare Access already segments users; we just need the frontend to render different tiles based on the `Cf-Access-Authenticated-User-Email` header.
- Probably 2–3 hours.

### 🟡 KBPI Weekly Marketing Tallies sync
Deferred — needs a lead-source data source. Currently lead sources are spread across Google Local Services / GBP / HL referrals with no canonical feed. Decide on data source before implementing.

### 🟢 Legacy repo housekeeping (low urgency, ~1 hour)
- Add `README.md` + `.env.example` to `chs-estimator-seeder`
- Add `docs/runbooks/` (quarterly-run-failed.md, refresh-token-died.md, kpi-sync-tab-deleted.md)
- Tag `v1.0` on both `chs-estimator-seeder` and `chs-dashboard`

### 📌 Small content / link items (drive-by fixes)

Tracked here so they don't get lost between bigger features.

- ~~**Add Thumbtack link to the advertising section.**~~ ✅ **Shipped 2026-04-25.** Added 📌 Thumbtack tile to the Quick Launch → Advertising section in `dashboard/index.html`. Uses the same `mobAppLink(thumbtack://, https://www.thumbtack.com/login)` pattern as the other native-app tiles, so it opens the Thumbtack pro app on phone and falls back to web on desktop.

### 🟡 Revisit: end-to-end photo system testing (desktop + mobile)
The PWA Capture v1 build (2026-04-25) was unit-tested with curl + a single manual upload. Before declaring the photo system "done," do a real-world QA pass:
- **Mobile (iOS Safari)** — install the PWA from `/capture/`, take 5–10 photos across multiple jobs and the General bucket, verify they appear in the Photos tab and the new 📷 column count updates. Test the offline flow: airplane mode, take 2 photos, re-enable network, confirm Background Sync drains the queue.
- **Mobile (Android Chrome)** — same flow; verify the install prompt and that the manifest icons render correctly.
- **Desktop** — `/capture/` likely shouldn't be the primary surface, but verify the `<input type="file">` fallback still works with a webcam and that the upload path is identical.
- **Voice notes** — record on each platform, confirm Web Speech API transcription works (Safari iOS is the riskiest), confirm Claude categorization round-trips through `chs-claude-proxy`, confirm `job_id` attachment toggles correctly.
- **Photo viewer** — open the lightbox on both desktop and mobile, verify image scales correctly, GPS metadata renders (or fails silently if missing).
- **Edge cases** — very large photos (>10 MB), HEIC vs JPEG, photos with no EXIF, photos taken while on cellular vs WiFi.
- **Cleanup** — make sure category tagging and the before/after pair UI are still on the roadmap before users start relying on filename-based organization.

### 🟢 Project completion deliverable: system overview doc (do this LAST, before declaring "done")
**Trigger**: Once the photos + social tracks are shipped and the system feels feature-complete, create a polished one-page overview that Tony (or a future hire) can use to understand the whole stack at a glance.

**What it should contain**:
- **Architecture diagram** — clean version of the ASCII diagram at the top of this file. Tools: Excalidraw, draw.io, or a hand-drawn diagram in Figma. Export as both PNG (for embed) and SVG (for high-res print).
- **Service inventory** — table of every external SaaS the system depends on, with for each: role, plan/tier, monthly cost, account email, password-manager entry, dashboard URL, criticality (load-bearing vs nice-to-have), failure mode if it goes down. Current list to seed it: Cloudflare (Workers, D1, R2, Pages, Access, DNS), Resend, Jobber, HighLevel, Google Workspace (Sheets, Tasks, Meet, Drive), Anthropic Claude, GitHub, possibly Metricool, possibly Cloudflare Images.
- **Data flow** — what data enters from where, where it's stored, who can read it, retention policy.
- **Disaster recovery** — for each load-bearing service: how to detect failure, what backup we have, recovery procedure, who to call.
- **"Hit by a bus" doc** — a ~half-page section explaining how someone else could take over: which 1Password vault has what, where each repo lives, where to find recurring credentials/keys, how to restore from the nightly D1 backup, etc.

**Surfaces to publish to**:
- `/about` page on the dashboard (link in the header). Plain HTML, can include the SVG diagram inline.
- Save the PDF to a "CHS — System & Operations" folder in Google Drive.
- Print a copy and put it in Tony's office as a fallback for "the day everything is on fire and the dashboard is down."

**Estimate**: ~3–4 hours when the time comes. Best done in one sitting so the picture is internally consistent.

---

## Open decisions for Tony

1. ~~**Photo storage model** — R2-primary vs Drive-primary vs hybrid.~~ **Resolved 2026-04-25:** R2 + D1, no Drive mirror in v1. Drive backfill is a separate decoupled session. See "Photos system" above for the four locked decisions.
2. **Social publish channel** — Metricool API (preferred, Tony already has account) vs Zapier vs manual approval-only.
3. **Alert recipient** — currently `tony@homesolutionsar.com`. Optional follow-up: create a Google Workspace alias `ops@homesolutionsar.com` and switch `ALERT_EMAIL_TO`. No code change, just `wrangler secret put`.
4. **Crew CF Access onboarding policy** — parked. When the first crew member onboards, decide whether each gets added to the same dashboard CF Access policy (current default — they'd see the full admin dashboard *and* CHS Capture) or whether we split into two CF Access apps so crew gets only `/capture/*`. Lean toward splitting once role-based access lands; until then, keep the allowlist tight and add emails one at a time.

---

## Don't-touch list

- `chs-estimator-seeder` Python sync — it works, it's quarterly, leave it alone unless it breaks
- `chs-dashboard` repo — old static dashboard, replaced by `chs-hub/dashboard/`. Cron is OFF in `jobber_sync.yml`. Don't re-enable.
- Jobber Developer app scopes — broad, working. Don't fiddle.
- The Wealthy Contractor sheet's "Monthly KPI's" tab — we're writing to Monthly Net Profits + KBPI but **not** Monthly KPIs (intentionally — it's a derived view inside the sheet).
- HighLevel "Dead Lead" stage — view it in HL itself, not on the dashboard. Removed by design.

---

## Quick reference

### Useful commands
```bash
# from ~/projects/chs-hub
npm run deploy                              # deploy worker
npm run db:migrate:remote                   # apply pending migrations to prod D1
npm run tail                                # live worker logs
npx wrangler secret put SECRET_NAME         # set/update a secret
npx wrangler d1 execute chs-hub-db --remote --command "SELECT ..."  # ad-hoc query
git log --oneline -20                       # recent commits
```

### Manual triggers
```bash
# Most ops endpoints take ?secret=$SYNC_TRIGGER_SECRET (also accepts x-sync-token header).
# The token lives in ~/projects/chs-hub/.env (gitignored).

SECRET="$SYNC_TRIGGER_SECRET"   # or paste the value from .env
BASE=https://chs-hub.tony-bc5.workers.dev

# Sync triggers (legacy endpoints, header-style auth)
curl -X POST $BASE/api/sync/jobber -H "x-sync-token: $SECRET"
curl -X POST $BASE/api/wc/sync -H "x-sync-token: $SECRET"

# Reliability ops endpoints (query-string-style auth)
curl    "$BASE/api/ops/heartbeat?secret=$SECRET"          # is sync stale?
curl    "$BASE/api/ops/dlq?secret=$SECRET"                # DLQ depth + breakdown
curl -X POST "$BASE/api/ops/dlq/replay?secret=$SECRET"    # force a replay pass
curl -X POST "$BASE/api/ops/backup?secret=$SECRET"        # run an ad-hoc D1 backup
curl    "$BASE/api/ops/backup/latest?secret=$SECRET"      # most recent backup
curl -X POST "$BASE/api/ops/summary?secret=$SECRET"       # send the daily summary now
curl -X POST "$BASE/api/ops/alert-test?secret=$SECRET"    # round-trip test the email pipeline

# Other
curl $BASE/health                                          # public health probe (D1+R2)
curl $BASE/api/debug/sheets-inspect                        # WC sheet structure
```

### Useful npm scripts (debugging)
```bash
npm run ops:dlq:list          # open dead-letter rows
npm run ops:dlq:resolved      # most-recent successful replays
npm run ops:sync:log          # last 20 sync_log entries
```

### Key IDs
- D1 DB name: `chs-hub-db`
- R2 bucket: `chs-hub-files` (also holds nightly backups under `backups/d1/`)
- HL location: `lZ8L8FAf6K2niuHoFbaw`
- WC sheet ID: `1utmYdBkUM8cefQ-1mpEnhiyV-vVf-IOhN1yn_wfXyZo`
- Old Subcontractor sheet (now retired, copy of structure lives in D1): `1L7Ai9p-GTDuwlozh5ssGWRGkrP1AC3SLIrmwOsTEgW0`

### Branding / theming
- All four dashboard pages (and the future PWA) link `dashboard/theme.css` for the brand palette and base styles.
- To recolor the entire dashboard, edit the `:root { ... }` block in `dashboard/theme.css`. That file owns: palette (gold/burgundy/cream/etc.), `*` reset, `body` typography + background, and the radial-gradient page wash.
- Per-page component styles (`.kpi`, `.card`, `.filters`, `.modal`, `.bn`, `.bdg`, etc.) currently still live inline in each `.html` file because of historical class-name drift between pages. Consolidate into `theme.css` next time a component gets touched — not as a standalone refactor.
- The PWA capture flow wireframe (`canvases/pwa-capture-wireframe.canvas.tsx`) mirrors this same palette so the production PWA can drop into the existing visual language without re-design.
- Resend sending domain: `send.homesolutionsar.com`

### Cron schedule (all in `wrangler.toml`) — 5 triggers (Free-plan cap)
```
*/15 * * * *   Notification processor — drains queued notification_logs (Sprint 7)
*/30 * * * *   Jobber + WC sync
15 * * * *     Heartbeat (alerts if sync >4h stale) + DLQ replay
15 7 * * *     Nightly D1→R2 backup + 30-day retention sweep + INVOICE BILLING
               (late fees + due/past-due reminders, Sprint 9) — 02:15 Central
0 12 * * *     Daily summary email (07:00 Central)
```
> **Free plan caps at 5 cron triggers**, so Sprint 9's invoice-billing run was folded into the existing `15 7 * * *` nightly handler rather than getting a standalone `0 8 * * *`. Adding a 6th distinct schedule will fail to deploy (`code: 10072`).

---

## Fine tuning (end of project)

> **When:** After the big rocks are done (capture, social, files browser, etc.) and the system is in **daily use** with no burning gaps. These are **polish and latency** upgrades, not blockers. Budget **roughly 1–2 days** if you do both HighLevel and Jobber push paths; half a day for HL-only.

### 1) HighLevel — push-based lead pipeline (sub-second, optional)

**Problem today:** the dashboard **polls** the LeadConnector API on an interval. It is efficient and good enough for one operator, but it is not **instant** and it burns a small amount of API traffic forever.

**Target behavior:** a card **moves on the board within ~1s** of a change in HighLevel (or of a successful `PUT` from the dashboard) without waiting for the next poll.

**Approach (scoped):**
1. **HighLevel** — In the GHL / LeadConnector app settings, subscribe to **opportunity** (and if needed **contact**) webhooks for the sub-account, pointing at a new HTTPS endpoint, e.g. `POST /api/integrations/hl/webhook` (Access **off** for this path; use **HMAC or shared-secret** query/body validation so only GHL can post).
2. **Worker** — Verify the signature, parse the event (at minimum `OpportunityUpdate` / stage change; optionally dedupe with `eventId` if provided). Enqueue a tiny payload `{ type, opportunityId, locationId, pipelineStageId? }` to a **Durable Object** or just **broadcast** to interested clients (see next).
3. **Browser** — Open a **Server-Sent Events (SSE)** stream from the same worker origin, e.g. `GET /api/integrations/hl/events` (protected by **Cloudflare Access** like the rest of the dashboard), `EventSource` in `index.html` listening for `opportunity` events. On message: either call existing `fetchHLData()` (simplest) or **patch a single card** in the DOM if the payload is rich enough.
4. **Back-pressure / fallback** — If SSE disconnects, fall back to current **15s polling** (keep today’s poller as safety net). Optional: `Last-Event-ID` reconnection (SSE standard).

**Out of scope for this item:** rewiring **KPIs** or **Jobber** rows (separate line below). **Do not** remove the poll loop until SSE is proven stable in production.

**Rough effort:** **~3–5 hours** for HL-only push + SSE + secret verification; add buffer if GHL’s webhook shape or signing docs require iteration.

### 2) Jobber — near-live jobs / KPIs (larger, optional)

**Problem today:** D1 is refreshed on a **30-minute cron** (plus on-demand sync). The dashboard can poll KPI endpoints more often, but the **data** is still at most 30 min fresh unless someone triggers a sync.

**Target behavior:** **significant** Jobber events (e.g. job status, new invoice) trickle into D1 **within a minute** and optionally notify the open dashboard.

**Approach (scoped, high level):** Jobber **webhooks** (if available for your plan and events) or scheduled **incremental** GraphQL pull more often for **hot** entities only → Worker writes D1 → same **SSE channel** (or a second event type) to the dashboard. Requires **webhook URL registration** in Jobber, idempotent writes, and careful alignment with the existing `syncJobberToD1` full sync so cron doesn’t fight incremental updates.

**Rough effort:** **~6+ hours** — treat as a small project; only worth it if sub-30-min job data is a real pain after HL push is done.

### 3) Small UX add-ons (same “fine tuning” bucket)

- **"Updated 12s ago"** (or "Live · synced 3s ago") on the lead pipeline card header — uses `performance.now()` or a `lastHLSyncedAt` timestamp; purely cosmetic.
- **Throttle** SSE + polling so both never run full fetches in the same second (minor).

**Record in git:** when this ships, add a short `docs/runbooks/hl-sse-pipeline.md` (webhook URL, secret rotation, how to test with `curl`).

---

## Recommended first ask in the new chat

Pick one:

> "Read `HANDOFF.md` and confirm you're caught up. I've decided on photo storage: **&lt;R2-primary | Drive-primary | hybrid&gt;**. Let's start the photos foundation."

> "Read `HANDOFF.md` and confirm you're caught up. Quick win first — I want the **mobile capture** page wired up so I can use this from my phone properly."

> "Read `HANDOFF.md` and confirm you're caught up. The reliability pass is shipped; what makes the most sense to tackle next?" (Lets the AI propose the path based on current state.)

Whichever path you pick, the AI should start by reading this file end-to-end, then proposing a plan before writing any code.
