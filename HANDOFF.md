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
│   ├── theme.css ......................... 🎨 brand source of truth (palette + base + page wash). Edit :root here to recolor everything.
│   ├── index.html ........................ main dashboard (KPIs, quick launch, kanban)
│   ├── jobs.html ......................... native Job Tracker
│   ├── notes.html ........................ native Smart Notes
│   ├── subs.html ......................... native Subcontractor Reference List
│   ├── manifest.json + sw.js ............. dashboard PWA basics ("CHS Command")
│   └── capture/ .......................... 🆕 CHS Capture PWA (photos + voice notes)
│       ├── index.html .................... single-page shell (Home/Camera/Review/Voice/Switch/Pending)
│       ├── manifest.json ................. distinct icon, scope=/capture/, installed as separate PWA
│       ├── styles.css .................... mobile-first; pulls palette from /theme.css
│       ├── app.js ........................ camera + canvas thumb + voice + queue UI
│       ├── queue.js ...................... shared IndexedDB queue (loaded by both app.js and sw.js)
│       └── sw.js ......................... service worker: drains queue on Background Sync / message
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

### 🟢 Native expense capture in PWA (after photos foundation, ~3–4 hours)

> **Decision locked 2026-04-25**: Option A — native PWA capture with Jobber write-back. Receipts get snapped on-site, Tony stays out of the Jobber app. Currently `expenses` is a read-only table fed by Jobber sync; this adds a write path.

**Why this is locked to Option A and not "stay in Jobber":** the whole point of the PWA is on-site capture without app-switching. Logging an expense by leaving the photos PWA, opening Jobber, finding the job, and entering the receipt defeats the purpose. The cost of native capture is one new endpoint and a small UI; the savings is real (Tony stops dropping receipts because Jobber's mobile expense flow is slow).

**Build steps** when the time comes:
1. **Migration**: extend `expenses` table with `vendor TEXT`, `receipt_r2_key TEXT`, `entered_via TEXT` (`'jobber'` vs `'pwa'`), `pushed_to_jobber_at TEXT`, `jobber_id TEXT NULL` (filled in after write-back succeeds).
2. **Endpoint**: `POST /api/expenses` — accepts `{ job_id, amount, vendor, description, incurred_at, receipt_blob }`. Stores blob in R2 at `expenses/{job_id}/{yyyy-mm-dd}/{sha256}.jpg`, row in D1 with `entered_via='pwa'`, returns the new ID.
3. **Jobber write-back**: investigate Jobber GraphQL mutation for expense creation (likely `expenseCreate` or similar — need to confirm in the API explorer with `JOBBER_TOKEN`). On success, fill `jobber_id` and `pushed_to_jobber_at`. On failure, leave the row PWA-local and show a yellow "not yet synced to Jobber" badge in the dashboard so Tony knows to reconcile.
4. **PWA UI**: tap "Log expense" on PWA Home → screen with active-job tile (same toggle pattern as voice notes — Active job / General; "General" maps to `job_id = null` for "office supplies, not a job"), receipt photo button (uses same camera primitive as the photos flow), amount + vendor + description fields, optional voice-dictation on description (reuse the voice-note recorder, transcript-only mode).
5. **Dashboard**: existing job drill-down already shows expenses; just add the "entered via PWA" badge and the "not synced to Jobber" badge for failed write-backs.

**Open question to resolve before building**: confirm Jobber GraphQL supports expense write. If it doesn't, downgrade to **Option B** (PWA-local only, reconcile in Jobber weekly) — but check first; this is a 5-minute test in their API explorer.

**Wireframe placeholder**: the `Log expense` button on the PWA Home screen in `canvases/pwa-capture-wireframe.canvas.tsx` is rendered as a dashed-border `v2` button so it's visible but obviously unwired.

### 🟢 Social media system (after photos)

> **Spec:** `docs/03-social-media.md` is the authoritative plan (monthly plan generator, approval queue, Flux Pro image gen, Hashtag Bank + Caption Templates, Metricool hand-off). Anchored on Tony's existing `CHS_ProjectInstructions_and_SOP` doc + `ColumbusHomeSolutions_SocialMedia_System` sheet. Read it before writing any code.

Wait until photos foundation exists. Then:
- D1 `social_drafts` table referencing photo IDs
- `/social` composer page (pick photos, write caption, schedule)
- Approval queue (manual approval per the original spec)
- Metricool API for actual publishing (or zapier-glue if Metricool API isn't suitable)

**Content creation tooling — decide as part of this build:** the spec currently lists Flux Pro for image gen, but the "content creation section" should be expanded to enumerate every app/service we land on for image gen, video gen, caption drafting, etc. (e.g., Flux Pro, possibly Canva, possibly Runway, possibly others). Tony will surface candidates as the build approaches. Record the final stack in `docs/03-social-media.md` and reflect it in the dashboard's content-creation surface so the team sees the canonical toolset, not just whatever I happened to wire up first.

### 🟡 Live updates — dashboard + public site without manual refresh

> **Source:** raised by Tony 2026-04-25 — "test and fine-tune the high-level connection so it updates on the website and the dashboard without having to refresh every time."

**Current behavior**
- Dashboard reads from D1 + HighLevel proxy on every page load. The Lead Pipeline (Kanban) is HL-backed and only reflects HL state at the moment the page rendered. To see a card move that another user (or HL workflow) made, you have to hit Refresh.
- KPIs and Jobs come from D1, which is itself updated only every 30 minutes by the Jobber sync cron. So even an auto-refresh on the dashboard would lag job activity by up to 30 min.
- The public website (whatever surface this refers to — likely `homesolutionsar.com` or a Squarespace/marketing site, **clarify before building**) presumably reads from the same upstreams or its own cache.

**Fix paths, ranked by effort**

1. **Cheap win (~1 hr): periodic background fetch on the dashboard.** Add a `setInterval` on each page (15s for HL Kanban, 60s for KPIs/Jobs) that re-fetches the data and patches the DOM in place. Show a subtle "updated 12s ago" indicator. Doesn't fix the 30-min Jobber lag, but kills the manual-refresh annoyance for HL.
2. **Medium (~3 hrs): HighLevel webhook → Worker → SSE/WebSocket fan-out.** HL fires a webhook when a lead/contact/opportunity changes; Worker pushes the update to any open dashboard via Server-Sent Events. Truly live for HL events; KPIs still need polling.
3. **Big (~6+ hrs): full live-sync model.** Jobber webhooks (when scopes allow) → Worker → D1 update → SSE push to dashboard. Eliminates the 30-min lag too. Worth doing only if (1) and (2) aren't enough and Jobber permits webhook scopes for the events we care about.

**Recommendation**: ship (1) first as a 1-hour quality-of-life patch, evaluate, then decide whether (2) and (3) are worth the complexity. Don't skip (1) and jump straight to webhooks — polling at 15s is genuinely fine for a 1-person ops team, and the webhook plumbing is non-trivial to debug.

**Open question before any work**: which "website" — the marketing site, the dashboard itself, or both? If it's a Squarespace-style site, "live updates" there is a different problem (probably Zapier-driven content) and needs a separate issue.

### 🟡 Mobile quick-capture (small win, ~1–2 hours)

> **Note:** The "big" mobile capture flow (photos + voice notes on a job site) shipped 2026-04-25 as the **CHS Capture** PWA at `/capture/` — see "Photos system" above. This smaller task is what's *left*: extra non-photo quick actions and OS integrations.

- Long-press shortcuts on the **dashboard** PWA (not CHS Capture): `🔨 New Job`, `👷 New Sub`, `🎯 Add Lead` in `dashboard/manifest.json`. (CHS Capture already has `📷 Take a Photo` and `🎙️ Voice Note` shortcuts.)
- Optional iOS Shortcut on top for true Lock Screen widget + share-sheet capture from Apple Notes / Keep / Safari into `/api/notes`.

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
