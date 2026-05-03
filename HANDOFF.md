# CHS Hub — Session Handoff

> **For Tony:** Open Cursor on `~/projects/chs-hub`, start a brand new chat, and paste the contents of this file as your first message. Then say _"Read HANDOFF.md and confirm you're caught up. I want to work on **&lt;X&gt;** today."_

> **For the next AI session:** This is the source of truth for project state as of **Apr 26, 2026**. Trust this over any older context. The previous chat (where the dashboard rebuild happened) was archived because it had become unwieldy. All work since the migration playbook (archived at `docs/archive/migration-playbook.md`) has happened in this repo, `chs-hub`.

### Next session — do in this order (Tony + agent)

1. **Gmail quick link (first)** — In `dashboard/index.html`, the Gmail tile uses `gmailQuickLink` and optional `localStorage` key `chs_gmail_quick_url` (full `https://` URL; `setItem` returns `undefined` in the console — that is normal). Finish any follow-up: verify desktop/mobile behavior, document if we change anything, or close it out. **Do this before Drive mirror.**
2. **Google Drive mirror (ground zero)** — After (1), follow **`docs/drive-mirror-resume.md`** (Worker secrets/vars, Google Shared Drive, then `GET` / `POST` `/api/ops/drive-mirror`).

### Backlog — dashboard polish & reliability (later)

- **Worker vars / Google OAuth** — Confirm production **`DASHBOARD_OAUTH_CLIENT_ID`** (and related dashboard `[vars]`) are set so Connect Google works; see `docs/google-oauth-dashboard.md`. Empty injection ⇒ broken OAuth.
- **Cloudflare Access friction** — Investigate having to complete an Access challenge (e.g. email OTP code) **on almost every page load**. Likely session duration, cookie settings, or multi-tab behavior; tune policy in Zero Trust (session length, “remember this device”, allowed IdPs).
- **Sync button** — Not working as expected; trace UI handler → `/api/sync/*` or Sheets/WC paths and fix.
- **Monthly revenue tile** — Often empty; **probably tied to sync / data fetch** (same pipeline as sync button or KPI sheet ranges); verify after sync works.
- **Theme / CSS flash or missing styles** — Sometimes **white background** and wrong fonts/colors until **hard refresh**; affects **main dashboard and subpages** (`jobs.html`, `notes.html`, etc.). Suspects: `theme.css` load order, caching, service worker, or FOUC — reproduce and fix so first paint matches the dark scheme reliably.
- **PDFs in the dashboard file system** — **Open / preview PDFs** from the hub file UI (inline viewer, new tab, or signed URL) instead of only download-or-unknown behavior.
- **Spreadsheet-native flows for docs** — **Open compatible files in Google Sheets** (or similar): upload/import path, “Open with…” link, or explicit export so operational docs aren’t stuck as opaque blobs in R2-only workflows.
- **External hard drive backup** — **Second-line backup** of the file corpus (and/or D1 export bundles) to a **local external drive** — operator-run script, scheduled Mac job, or documented rsync from existing R2/nightly NDJSON exports; complementary to cloud mirror + R2.
- **Upload workflow / Finder on Mac** — **File-explorer-style** dashboard UX to speed up **document uploads**; include a path to **open Finder** at a standard local folder (drag-drop, `<input webkitdirectory>` where useful). *Browsers cannot spawn Finder directly* — document a **Shortcuts / AppleScript one-liner** or tiny local helper if needed.

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

### Cron schedule (all in `wrangler.toml`)
```
*/30 * * * *   Jobber + WC sync
15 * * * *     Heartbeat (alerts if sync >4h stale) + DLQ replay
15 7 * * *     Nightly D1→R2 backup + 30-day retention sweep (02:15 Central)
0 12 * * *     Daily summary email (07:00 Central)
```

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
