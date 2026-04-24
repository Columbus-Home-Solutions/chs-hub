# CHS Hub — Session Handoff

> **For Tony:** Open Cursor on `~/projects/chs-hub`, start a brand new chat, and paste the contents of this file as your first message. Then say _"Read HANDOFF.md and confirm you're caught up. I want to work on **&lt;X&gt;** today."_

> **For the next AI session:** This is the source of truth for project state as of **Apr 24, 2026**. Trust this over any older context. The previous chat (where the dashboard rebuild happened) was archived because it had become unwieldy. All work since the migration playbook (archived at `docs/archive/migration-playbook.md`) has happened in this repo, `chs-hub`.

---

## TL;DR — where we are

We are deep into **Phase 7** of the original migration playbook (the "dashboard rebuild" phase). What was originally going to be a separate `chs-automation` repo (Phase 6) got merged into this one, so `chs-hub` now contains:

- The Cloudflare Worker backend (Jobber sync + KPIs + drill routes + WC workbook auto-export + HighLevel proxy + Smart Notes API + Jobs API + Subcontractor API)
- The D1 database (jobs, invoices, line_items, payments, expenses, quotes, notes, subcontractors)
- The static dashboard frontend (vanilla HTML/CSS/JS served from Cloudflare Pages at `dashboard.homesolutionsar.com`)
- The Cloudflare Pages docs site (`docs.homesolutionsar.com`)

The dashboard is **live, in daily use, and stable**. The Jobber → D1 pipeline runs on a cron schedule, the WC Google Sheet auto-syncs every 30 minutes, and HighLevel is wired through a server-side PIT proxy.

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
```

**Production URLs**
- Dashboard: `https://dashboard.homesolutionsar.com`
- Worker (raw, not behind Access): `https://chs-hub.tony-bc5.workers.dev`
- Docs: `https://docs.homesolutionsar.com`
- Wealthy Contractor sheet: hardcoded in `dashboard/index.html`
- HighLevel location ID: `lZ8L8FAf6K2niuHoFbaw`

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
│   └── 0004_subcontractors.sql
├── src/
│   ├── index.ts .......................... Worker entry + router + scheduled handler
│   ├── env.ts ............................ Env interface (secrets + bindings)
│   ├── routes/
│   │   ├── kpis.ts ....................... GET /api/kpis  (dashboard KPI tiles)
│   │   ├── drill.ts ...................... GET /api/drill/:type  (KPI drilldowns)
│   │   ├── jobs.ts ....................... /api/jobs + /api/jobs/:id
│   │   ├── notes.ts ...................... /api/notes CRUD
│   │   ├── subs.ts ....................... /api/subs CRUD
│   │   ├── search.ts
│   │   ├── hl.ts ......................... /api/hl/* (HighLevel PIT proxy)
│   │   ├── sync.ts ....................... Jobber → D1 sync
│   │   ├── sheets-debug.ts ............... /api/debug/sheets-inspect
│   │   └── wc-sync.ts .................... POST /api/wc/sync (manual + scheduled)
│   └── lib/
│       ├── google/
│       │   ├── auth.ts ................... Service account JWT signing
│       │   └── sheets.ts ................. Sheets v4 REST client
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

### Auth + secrets
- ✅ Cloudflare Access protecting dashboard for tony@homesolutionsar.com only
- ✅ Worker secrets: `JOBBER_*`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `HL_PRIVATE_TOKEN`, `CLAUDE_*`
- ✅ Wrangler vars: `HL_LOCATION_ID`

### Legacy (frozen, do not touch)
- 🟡 `chs-estimator-seeder` — quarterly Jobber pricebook → Sheets sync. Still runs. Not under active development.
- 🟡 Old Python `jobber_sync.py` in `chs-dashboard` — superseded by this repo's sync. Cron is OFF. Don't re-enable.

---

## Active backlog (priority order)

### 🔴 Reliability debt (recommended next, ~half day)
Carryover from the original Phase 6 plan that we shortcut. Worth doing before adding new features so we have a safety net:
- [ ] **Heartbeat alert** — if Jobber sync hasn't succeeded in 4+ hours, send email/SMS
- [ ] **Dead-letter table** in D1 for failed sync events + hourly retry job
- [ ] **Nightly D1 → R2 backup** with 30-day retention
- [ ] **Daily summary email** ("everything is fine, X jobs synced, Y new leads")

Lower priority Phase 6 items, probably not worth doing:
- ~~Jobber webhook receiver~~ — polling is fine at current scale
- ~~Append-only event log with `event_id` dedup~~ — overkill for current volume
- ~~Replay command~~ — would only matter if we had the event log

### 🟢 Photos system (planning phase — open decision)

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

---

## Open decisions for Tony

1. **Photo storage model** — R2-primary (recommended) vs Drive-primary vs hybrid. Sleep-on item.
2. **Build order** — Reliability pass → photos → social → mobile? Or photos first because it unblocks more of the original vision? Recommend reliability first to lock in what we have.
3. **Social publish channel** — Metricool API (preferred, Tony already has account) vs Zapier vs manual approval-only.

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
# Force a Jobber sync (requires SYNC_SECRET)
curl -X POST https://chs-hub.tony-bc5.workers.dev/api/sync \
  -H "Authorization: Bearer $SYNC_SECRET"

# Force a WC workbook sync
curl -X POST https://chs-hub.tony-bc5.workers.dev/api/wc/sync \
  -H "Authorization: Bearer $SYNC_SECRET"

# Inspect the WC sheet's structure
curl https://chs-hub.tony-bc5.workers.dev/api/debug/sheets-inspect
```

### Key IDs
- D1 DB name: `chs-hub-db`
- R2 bucket: `chs-hub-files`
- HL location: `lZ8L8FAf6K2niuHoFbaw`
- WC sheet ID: `1utmYdBkUM8cefQ-1mpEnhiyV-vVf-IOhN1yn_wfXyZo`
- Old Subcontractor sheet (now retired, copy of structure lives in D1): `1L7Ai9p-GTDuwlozh5ssGWRGkrP1AC3SLIrmwOsTEgW0`

---

## Recommended first ask in the new chat

Pick one:

> "Read `HANDOFF.md` and confirm you're caught up. Today I want to ship the **reliability pass** — heartbeat alert, dead-letter table, and nightly R2 backup. Walk me through what you'd build first."

> "Read `HANDOFF.md` and confirm you're caught up. I've decided on photo storage: **&lt;R2-primary | Drive-primary | hybrid&gt;**. Let's start the photos foundation."

> "Read `HANDOFF.md` and confirm you're caught up. Quick win first — I want the **mobile capture** page wired up so I can use this from my phone properly."

Whichever path you pick, the AI should start by reading this file end-to-end, then proposing a plan before writing any code.
