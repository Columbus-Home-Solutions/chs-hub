# CHS Operational Hub — Rebuild Architecture

**Status:** Draft v0.1 — awaiting Tony's review
**Target start:** Phase 6 of the migration playbook
**Deprecates:** the Sheets-based `chs-dashboard` data pipeline (dashboard UI lives on, but rebuilt)
**Author:** Claude + Tony

---

## 1. Why we're doing this

The current system is a pile of patches on a foundation that was never meant to support an operational hub:

- Google Sheets is being used as a database (merged cells silently eat writes, quota limits throttle reads, human edits break pipelines)
- Two independent Jobber apps share one refresh token that rotates on every use (endless "token invalidated" fires)
- The dashboard is static HTML that reads directly from Sheets API at runtime (OAuth drift, cache staleness, slow loads)
- Jobber rate limits are hit on ~50-job fetches because we ask for too much data per query
- No local dev, no tests, no observability, no query layer

Every one of these is fixable in the current design. But every fix stacks onto the next and the whole thing gets more fragile, not less. And we haven't even started adding **HighLevel, Google Tasks, Google Meet, smart notes, central command bar** — all the things that are supposed to make the dashboard a real operational hub.

Rebuilding on a proper foundation now saves us from patching forever.

---

## 2. Design principles

1. **One source of truth per domain.** Jobber owns job/customer/quote/invoice state. HighLevel owns lead state. Google owns tasks and meetings. Our job is to sync, cache, and surface — never to redefine.
2. **Database is a cache, not a report.** D1 is populated by scheduled syncs. If D1 is wiped, a full resync restores it from source systems. Nothing critical lives *only* in D1.
3. **Sheets are export targets, not inputs.** The WC KBPI sheet is a read-only export the coach sees. No downstream system reads from Sheets.
4. **Idempotent by default.** Every sync job can run twice in a row with the same result. If it crashes halfway, the next run fixes it.
5. **Observable.** Every sync writes a row to a `sync_log` table: start time, end time, rows affected, errors. You can see "did last night's sync work?" at a glance.
6. **No secrets outside Cloudflare.** Refresh tokens, API keys, OAuth state — all in Workers Secrets / KV, never GitHub, never `.env` files in repos.

---

## 3. Target stack

| Layer | Tool | Why |
|---|---|---|
| DNS | Cloudflare DNS (eventually) | One place for all records. Not required for rebuild — we use Cloudflare Pages' default domain first, cut over later. |
| Edge compute | Cloudflare Workers | Cron triggers, HTTP API, runs close to user, free tier fits our volume |
| Database | Cloudflare D1 (SQLite) | Native to Workers, real SQL, 5GB free, no network latency from Workers |
| **File storage** | **Cloudflare R2** | **Unlimited objects, zero egress fees, signed URLs for sharing, S3-compatible** |
| Secrets | Workers Secrets + KV | Rotated tokens live in KV, immutable secrets (client ID, etc.) in Workers Secrets |
| Frontend | Cloudflare Pages (vanilla HTML/JS + Tailwind, installable as PWA) | Same deploy pipeline as backend, auto-preview URLs per PR, mobile capture via PWA |
| Job queue | Cloudflare Queues | Scheduled + retryable background jobs (AI image gen, large file processing, etc.) |
| Logs/observability | Workers Logpush + D1 `sync_log` + `audit_log` tables | Real-time + historical view of runs and user actions |
| Code repo | Single monorepo `chs-hub` under `Columbus-Home-Solutions` | Worker, frontend, schema, all in one place |

**Retired:**
- GitHub Actions (replaced by Workers cron)
- Google Apps Script (D1 replaces its purpose)
- `JOBBER_REFRESH_TOKEN` as GitHub secret + rotator PAT (moved to KV)
- `chs-dashboard` repo becomes frozen / archived after cutover
- **Claude Cowork nightly photo sort** (Workers cron replaces it — no laptop dependency, runs reliably 24/7)
- **iPhone Shortcut → Google Drive `_Incoming`** (PWA native photo capture replaces it)

**Retained:**
- `chs-estimator-seeder` — completely separate, for the quarterly Jobber pricebook sync. Not touched by this rebuild.
- Jobber Developer app (might want two apps: one for seeder, one for hub — but not urgent)
- WC KBPI Google Sheet (becomes a downstream export)
- Squarespace main website (not part of this — hub is at a subdomain)
- **Metricool** as the social media scheduler (no API integration needed — manual approve-and-paste stays, the hub just eliminates everything leading up to the paste)
- **The structure of Tony's Drive SOP** as a conceptual model — the hub enforces the same logical organization (per-job file buckets, before/progress/final categories) even though physically stored in R2

---

## 4. Data model (D1 schema, first cut)

```sql
-- Jobber entities (mirror what we need, not everything Jobber offers)

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,                    -- Jobber node ID
  job_number INTEGER,
  title TEXT,
  status TEXT,                            -- ACTIVE, COMPLETED, etc.
  client_id TEXT REFERENCES clients(id),
  source TEXT,
  total REAL,
  created_at TEXT,                        -- ISO date
  start_at TEXT,
  completed_at TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_created_at ON jobs(created_at);
CREATE INDEX idx_jobs_completed_at ON jobs(completed_at);
CREATE INDEX idx_jobs_status ON jobs(status);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT,
  email TEXT,
  address_street TEXT,
  address_city TEXT,
  address_state TEXT,
  address_postal TEXT,
  custom_fields TEXT,                     -- JSON blob
  synced_at TEXT NOT NULL
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  quote_number INTEGER,
  status TEXT,                            -- DRAFT, APPROVED, CONVERTED, etc.
  subtotal REAL,
  created_at TEXT,
  transitioned_at TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX idx_quotes_transitioned_at ON quotes(transitioned_at);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  status TEXT,
  total REAL,
  payments_total REAL,
  issued_date TEXT,
  due_date TEXT,
  synced_at TEXT NOT NULL
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  invoice_id TEXT REFERENCES invoices(id),
  amount REAL,
  collected_at TEXT,                      -- derived from createdAt or adjustmentDate
  synced_at TEXT NOT NULL
);
CREATE INDEX idx_payments_collected_at ON payments(collected_at);

CREATE TABLE line_items (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  name TEXT,
  quantity REAL,
  unit_price REAL,
  unit_cost REAL,
  synced_at TEXT NOT NULL
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  amount REAL,
  description TEXT,
  incurred_at TEXT,
  synced_at TEXT NOT NULL
);

-- HighLevel entities (Phase 6b)

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT,
  email TEXT,
  source TEXT,                            -- where the lead came from
  status TEXT,                            -- new, contacted, qualified, etc.
  assigned_to TEXT,
  created_at TEXT,
  last_contact_at TEXT,
  synced_at TEXT NOT NULL
);

-- File storage + media (all files live in R2, D1 is the index)

CREATE TABLE files (
  id TEXT PRIMARY KEY,                    -- UUID
  r2_key TEXT NOT NULL UNIQUE,            -- object key in R2 bucket
  filename TEXT NOT NULL,                 -- original filename
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,                            -- for dedup + integrity
  uploaded_by TEXT REFERENCES users(id),
  uploaded_at TEXT NOT NULL,

  -- Association (nullable — a file can be orphaned or shared)
  job_id TEXT REFERENCES jobs(id),
  lead_id TEXT REFERENCES leads(id),
  estimate_id TEXT REFERENCES estimates(id),

  -- Categorization (matches SOP intent: Before, Progress, Final, Issues, etc.)
  category TEXT,                          -- 'before', 'progress', 'final', 'issues',
                                          -- 'blueprint', 'contract', 'invoice',
                                          -- 'receipt', 'ai_generated', 'social_ready'
  taken_at TEXT,                          -- from EXIF or upload time

  -- Mobile capture context
  captured_lat REAL,
  captured_lon REAL,
  captured_by_device TEXT,                -- user-agent or device id

  -- Versioning / lifecycle
  deleted_at TEXT,                        -- soft delete
  archived INTEGER DEFAULT 0              -- 1 = moved to archive/completed
);
CREATE INDEX idx_files_job ON files(job_id, category);
CREATE INDEX idx_files_lead ON files(lead_id);
CREATE INDEX idx_files_taken ON files(taken_at);
CREATE INDEX idx_files_social ON files(category) WHERE category = 'social_ready';

CREATE TABLE file_tags (
  file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,                      -- 'hvac', 'kitchen_demo', 'before_shot', etc.
  PRIMARY KEY (file_id, tag)
);

CREATE TABLE file_shares (
  id TEXT PRIMARY KEY,                    -- share token (goes in URL)
  file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  shared_with_email TEXT,                 -- nullable for public links
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,               -- all shares expire
  last_viewed_at TEXT,
  view_count INTEGER DEFAULT 0
);

-- AI-generated content provenance

CREATE TABLE ai_generations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                     -- 'image', 'caption', 'estimate_extract', 'monthly_plan'
  file_id TEXT REFERENCES files(id),      -- if the output is a file
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,                    -- 'claude-sonnet-4.5', 'flux-pro-1.1', etc.
  cost_cents INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  generated_at TEXT NOT NULL,
  generated_by TEXT REFERENCES users(id)
);

-- Estimating app

CREATE TABLE estimates (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id),
  status TEXT NOT NULL,                   -- 'draft', 'reviewed', 'sent_to_jobber', 'won', 'lost'
  jobber_quote_id TEXT,                   -- set after push to Jobber

  -- Input files (via files.estimate_id FK)
  -- Extracted data
  extracted_scope TEXT,                   -- JSON: rooms, dimensions, materials noted
  extracted_items TEXT,                   -- JSON: line items derived from uploads

  -- Composed estimate
  line_items TEXT,                        -- JSON: final line items with pricing
  subtotal REAL,
  total REAL,
  margin_percent REAL,

  -- Metadata
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

-- Users (employees, eventually with roles)

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,                     -- 'owner', 'admin', 'crew_lead', 'crew', 'office'
  default_crew TEXT,
  current_job_id TEXT REFERENCES jobs(id),  -- "last job I uploaded to" for PWA convenience
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  disabled INTEGER DEFAULT 0
);

-- Integrations (tokens, config) — generic shape so every external service is uniform

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,                    -- 'jobber', 'highlevel', 'google_tasks', 'metricool'
  kind TEXT NOT NULL,                     -- 'oauth', 'api_key', 'webhook'
  config TEXT,                            -- JSON: service-specific
  access_token TEXT,                      -- encrypted
  refresh_token TEXT,                     -- encrypted
  token_expires_at TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Operational tables

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,                 -- 'jobber_full', 'highlevel_leads', etc.
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,                   -- 'running', 'success', 'error', 'throttled'
  rows_affected INTEGER DEFAULT 0,
  error_message TEXT,
  duration_ms INTEGER
);
CREATE INDEX idx_sync_log_started ON sync_log(started_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,                   -- 'file.upload', 'file.share', 'estimate.send', etc.
  entity_type TEXT,
  entity_id TEXT,
  metadata TEXT,                          -- JSON
  ip_address TEXT,
  user_agent TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_audit_user_time ON audit_log(user_id, occurred_at);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

CREATE TABLE kv_cache (
  key TEXT PRIMARY KEY,                   -- e.g. 'last_full_sync_cursor'
  value TEXT,
  updated_at TEXT NOT NULL
);
```

Schema is **additive** — we can add `notes`, `tasks`, `meetings`, `social_posts` tables in later sessions without disturbing existing ones.

---

## 5. Sync strategy

### 5.1 Jobber sync

**Frequency:** every 30 min via Workers cron (tunable)

**Strategy:** delta sync, not full rebuild
- Track `last_full_sync_at` and `last_incremental_sync_at` in `kv_cache`
- Each run asks Jobber for jobs/quotes/invoices/payments where `updated_at > last_incremental_sync_at`
- Upsert (`INSERT ... ON CONFLICT DO UPDATE`) into D1
- This is **dramatically cheaper** than re-fetching 500 jobs every run
- Full sync (no `updated_at` filter) runs once/day at 3 AM to catch drift

**Rate limit behavior:**
- Use Jobber's own `extensions.cost.throttleStatus` hints to wait
- D1 caches everything — if one sync fails, the next one resumes from last successful cursor
- Worst case: sync falls behind by 1-2 hours. Dashboard still shows last-synced data, not zeros.

### 5.2 HighLevel sync

**Frequency:** every 15 min

**Strategy:**
- Pull leads via HL API (likely `GET /contacts` with `updatedAt > X` filter)
- Upsert into `leads` table
- Webhook-based push from HL is possible later for true real-time (Phase 6c)

### 5.3 Google Tasks / Calendar (Meetings)

**Strategy:**
- OAuth once from the frontend, store tokens in D1 `kv_cache`
- Worker uses stored tokens to pull tasks + calendar events every 5 min
- Read-only to start; write-back ("create task from dashboard") is a later feature

### 5.4 Smart notes

**Strategy:**
- Dashboard has a "notes" input
- On submit → Worker API → stores in `notes` table + asynchronously classifies via Claude API (category, priority, related entity — client? job?)
- Notes appear in a searchable list, grouped by category, linkable to jobs/clients

---

## 6. API layer

Single Worker at `api.chs-hub.dev` (or whatever subdomain — we'll pick one). Exposes:

```
# Metrics + entities
GET  /api/kpis                           → dashboard top-level KPIs (YTD rev, profit, jobs, etc.)
GET  /api/kpis/weekly?start=YYYY-MM-DD   → weekly snapshot for WC export
GET  /api/jobs?year=2026&status=ACTIVE   → filterable job list
GET  /api/jobs/:id                       → single job detail
GET  /api/clients?search=...             → client search
GET  /api/leads?status=new               → HighLevel lead feed
GET  /api/tasks                          → Google Tasks
GET  /api/meetings/today                 → today's calendar

# Files (R2-backed)
POST /api/files/upload-url               → returns pre-signed R2 URL for direct browser→R2 upload
POST /api/files/:id/finalize             → records metadata in D1 after upload completes
GET  /api/files?job_id=X&category=Y      → list files (with signed view URLs)
GET  /api/files/:id                      → single file detail + signed URL
PATCH /api/files/:id                     → update tags, category, associations
DELETE /api/files/:id                    → soft delete
POST /api/files/:id/share                → create a shareable link (expires)

# Estimating app
POST /api/estimates                      → create draft from uploaded files
GET  /api/estimates/:id                  → full draft with extracted data + composed items
PATCH /api/estimates/:id                 → edit line items, margin, etc.
POST /api/estimates/:id/analyze          → (re)run AI extraction on attached files
POST /api/estimates/:id/send-to-jobber   → push as client + quote

# Social media
POST /api/social/monthly-plan            → Claude generates next month's plan
GET  /api/social/approval-queue          → this week's posts awaiting review
POST /api/social/posts/:id/approve       → mark approved, optional tweak caption
POST /api/social/posts/:id/generate-image → AI image gen for this post

# Notes
POST /api/notes                          → create note (async Claude classifies)
GET  /api/notes?q=...                    → search notes

# System
GET  /api/sync-status                    → last successful run of each sync
POST /api/sync/trigger/:name             → manually kick off a sync (admin-gated)
GET  /api/audit?entity_id=X              → audit trail for a file/estimate/etc.
```

**Auth:** one shared secret header for now (same approach as current). Phase 7 upgrades to Cloudflare Access or proper OAuth.

**Response time:** most endpoints should return in <50ms since they're SQL queries over edge-local D1. Compare to current 500-2000ms for Sheets API reads.

---

## 7. Frontend

### 7.1 Decision: vanilla HTML vs Next.js vs Svelte

**Recommendation: vanilla HTML/JS + Tailwind, served as static assets from Cloudflare Pages**

Reasoning:
- Current dashboard is already vanilla HTML — no framework migration pain
- Your dashboard is mostly "fetch JSON, display" — doesn't need a framework
- Zero build complexity, fastest deploys
- Can upgrade to Next.js later if we need server-rendered pages or auth flows

If you prefer I can make the case for Next.js — it's a defensible choice too, especially for the smart notes / auth flows. But it's more moving parts.

### 7.2 Page structure

```
/                    → dashboard home (KPIs + business pulse)
/jobs                → job list / filter / detail
/leads               → HighLevel lead board
/tasks               → Google Tasks view
/schedule            → Google Calendar / meetings
/notes               → smart notes
/admin/sync-status   → sync log viewer
```

All served from Pages. Client-side routing with a tiny router (~30 lines), or just page-per-page with real URLs. Lean toward real URLs — simpler, better for bookmarks, better for you to open specific pages from Raycast/Alfred.

### 7.3 What we keep from the current dashboard

- The visual design (colors, fonts, layout feel)
- The command bar concept
- The launcher-for-external-tools pattern
- The PWA capability (installable to home screen)

We rebuild the data fetching and plumbing. UI polish transfers.

---

## 8. Integrations — timeline (refined with full Cloudflare-native scope)

This reflects the interleaved plan that alternates hub features with estimating app milestones, so Tony gets shippable value every session.

| Session | Delivers | Dependencies |
|---|---|---|
| **6a** — Foundation | D1 schema, Worker scaffold, R2 bucket, Queues, Jobber sync (delta), KPI API, service account for any remaining Drive reads | Nothing |
| **6b** — Dashboard frontend + cutover | New dashboard on Pages (KPIs, business pulse), WC sheet export Worker, DNS cutover | 6a |
| **7** — PWA + file system foundation | Mobile PWA installable, photo capture flow, file upload/browse/share, user model (single user for now), audit log | 6a |
| **8a** — Social media: monthly plan generator | Worker endpoint calls Claude with Project instructions + featured jobs, writes plan to D1, surfaces in dashboard for manual copy to Metricool | 6a, 7 (for photo picker) |
| **8b** — Estimating M1+M2 | File upload UI for estimating, Claude Vision on single photo → structured extraction | 7 |
| **9** — HighLevel integration | Lead sync → D1, leads page on dashboard, lead-to-estimate flow | 6a |
| **10** — Estimating M3+M4 | Multi-file extraction (blueprints + photos + docs), pricebook composition → draft estimate | 8b, pricebook data (already exists in seeder) |
| **11** — Google integrations | Google Tasks sync, Google Calendar/Meetings read, dashboard pages | 6a |
| **12** — Estimating M5+M6 | Market-rate overlay (uses existing `market-rates-workflow.md`), review/edit UI | 10 |
| **13** — Estimating M7+M8 | Jobber write mutations: createClient + createQuote. Full upload→Jobber quote flow | 12 |
| **14** — Social media: AI image generation | Worker calls Flux/DALL-E for Wed/Fri posts, drops into R2, surfaces in approval UI | 8a |
| **15** — Smart notes | Notes input, Claude auto-classification, entity linking (file/job/client), search | 6a, 7 |
| **16** — Polish + v1.0 | Performance tuning, error reporting, user onboarding flow, multi-user support prep | All |

**Cutover** happens end of 6b — `dashboard.homesolutionsar.com` flips from GitHub Pages to Cloudflare Pages, old `chs-dashboard` repo archived (not deleted).

**Key dates for Tony to feel concrete progress:**
- End of Session 6b (~Week 2): New dashboard live, old system retired
- End of Session 7 (~Week 3): PWA installable, first photos in the new system
- End of Session 8b (~Week 4): First AI-extracted estimate data from a real photo
- End of Session 10 (~Week 5-6): First full estimate draft generated by the system
- End of Session 13 (~Week 7-8): End-to-end: upload blueprint → Jobber quote with one click

---

## 9. Environments

- **Local dev:** `wrangler dev` runs the Worker locally with a local SQLite file. Frontend runs with `python -m http.server` or similar. Test before push.
- **Staging:** `staging.chs-hub.pages.dev` — auto-deployed from a `staging` branch. Points at a separate `chs_hub_staging` D1 database.
- **Production:** `dashboard.homesolutionsar.com` — auto-deployed from `main`. Points at `chs_hub_prod` D1 database.

Every PR gets its own preview URL automatically from Cloudflare Pages. You can click a link and see the live preview of any code change before merging.

---

## 10. Cost analysis

Cloudflare free tier:
- Workers: 100,000 requests/day free
- D1: 5 GB storage + 5M reads/day free
- Pages: unlimited free (100 builds/month, easily enough)
- KV: 100k reads/day + 1k writes/day free

Your expected volume:
- Syncs: ~48 Worker cron invocations/day (every 30 min Jobber + every 15 min HL)
- Dashboard loads: ~100-500/day (you + future employees)
- D1 queries per dashboard load: ~10
- Total D1 reads/day: ~5k, writes: ~2k

**You are 100x under every free tier limit.** Estimated monthly cost: **$0.** Even if you grow 10x in volume: still **$0**.

Only paid line item if you ever need it: Workers Paid at $5/mo for 10M requests/day. Not relevant unless you're running many thousands of customers.

---

## 11. Migration plan (sessions)

### Session 6a — Foundation (90 min)

**Goal:** Jobber data flowing into D1, API returning KPIs

1. Create Cloudflare account resources (Worker, D1 DB, KV namespace)
2. Create new GitHub repo `Columbus-Home-Solutions/chs-hub` with:
   - `/worker` — Cloudflare Worker (TypeScript)
   - `/frontend` — static site (comes in 6b)
   - `/schema` — D1 migrations
3. Run schema migration to create tables
4. Port `jobber_sync.py` logic to TypeScript Worker
5. Wire Worker cron trigger to run sync every 30 min
6. Expose `/api/kpis` endpoint
7. Verify D1 populated with live Jobber data via the API

**Deliverable:** `curl https://chs-hub-worker.<account>.workers.dev/api/kpis` returns real numbers.

**Parallel: old system keeps running.** No downtime, no risk.

### Session 6b — Frontend + cutover (2 hrs)

**Goal:** New dashboard live at `dashboard.homesolutionsar.com`, old one retired

1. Build new dashboard frontend in `/frontend` — matches current visual design, uses new API
2. Deploy to Cloudflare Pages
3. WC Sheet export Worker (reads from D1, writes to Sheet once a day)
4. Side-by-side testing: compare KPIs between old dashboard and new for accuracy
5. Update DNS: `dashboard.homesolutionsar.com` CNAME → Cloudflare Pages domain
6. Wait 24h, verify stable
7. Archive `chs-dashboard` repo (don't delete — safety net)
8. Disable `jobber_sync.yml` workflow

**Deliverable:** new dashboard serves traffic, WC sheet updates continue, old system offline.

### Session 7 — PWA + file system foundation (2-3 hrs)

**Goal:** Mobile PWA installable, native photo capture → R2, file browse/search UI

1. Provision R2 bucket, configure CORS for direct browser upload
2. Implement `POST /api/files/upload-url` (returns pre-signed URL)
3. PWA manifest + service worker for install-to-home-screen
4. Photo capture UI: camera access, multi-select, job picker, offline queue
5. File browse UI: filter by job/category/tag
6. Share links: signed, expiring URLs for clients
7. Seed user (Tony) — single user for now; multi-user scaffolding in place
8. Audit log wired for every file action

**Deliverable:** upload a photo from iPhone, see it appear in dashboard file browser, share it to a test email with expiring link.

### Session 8a — Social media: monthly plan generator (1-2 hrs)

**Goal:** One-click monthly plan generation matching Tony's Claude Project instructions

1. Port Tony's Claude Project instructions into Worker-side prompt
2. `POST /api/social/monthly-plan` endpoint — takes 4 featured jobs, returns 12-13 post calendar
3. Dashboard `/social/plan` page — shows generated plan, inline edit
4. Export to Metricool-friendly format (copy-paste or CSV)
5. No posting API integration (Tony confirmed manual paste stays)

### Sessions 8b onward — alternating estimating milestones + remaining integrations

See section 8 for full interleaved roadmap.

---

## 12. Risk + rollback

### Risks

- **Jobber query cost:** we still depend on Jobber's API. Rate limits still apply. But with delta sync + D1 caching, we hit Jobber much less often and tolerate throttles gracefully (serve stale data from D1 instead of showing zeros).
- **D1 learning curve (mine):** I've used D1, but it's newer than Postgres/MySQL. Edge cases possible. Mitigated by keeping old system running during rebuild for side-by-side verification.
- **OAuth complexity for Google:** Google OAuth for installed apps is fiddly. Might take one session longer than estimated. Mitigated by making Google integration optional — dashboard is functional without it.

### Rollback

**Before cutover (6a, 6b in progress):** nothing to roll back. Old system is untouched.

**After cutover:**
- If new system fails within 48h → flip DNS back to GitHub Pages, resume GitHub Actions workflow. Total recovery time: ~30 min. Old code is still in `chs-dashboard` repo (archived, not deleted).
- If new system fails after 48h → same plan, but we may have D1 data that needs reconciling with Sheets. Worst case: run the old full sync once to repopulate Sheets.

---

## 13. Decisions locked in (2026-04-24 session)

- ✅ **Full Cloudflare-native architecture** (Workers + D1 + R2 + Pages + Queues)
- ✅ **PWA-based mobile photo capture**, replacing Drive Shortcut + Cowork nightly sort
- ✅ **Hub repo name: `chs-hub`** under `Columbus-Home-Solutions`
- ✅ **Vanilla HTML/JS + Tailwind** for frontend (PWA-enabled)
- ✅ **Metricool stays manual** — no API integration; hub handles everything up to "click schedule"
- ✅ **Google Drive retired** from the data path (Drive stays available for one-off human file storage if needed, but isn't part of any automation)

## 14. Still-open questions (can wait until Session 6a prep)

1. **Image generation provider** for Wed/Fri AI posts — DALL-E 3, Flux Pro (recommended), or Gemini Imagen. We can quality-test in Session 14.
2. **Dashboard domain strategy long-term** — keep `dashboard.homesolutionsar.com` or consolidate under new main domain when website ships?
3. **Jobber app separation** — spin up a second Developer app for the hub so seeder and hub have independent tokens? (Recommendation: yes, 15 min in 6a)
4. **Market rate data source** — the existing `market-rates-workflow.md` describes pulling from a CSV. Stays as-is, or should we integrate a live API (Home Depot/Lowes/etc.)? Defer until Session 12.

---

## 15. What I need from you to start Session 6a

1. Cloudflare account access — we'll need to create a Worker, D1 database, R2 bucket, Queue, and KV namespace. If you don't have an account yet, sign up at cloudflare.com (free).
2. Your Anthropic API key (for Claude calls in the Worker). If you don't have one, grab at console.anthropic.com — pay-as-you-go, a few dollars a month max at your volume.
3. Jobber Developer app credentials (can reuse seeder's for now, splitting is a 6a step).
4. 90 minutes when you're not being interrupted.

---

## Appendix A — Why I'm recommending this over "fix what we have"

Things we'd need to fix in the current system to make it reliable long-term:
- Replace merged-cell writes with proper Sheets ranges (1 hr)
- Cache Jobber responses to a local SQLite in GitHub Actions (too fragile — GH runners are ephemeral, need cloud storage)
- Rewrite `jobber_sync.py` to do delta sync (4 hrs — but where do we store the cursor? Back to the same storage problem)
- Add retries + error observability around every API call (already doing this)
- Rewrite Apps Script to be resilient to schema changes in the sheet (2 hrs, fragile)
- Separate Jobber apps (15 min)
- Dashboard auth + token refresh (hard in static HTML, 4+ hrs if even feasible)
- Add HighLevel? Another Apps Script webhook, another sheet tab, another fragile link (3 hrs)
- Add Google Tasks? Now we need OAuth from the dashboard AND Apps Script AND GitHub Actions, three places for the token to drift (3+ hrs)

Cumulatively: ~20 hours of patches, and we still have Sheets as a database.

Rebuild: ~8-10 hours, and we have a foundation we can actually grow into.

The math is clear. And the cost of *not* doing it is that every new feature takes 3x longer forever.

---

## Appendix B — What DOESN'T change

- Jobber is still the source of truth for jobs/customers/quotes/invoices
- Your WC KBPI sheet stays the same format your coach sees
- `chs-estimator-seeder` repo is untouched (it's a different system with a different purpose)
- Your existing squarespace website is untouched
- Your phone number, your email, your business processes — all untouched
- Dashboard URL stays the same (we just point it at new infrastructure)

Reading this list should make it clear: this is plumbing work. Your business doesn't notice anything. You just get a dashboard that actually works, on a foundation that can grow.

---

*End of draft. Review this, mark up anything you want to change, and we'll finalize before Session 6a.*
