# Sprint 3: Estimating Pipeline — Request Intake & Pipeline Board
## Cursor Prompt — CHS Construction Management Platform

---

## Context

You are continuing the CHS construction management platform build. This is a Cloudflare Workers + D1 + R2 backend with a Preact + Vite frontend. No React, no Tailwind, no ORM.

**Current state:**
- Sprint 1 ✅ deployed, tagged `v0.1.0-sprint1` — schema, auth, settings, heartbeat
- Sprint 2 ✅ committed and deployed, tagged `v0.2.0-sprint2` — Preact frontend, app shell, Client/Properties/Comms/Subs CRUD, repeat-client detection, `/api/me`

Sprint 3 builds the Estimating Pipeline — the front door of the entire platform. Every job starts here. Leads come in, get an appointment, get an estimate visit, and flow toward a quote. This sprint covers request intake and the pipeline Kanban board. The estimate builder itself is Sprint 4.

**Sprint 3 is local-only.** Do not deploy to remote. Do not touch the remote D1. Do not run any remote wrangler commands.

---

## Step 0: Explore Current State

Before writing any code, understand where Sprint 2 left things:

1. **Read `src/index.ts`** — understand the current route dispatcher and how clients/subs routes were wired in during Sprint 2. Follow this exact pattern for the new estimate-requests route.

2. **Read `src/routes/clients.ts`** — this is the reference pattern for a CRUD route module. The new `estimate-requests.ts` follows the same structure: auth guard, validation, D1 queries, audit logging, JSON responses.

3. **Read `src/middleware/guard.ts`** — auth guard pattern used on every protected route.

4. **Read `frontend/src/views/clients/ClientList.tsx`** — reference for how the client list fetches data and renders. The pipeline board follows the same data-fetching patterns.

5. **Look at the existing HL Kanban in the chs-hub dashboard** — the drag-to-update write-back pattern there is the model for drag-to-update on the new pipeline board. Carry it forward, don't reinvent it.

6. **Check `.gitignore`** — confirm `scripts/dev-seed-sprint2.local.sql` is already listed. The new `scripts/dev-seed-sprint3.local.sql` must be added before committing.

---

## Before Writing Any Code

Read these documents from the project knowledge in this order:

1. **cursorrules.md** — coding conventions, patterns, naming, architecture. This is law.
2. **CHS-Database-Schema.md** — `estimate_requests` table definition (Estimating Tables section)
3. **CHS-API-Route-Map.md** — Section 3 (Estimating & Quoting → Estimate Requests)
4. **Module-Spec-Estimating-Quoting.md** — pipeline stages, screen descriptions (sections 2, 6.1, 6.2, 6.3), business rules (section 7)
5. **CHS-Design-System.md** — tokens, component patterns (frontend matches Sprint 2 exactly)
6. **CHS-Build-Order-Plan.md** — Sprint 3 scope (you are here)
7. **Module-Spec-WC-Spreadsheet.md** — how lead count and appointment count sync works

---

## Sprint 3 Deliverables

### Backend

#### Migration: `migrations/0026_estimate_requests.sql`

Create the `estimate_requests` table exactly as defined in `CHS-Database-Schema.md`. Use `CREATE TABLE IF NOT EXISTS`. This migration runs on LOCAL D1 only this sprint.

Run it with:
```bash
npx wrangler d1 execute chs-hub-db --local --file=migrations/0026_estimate_requests.sql
```

Verify the table was created:
```bash
npx wrangler d1 execute chs-hub-db --local --command="SELECT name FROM sqlite_master WHERE type='table' AND name='estimate_requests';"
```

#### New route file: `src/routes/estimate-requests.ts`

Implement these endpoints following the exact same patterns as `src/routes/clients.ts`:

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/estimate-requests` | List all requests. Filters: `?status=xxx&job_type=xxx&lead_source=xxx&from=date&to=date` |
| GET | `/api/estimate-requests/pipeline` | Requests grouped by status (for Kanban board data) |
| GET | `/api/estimate-requests/:id` | Request detail |
| POST | `/api/estimate-requests` | Create new request. Triggers: lead count WC hook, repeat-client check |
| PUT | `/api/estimate-requests/:id` | Update request. On status → `appointment_set`: triggers appointment WC hook |
| PUT | `/api/estimate-requests/:id/appointment` | Set/update `appointment_date` and `appointment_completed` |
| PUT | `/api/estimate-requests/:id/lost` | Set status to `lost`, record `lost_reason` and `lost_notes` |

All write operations log to `audit_logs`. Auth guard on all routes (Owner/PM only).

Wire the new route into `src/index.ts` following the existing dispatch pattern.

#### WC Spreadsheet trigger hooks

In `src/services/wc-spreadsheet.ts` (carry forward from chs-hub), add two trigger functions:

- `triggerLeadCreated()` — called on `POST /api/estimate-requests`
- `triggerAppointmentSet()` — called when status changes to `appointment_set` or on `PUT /api/estimate-requests/:id/appointment`

These do not need to fire a full sync immediately. They should set a flag or enqueue so the next 30-minute cron cycle picks up the updated counts. Match the existing pattern already in the chs-hub WC sync code — do not reinvent the sync mechanism.

---

### Frontend

#### New view: `frontend/src/views/estimating/EstimateRequestPipeline.tsx`

Kanban board showing all estimate requests grouped by pipeline stage.

**Pipeline stages (columns, left to right):**
```
New Request | Appointment Set | Estimate Visit Done | Estimate Building | Estimate Sent | Follow-Up | Won | Lost
```

Each request card displays:
- Client name and phone
- Property address (city/state only on the card — full address on detail view)
- Job type badge (use existing `Badge` component from Sprint 2)
- Lead source label/icon
- Days in current stage (computed from `updated_at`)
- Appointment date if set
- Repeat-client indicator if `client.is_repeat_client = true`

**Desktop behavior:**
- Horizontal columns, each scrollable vertically if there are many cards
- Drag-to-update: drag a card to a new column → fires `PUT /api/estimate-requests/:id` with the new status → card reorders into the new column
- Carry forward the drag pattern from the existing HL Kanban in chs-hub — do not use a drag library not already in the project

**Mobile behavior:**
- Horizontal swipe between columns (one column visible at a time)
- Tab strip at the top showing column name and card count for each stage
- Tap a card to navigate to the detail view
- Floating action button (bottom right) for "New Request" → navigates to `/app/estimating/new`

#### New view: `frontend/src/views/estimating/EstimateRequestDetail.tsx`

Detail view for a single estimate request.

Sections:
- **Header:** Client name, property address (full), job type badge, lead source, status badge
- **Appointment:** Date/time display. "Set Appointment" button if not set. "Mark Complete" button if set and not completed.
- **Visit Notes:** Editable text area. Auto-saves on blur via `PUT /api/estimate-requests/:id`.
- **Estimate:** "Build Estimate" button — stub only, routes to `/app/estimating/:id/estimate` (no-op for now, Sprint 4 wires this up)
- **Activity Log:** Chronological list of `audit_logs` entries for this request ID

#### New view: `frontend/src/views/estimating/EstimateRequestForm.tsx`

"New Request" form. All fields required unless marked optional.

| Field | Type | Notes |
|-------|------|-------|
| Client | Typeahead search | Search existing clients by name/phone against `/api/clients`. Show "New Client" option to reveal inline mini-form: name + phone + email only. |
| Property address | Text | Street address |
| City | Text | |
| State | Text | Default: Arkansas |
| Zip | Text | |
| Job type | Dropdown | `new_build`, `addition`, `remodel_kitchen`, `remodel_bathroom`, `remodel_other`, `repair`, `commercial`, `other` |
| Lead source | Dropdown | `direct_call`, `google_lsa`, `thumbtack`, `website_form`, `referral`, `repeat_client`, `other` |
| Notes | Text area | Optional |

On submit: `POST /api/estimate-requests` → redirect to the new request's detail view at `/app/estimating/:id`.

#### Routing additions in `frontend/src/router.tsx`

```
/app/estimating          → EstimateRequestPipeline
/app/estimating/new      → EstimateRequestForm
/app/estimating/:id      → EstimateRequestDetail
```

#### Nav update

Add "Estimating" to:
- **Bottom nav (mobile):** Between "Clients" and "Subs". Use a clipboard or document icon.
- **Sidebar (desktop):** Same position, same icon.
- Route: `/app/estimating`

---

### Dev Seed Data

**`scripts/dev-seed-sprint3.local.sql`** — LOCAL ONLY, must be gitignored before committing

Add 6 fake estimate requests spread across the pipeline stages so the Kanban board renders with realistic data. Link to the existing Sprint 2 seed clients where possible. Cover at least these stages: `new_request`, `appointment_set`, `visit_done`, `building`, `sent`, `lost`.

Add to `.gitignore` immediately after creating the file:
```bash
echo "scripts/dev-seed-sprint3.local.sql" >> .gitignore
grep "dev-seed-sprint3" .gitignore
```

---

## Business Rules to Enforce

1. **Required fields:** Every estimate request requires `client_id`, `property_address`, `property_city`, `property_zip`, `job_type`, `lead_source`. Return `400` if any are missing.

2. **Forward-only status movement:** `new_request → appointment_set → visit_done → building → sent → follow_up → won/lost`. The API must reject backward moves. Exception: `→ lost` is always allowed from any stage.

3. **`won` is blocked:** Status cannot be set to `won` directly via the API. It is set only by the quote-to-job conversion (Sprint 5). Return `400` with a clear message if `won` is attempted.

4. **Repeat-client indicator:** On create, if the resolved client has `is_repeat_client = true`, the flag should be visible on the pipeline card. No extra API field needed — include `client.is_repeat_client` in the pipeline response payload.

5. **Appointment trigger:** When `appointment_date` is set (via either `PUT /:id` or `PUT /:id/appointment`), fire the `triggerAppointmentSet()` WC hook and update status to `appointment_set` if the current status is `new_request`.

---

## Tests to Run Before Marking Done

Run these manually in the browser and with curl/wrangler dev logs:

```bash
# Create a new request
curl -X POST http://localhost:8787/api/estimate-requests \
  -H "Content-Type: application/json" \
  -d '{"client_id":"<seed-client-id>","property_address":"123 Main St","property_city":"Conway","property_state":"Arkansas","property_zip":"72032","job_type":"remodel_kitchen","lead_source":"direct_call"}'

# Get pipeline data
curl http://localhost:8787/api/estimate-requests/pipeline

# Move a request to appointment_set
curl -X PUT http://localhost:8787/api/estimate-requests/<id>/appointment \
  -H "Content-Type: application/json" \
  -d '{"appointment_date":"2026-06-15T10:00:00"}'

# Try an illegal status move (should return 400)
curl -X PUT http://localhost:8787/api/estimate-requests/<id> \
  -H "Content-Type: application/json" \
  -d '{"status":"won"}'
```

---

## Done Criteria

Sprint 3 is complete when:

- [ ] `migrations/0026_estimate_requests.sql` runs clean on local D1
- [ ] All 7 API endpoints respond correctly
- [ ] `GET /api/estimate-requests/pipeline` returns requests grouped by status
- [ ] Pipeline board renders at `http://localhost:5173/app/estimating` with all 8 stage columns
- [ ] Drag-to-update moves a card and the status change persists
- [ ] New Request form creates a request and redirects to detail view
- [ ] Appointment set/complete works from the detail view
- [ ] Visit notes auto-save on blur
- [ ] Mobile: column swipe works, tap-to-detail works, FAB for new request works
- [ ] WC trigger hooks called on create and appointment set (visible in wrangler dev logs)
- [ ] Audit log entries created for all write operations
- [ ] `scripts/dev-seed-sprint3.local.sql` is in `.gitignore`
- [ ] Repeat-client flag visible on pipeline cards for repeat clients
- [ ] Backward status moves rejected with 400
- [ ] Direct move to `won` rejected with 400
- [ ] All existing Sprint 2 functionality untouched: client list, subs, settings, dashboard, HL Kanban, WC sync

---

## What NOT to Do

- Do not deploy to remote — local only this sprint
- Do not create a `POST /api/estimate-requests/:id/status` route — all status moves go through `PUT /api/estimate-requests/:id`
- Do not build the estimate builder — that is Sprint 4
- Do not build the client-facing estimate page — that is Sprint 5
- Do not build notifications — that is Sprint 7
- Do not touch `migrations/0025_client_data_backfill.sql` — that runs remote separately before this sprint
- Do not use any drag-and-drop library not already in the project — carry forward the existing HL Kanban drag pattern
- Do not gold-plate: clean empty states, no lorem ipsum, no fake charts

---

## When Done

Stop and report back with:
1. Confirmation of all done criteria checked off
2. Any deviations from the spec and why
3. Any open questions for Sprint 4

Do not start Sprint 4 without explicit instruction.

---

## Reference Documents

All documents are in the project knowledge:

1. **cursorrules.md** — conventions, patterns, architecture
2. **CHS-Database-Schema.md** — all table definitions
3. **CHS-API-Route-Map.md** — all 173 API endpoints
4. **CHS-Build-Order-Plan.md** — full sprint plan
5. **Module-Spec-Estimating-Quoting.md** — estimating pipeline spec
6. **Module-Spec-Client-Management-Portal.md** — client data model
7. **CHS-Design-System.md** — CSS tokens and component specs
8. **Module-Spec-WC-Spreadsheet.md** — WC sync patterns
9. **CHS-Schema-Bridge.md** — existing → new table mapping
