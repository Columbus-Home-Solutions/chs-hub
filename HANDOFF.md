# CHS Hub — Session Handoff

> **For Tony:** Open Cursor on `~/projects/chs-hub`, start a brand new chat, and paste the contents of this file as your first message. Then say _"Read HANDOFF.md and confirm you're caught up. I want to work on **&lt;X&gt;** today."_

> **For the next AI session:** This is the source of truth for project state as of **Apr 25, 2026**. Trust this over any older context. The previous chat (where the dashboard rebuild happened) was archived because it had become unwieldy. All work since the migration playbook (archived at `docs/archive/migration-playbook.md`) has happened in this repo, `chs-hub`.

---

## TL;DR — where we are

We are deep into **Phase 7** of the original migration playbook (the "dashboard rebuild" phase). What was originally going to be a separate `chs-automation` repo (Phase 6) got merged into this one, so `chs-hub` now contains:

- The Cloudflare Worker backend (Jobber sync + KPIs + drill routes + WC workbook auto-export + HighLevel proxy + Smart Notes API + Jobs API + Subcontractor API)
- The D1 database (jobs, invoices, line_items, payments, expenses, quotes, notes, subcontractors, sync_dead_letters)
- The static dashboard frontend (vanilla HTML/CSS/JS served from Cloudflare Pages at `dashboard.homesolutionsar.com`)
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
                       │ Wealthy      │  │ Dashboard frontend   │
                       │ Contractor   │  │ (Cloudflare Pages)   │
                       │ Google Sheet │  │ dashboard.homesol... │
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
- Wealthy Contractor sheet: hardcoded in `dashboard/index.html`
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
├── dashboard/
│   ├── index.html ........................ main dashboard (KPIs, quick launch, kanban)
│   ├── jobs.html ......................... native Job Tracker
│   ├── notes.html ........................ native Smart Notes
│   ├── subs.html ......................... native Subcontractor Reference List
│   ├── manifest.json + sw.js ............. PWA basics
├── migrations/
│   ├── 0001_init.sql ..................... jobs/invoices/line_items/payments/expenses/quotes
│   ├── 0002_quote_client.sql
│   ├── 0003_notes.sql
│   ├── 0004_subcontractors.sql
│   └── 0005_dead_letters.sql ............. sync_dead_letters table
├── src/
│   ├── index.ts .......................... Worker entry + router + scheduled handler (cron dispatch)
│   ├── env.ts ............................ Env interface (secrets + bindings)
│   ├── routes/
│   │   ├── kpis.ts ....................... GET /api/kpis  (dashboard KPI tiles)
│   │   ├── drill.ts ...................... GET /api/drill/:type  (KPI drilldowns)
│   │   ├── jobs.ts ....................... /api/jobs + /api/jobs/:id
│   │   ├── notes.ts ...................... /api/notes CRUD
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
- ✅ Quick Launch tiles (Spreadsheets section + Google section)
- ✅ Native pages: `/jobs`, `/notes`, `/subs`
- ✅ Smart Notes quick-capture card on main dashboard (POST /api/notes)
- ✅ Claude-powered note processing (categorize, extract tasks, summarize)
- ✅ Google Tasks integration on Smart Notes
- ✅ Meeting import → Smart Notes (Google Meet transcript ingest)
- ✅ Refresh button with spin + flash UX
- ✅ Compact icon-only header buttons (Connect Google + Refresh)
- ✅ CSV export + TSV clipboard copy on Jobs and Subs pages
- ✅ PWA manifest + service worker (installable from Chrome's three-dot menu)

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

### 🟢 Photos system (recommended next — planning phase, open decision)

> **Spec:** `docs/01-file-system.md` is the authoritative plan (PWA capture, R2 + D1, Drive migration, signed-URL sharing, role matrix). Read it before writing any code. Decision was locked 2026-04-24; nothing has changed since.

Open question Tony is sleeping on: **R2-primary with Drive mirror, or Drive-primary?**

My recommendation: **R2 + D1 + Cloudflare Images as primary, Google Shared Drive as optional mirror.** Reasoning: the value of photos isn't the storage, it's the queryable metadata (before/after pairing, "5-star sub's last 3 jobs," social media composer pulling from a photo library). That requires SQL, not Drive folders.

Schema sketch (not yet built):
- `photos` table: `id`, `r2_key`, `thumb_key`, `job_id`, `lead_id`, `subcontractor_id`, `category` (before/after/progress/marketing/safety/incident), `taken_at`, `uploaded_by`, `gps_lat`, `gps_lng`, `tags`, `caption`, `before_after_pair_id`
- R2 bucket: already created (`chs-hub-files`)
- Cloudflare Images: enables resize/transform on the fly; would be a paid add-on

When Tony decides, **build vertical slice first**: storage → mobile capture page → Job/Lead drill-down photo tabs. ~4–6 hours to "snap a photo on a job and see it on the dashboard."

### 🟢 Social media system (after photos)

> **Spec:** `docs/03-social-media.md` is the authoritative plan (monthly plan generator, approval queue, Flux Pro image gen, Hashtag Bank + Caption Templates, Metricool hand-off). Anchored on Tony's existing `CHS_ProjectInstructions_and_SOP` doc + `ColumbusHomeSolutions_SocialMedia_System` sheet. Read it before writing any code.

Wait until photos foundation exists. Then:
- D1 `social_drafts` table referencing photo IDs
- `/social` composer page (pick photos, write caption, schedule)
- Approval queue (manual approval per the original spec)
- Metricool API for actual publishing (or zapier-glue if Metricool API isn't suitable)

### 🟡 Mobile quick-capture (small win, ~1–2 hours)

> **Note:** The "big" mobile capture flow (photos on a job site) is covered by the photos spec in `docs/01-file-system.md` — don't rebuild that here. This smaller task is just about non-photo quick actions from the home screen.

- PWA shortcuts in `manifest.json`: `📝 New Note`, `🔨 New Job`, `👷 New Sub`, `🎯 Add Lead` (long-press the dashboard icon on iOS/Android)
- Thumb-optimized `/capture` page with voice dictation (Web Speech API)
- Optional iOS Shortcut on top for true Lock Screen widget + share-sheet capture from Apple Notes / Keep / Safari

### 🟡 Apple Notes / Google Keep integration
Bundles with mobile capture. Both have no usable API — only feasible via iOS Shortcut → `/api/capture`. Tabled until mobile capture ships.

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

1. **Photo storage model** — R2-primary (recommended) vs Drive-primary vs hybrid. Sleep-on item. Now the next thing blocking forward progress on the photos track.
2. **Social publish channel** — Metricool API (preferred, Tony already has account) vs Zapier vs manual approval-only.
3. **Alert recipient** — currently `tony@homesolutionsar.com`. Optional follow-up: create a Google Workspace alias `ops@homesolutionsar.com` and switch `ALERT_EMAIL_TO`. No code change, just `wrangler secret put`.

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
- Resend sending domain: `send.homesolutionsar.com`

### Cron schedule (all in `wrangler.toml`)
```
*/30 * * * *   Jobber + WC sync
15 * * * *     Heartbeat (alerts if sync >4h stale) + DLQ replay
15 7 * * *     Nightly D1→R2 backup + 30-day retention sweep (02:15 Central)
0 12 * * *     Daily summary email (07:00 Central)
```

---

## Recommended first ask in the new chat

Pick one:

> "Read `HANDOFF.md` and confirm you're caught up. I've decided on photo storage: **&lt;R2-primary | Drive-primary | hybrid&gt;**. Let's start the photos foundation."

> "Read `HANDOFF.md` and confirm you're caught up. Quick win first — I want the **mobile capture** page wired up so I can use this from my phone properly."

> "Read `HANDOFF.md` and confirm you're caught up. The reliability pass is shipped; what makes the most sense to tackle next?" (Lets the AI propose the path based on current state.)

Whichever path you pick, the AI should start by reading this file end-to-end, then proposing a plan before writing any code.
