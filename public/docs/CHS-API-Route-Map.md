# API Route Map
## CHS Construction Management Platform
### Version 1.0 — May 28, 2026

---

## Overview

Every API endpoint for the CHS platform, organized by module. All routes follow the existing chs-hub conventions.

**Base URL:** `https://api.homesolutionsar.com` (or Workers route)
**Auth:** Cloudflare Access — every request includes `Cf-Access-Authenticated-User-Email` header. Middleware resolves to user record with role.
**Format:** JSON request/response
**Error format:** `{ "error": "string", "details": "string" }`
**IDs:** UUID v4 as TEXT
**Pagination:** `?limit=25&offset=0` (default limit 25, max 100)
**Filtering:** Query params per endpoint (documented below)
**Sorting:** `?sort=created_at&order=desc` (default desc)

---

## Auth & Role Middleware

Every route passes through auth middleware that:
1. Reads `Cf-Access-Authenticated-User-Email` from the request.
2. Looks up the user in the `users` table.
3. Attaches `req.user = { id, email, role, ... }` to the request.
4. Returns `401` if no user found or user is inactive.

Role checks are documented per endpoint:
- **O** = Owner only
- **O/PM** = Owner or Project Manager
- **O/PM/OA** = Owner, PM, or Office Admin
- **O/PM/FC** = Owner, PM, or Field Crew
- **ALL** = Any authenticated user
- **PUBLIC** = No auth required (portal/estimate links use token auth)

---

## 0. Dashboard

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/dashboard/kpis` | O/PM/OA | All 6 KPI tile values in one response. 5-minute in-memory cache. |
| GET | `/api/dashboard/action-items` | O/PM/OA | Computed action items (9 types) sorted by priority then age. Cap 8 items. Fresh on every call. |
| GET | `/api/dashboard/pipeline` | O/PM/OA | Lead + job pipeline stage counts, conversion rate, unpaid total. 5-minute cache. |
| GET | `/api/dashboard/schedule` | O/PM/OA | Today's schedule entries + estimate appointments merged. Fresh on every call. |
| GET | `/api/dashboard/activity` | O/PM/OA | Last 10 audit log entries + `bellCount` (24-hour notification approximation). Fresh on every call. |

---

## 1. System & Admin

### Settings

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/settings` | ALL | Get all system settings (filtered by role — non-owners see only relevant settings) |
| GET | `/api/settings/:key` | O | Get a single setting by key |
| PUT | `/api/settings/:key` | O | Update a setting value. Logs old → new in audit trail |
| GET | `/api/settings/category/:category` | O | Get all settings in a category |

### Users

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/users` | O | List all users |
| GET | `/api/users/me` | ALL | Get current authenticated user |
| GET | `/api/users/clockable` | ALL | List active users eligible to clock in (role IN owner/PM/field_crew). Returns `[{id, full_name, role}]`. Used to populate the worker dropdown on the time-entry clock-in form. |
| POST | `/api/users` | O | Create new user (sends invite email) |
| PUT | `/api/users/:id` | O | Update user (role, info, deactivate). Guards against deactivating the last active owner |
| PUT | `/api/users/:id/notification-preferences` | O | Replace a user's `notification_preferences` JSON (per-channel/event opt-outs) |
| GET | `/api/users/:id` | O | Get user detail |

### Audit Log

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/audit-logs` | O | List audit logs. Filters: `?entity_type=job&entity_id=xxx&user_email=xxx&action=xxx&from=date&to=date` |
| GET | `/api/audit-logs/export` | O | Export audit logs as CSV |

### Integrations

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/integrations` | O | List all integration connections with status |
| GET | `/api/integrations/:service` | O | Get specific integration detail |
| POST | `/api/integrations/:service/connect` | O | Initiate OAuth flow or save API key |
| POST | `/api/integrations/:service/disconnect` | O | Disconnect integration |
| POST | `/api/integrations/:service/test` | O | Test connection |
| GET | `/api/integrations/stripe/callback` | O | Stripe OAuth callback |
| GET | `/api/integrations/quickbooks/callback` | O | QBO OAuth callback |

### Dead Letter Queue

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/dlq` | O | List DLQ items (`sync_dead_letters`). Filter: `?status=open\|resolved\|all` (default `open`; open = `resolved_at IS NULL`). Returns `{ items, open_count }`. |
| POST | `/api/dlq/:id/retry` | O | Re-run a single dead letter; 404 if not found/already resolved, 502 if the replay fails again |
| POST | `/api/dlq/:id/dismiss` | O | Mark resolved without re-running |
| POST | `/api/dlq/dismiss` | O | Bulk-dismiss `{ ids: number[] }` |

### Health & Backup

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/health` | O | System health: heartbeat, cron status, integration sync status |
| GET | `/api/health/heartbeat` | ALL | Simple ping — returns `{ "status": "ok", "timestamp": "..." }` |
| POST | `/api/backup/trigger` | O | Trigger manual D1→R2 backup |
| GET | `/api/backup/status` | O | Last backup date, status, size |

---

## 2. Clients

### Client CRUD

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/clients` | O/PM/OA | List clients. Filters: `?search=name_or_phone&lead_source=xxx&is_repeat=1` |
| GET | `/api/clients/:id` | O/PM/OA (FC: name only) | Client detail with computed totals |
| POST | `/api/clients` | O/PM/OA | Create client. Runs repeat client detection |
| PUT | `/api/clients/:id` | O/PM/OA | Update client |
| GET | `/api/clients/:id/summary` | O/PM | Client summary: total jobs, total revenue, last interaction |

### Properties

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/clients/:id/properties` | O/PM/OA | List properties for a client |
| POST | `/api/clients/:id/properties` | O/PM/OA | Add property |
| PUT | `/api/properties/:id` | O/PM/OA | Update property |

### Communications

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/clients/:id/communications` | O/PM/OA | Communication timeline. Filters: `?channel=sms&job_id=xxx&from=date&to=date` |
| POST | `/api/communications` | O/PM/OA | Log a manual communication (phone call, in-person) |
| GET | `/api/jobs/:id/communications` | O/PM/OA | Communications filtered by job |

### Twilio Webhook

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/webhooks/twilio/inbound` | PUBLIC (verified by Twilio signature) | Inbound SMS — auto-logs to client by phone match |

### High Level Sync

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/high-level/pipeline` | O/PM | Get HL pipeline data (PIT proxy, carry forward) |
| POST | `/api/high-level/pipeline/:id/move` | O/PM | Move HL opportunity stage (write-back) |
| POST | `/api/high-level/contacts/:id/create-request` | O/PM | Create estimate request from HL contact |

---

## 3. Estimating & Quoting

### Estimate Requests

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/estimate-requests` | O/PM | List all requests. Filters: `?status=xxx&job_type=xxx&lead_source=xxx&from=date&to=date` |
| GET | `/api/estimate-requests/pipeline` | O/PM | Pipeline board data: requests grouped by status |
| GET | `/api/estimate-requests/:id` | O/PM | Request detail |
| POST | `/api/estimate-requests` | O/PM | Create new request (triggers lead acknowledgment notification, WC sync) |
| PUT | `/api/estimate-requests/:id` | O/PM | Update request (status change triggers WC sync, notifications) |
| PUT | `/api/estimate-requests/:id/appointment` | O/PM | Set/update appointment date (triggers confirmation notification) |
| PUT | `/api/estimate-requests/:id/lost` | O/PM | Mark as lost with reason |

### Estimates

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/estimates/:id` | O/PM | Estimate detail with line items, sub-items, payment schedule |
| POST | `/api/estimates` | O/PM | Create estimate for a request |
| PUT | `/api/estimates/:id` | O/PM | Update estimate |
| POST | `/api/estimates/:id/send` | O/PM | Send to client (generates portal token, triggers notification, WC sync) |
| POST | `/api/estimates/:id/revise` | O/PM | Create revised version |

### Estimate Line Items

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/estimates/:id/line-items` | O/PM | List parent line items with sub-items |
| POST | `/api/estimates/:id/line-items` | O/PM | Add parent line item |
| PUT | `/api/estimate-line-items/:id` | O/PM | Update line item |
| DELETE | `/api/estimate-line-items/:id` | O/PM | Remove line item |
| POST | `/api/estimate-line-items/:id/sub-items` | O/PM | Add sub-item (internal cost) |
| PUT | `/api/estimate-sub-items/:id` | O/PM | Update sub-item |
| DELETE | `/api/estimate-sub-items/:id` | O/PM | Remove sub-item |

### Payment Schedules

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/estimates/:id/payment-schedule` | O/PM | Get payment schedule for estimate |
| POST | `/api/estimates/:id/payment-schedule` | O/PM | Add schedule entry |
| PUT | `/api/payment-schedules/:id` | O/PM | Update entry |
| DELETE | `/api/payment-schedules/:id` | O/PM | Remove entry |

### Templates

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/estimate-templates` | O/PM | List active templates |
| GET | `/api/estimate-templates/:id` | O/PM | Template detail |
| POST | `/api/estimate-templates` | O | Create template |
| PUT | `/api/estimate-templates/:id` | O | Update template |

### Saved Reviews

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/saved-reviews` | O/PM | List all reviews |
| GET | `/api/saved-reviews/active` | O/PM | Active reviews for quote display |
| POST | `/api/saved-reviews` | O | Create review |
| PUT | `/api/saved-reviews/:id` | O | Update review |

### Client-Facing Estimate (Public)

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/portal/estimate/:token` | PUBLIC | Get estimate by portal token (client view: line items, payment schedule, reviews, contract) |
| POST | `/api/portal/estimate/:token/sign` | PUBLIC | Submit signature |
| POST | `/api/portal/estimate/:token/pay-deposit` | PUBLIC | Process deposit payment via Stripe |

---

## 4. Job Management

### Jobs

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs` | O/PM/OA (FC: assigned only) | List jobs. Filters: `?status=xxx&job_type=xxx&client_id=xxx&billing_model=xxx` |
| GET | `/api/jobs/pipeline` | O/PM | Pipeline board data: jobs grouped by status |
| GET | `/api/jobs/:id` | O/PM/OA (FC: assigned only) | Job detail with all tabs data |
| PUT | `/api/jobs/:id` | O/PM | Update job (status changes enforce business rules, trigger notifications/WC sync) |
| PUT | `/api/jobs/:id/status` | O/PM | Dedicated status change endpoint (validates transitions, triggers side effects) |

*Note: No POST for jobs — created exclusively via quote-to-job conversion.*

### Quote-to-Job Conversion (Internal)

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/jobs/convert-from-estimate` | SYSTEM (triggered by deposit payment) | Creates job from approved estimate. Auto-generates tasks, budget, portal, billing schedule |

### Tasks

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/tasks` | O/PM/OA/FC | List tasks grouped by trade. Filters: `?status=xxx&task_group=xxx` |
| POST | `/api/jobs/:id/tasks` | O/PM | Create task |
| PUT | `/api/tasks/:id` | O/PM (FC: mark complete only) | Update task |
| PUT | `/api/tasks/:id/complete` | O/PM/FC | Mark task complete (captures timestamp, completed_by) |

### Daily Logs

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/daily-logs` | O/PM/FC | List daily logs for job |
| POST | `/api/jobs/:id/daily-logs` | O/PM/FC | Create daily log |
| PUT | `/api/daily-logs/:id` | O/PM/FC | Update daily log |

### Change Orders

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/change-orders` | O/PM | List change orders for job (draft/sent/approved/rejected) |
| POST | `/api/jobs/:id/change-orders` | O/PM | Create draft change order (unique `change_order_number` per job; can be triggered from Smart Note) |
| PUT | `/api/change-orders/:id` | O/PM | Update change order (drafts only) |
| POST | `/api/change-orders/:id/send` | O/PM | Mark `sent` and notify client (`change_order_sent`) for signature |
| POST | `/api/change-orders/:id/reject` | O/PM | Mark a sent change order `rejected` |

Client approval is **not** an internal route — it happens when the client signs in the portal (`POST /api/portal/:token/change-orders/:id/sign`), which calls the idempotent `applyChangeOrder()`: stamps `applied_at` exactly once, revises `jobs.contract_total`, extends the end date, creates the CO task group, and fires `change_order_approved`.

### Schedule

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/schedule` | O/PM | Schedule entries for a job |
| GET | `/api/schedule` | O/PM | Cross-job calendar feed. Filters: `?from=date&to=date` |
| POST | `/api/jobs/:id/schedule` | O/PM | Create schedule entry (fires `sub_scheduled` once if a sub is assigned) |
| PUT | `/api/schedule/:id` | O/PM | Update / drag-to-reschedule entry (fires `sub_scheduled` once if a sub becomes assigned) |
| DELETE | `/api/schedule/:id` | O/PM | Delete schedule entry |

### Permits

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/permits` | O/PM | List permits for job |
| POST | `/api/jobs/:id/permits` | O/PM | Create permit record |
| PUT | `/api/permits/:id` | O/PM | Update permit (inspection result, status change) |
| DELETE | `/api/permits/:id` | O/PM | Delete permit record |

### Warranties

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/warranties` | O/PM | List warranty claims for job |
| POST | `/api/jobs/:id/warranties` | O/PM | Create warranty claim |
| PUT | `/api/warranties/:id` | O/PM | Update claim (resolve) |

---

## 5. Financial Management

### Invoices

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/invoices` | O/PM/OA | List all invoices. Filters: `?job_id=xxx&status=xxx&billing_model=xxx&from=date&to=date` |
| GET | `/api/invoices/:id` | O/PM/OA | Invoice detail |
| POST | `/api/invoices` | O/PM/OA | Create invoice (manual or triggered by milestone/trade completion) |
| PUT | `/api/invoices/:id` | O/PM/OA | Update invoice |
| POST | `/api/invoices/:id/send` | O/PM/OA | Send invoice to client (email + SMS with payment link) |
| POST | `/api/invoices/:id/void` | O | Void invoice (preserved for audit) |
| GET | `/api/jobs/:id/invoices` | O/PM/OA | Invoices for a specific job |

### Payments

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/payments` | O/OA | List all payments. Filters: `?job_id=xxx&method=xxx&from=date&to=date` |
| POST | `/api/payments` | O/OA | Record manual payment (check, cash) |
| GET | `/api/jobs/:id/payments` | O/PM/OA | Payments for a job |

### Stripe Webhook

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/webhooks/stripe` | PUBLIC (verified by Stripe signature) | Payment confirmation, creates payment record, updates invoice status, triggers notification |

### Expenses

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/expenses` | O/PM/OA | List expenses. Filters: `?job_id=xxx&type=xxx&vendor=xxx&from=date&to=date` |
| GET | `/api/jobs/:id/expenses` | O/PM | Expenses for a job |
| POST | `/api/expenses` | O/PM/OA/FC | Create expense |
| PUT | `/api/expenses/:id` | O/PM/OA | Update expense |

### Time Tracking

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/time-entries` | O/PM | Time entries for a job |
| POST | `/api/time-entries` | O/PM/FC | Clock in (creates entry with clock_in, no clock_out) |
| PUT | `/api/time-entries/:id` | O/PM/FC | Clock out or edit |
| GET | `/api/time-entries/active` | O/PM/FC | Get currently active (clocked in) entries |

### Cost-Plus Billing Cycles

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/billing-cycles` | O/PM | List billing cycles for job |
| GET | `/api/billing-cycles/:id` | O/PM | Cycle detail with projections and actuals |
| POST | `/api/jobs/:id/billing-cycles` | O/PM | Create new billing cycle (mini-budget) |
| PUT | `/api/billing-cycles/:id` | O/PM | Update cycle (projections, reconciliation) |
| POST | `/api/billing-cycles/:id/generate-invoice` | O/PM | Generate upfront invoice from mini-budget |
| POST | `/api/billing-cycles/:id/reconcile` | O/PM | Run reconciliation (compare projected vs. actual) |

### Job Costing

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/costing` | O/PM | Budget vs. actual per estimate line item |

### Mileage

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/mileage` | O | List mileage entries. Filters: `?job_id=xxx&from=date&to=date` |
| POST | `/api/mileage` | O/PM | Create mileage entry |
| PUT | `/api/mileage/:id` | O/PM | Update entry |

### Lien Waivers

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/lien-waivers` | O/PM | Lien waivers for a job |
| POST | `/api/lien-waivers` | O/PM | Create waiver request |
| PUT | `/api/lien-waivers/:id` | O/PM | Update waiver lifecycle (requested → received → filed) |
| POST | `/api/lien-waivers/:id/generate` | O/PM | Generate the waiver document from a `lien_waiver` template (merge-populated) and store it in `documents` |

### Vendor / Material Database

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/vendor-materials` | O/PM | Search materials. Filters: `?search=xxx&category=xxx&vendor=xxx` |
| POST | `/api/vendor-materials` | O/PM | Create entry |
| PUT | `/api/vendor-materials/:id` | O/PM | Update entry |

### Vendor & Service Subscriptions Tracker

Informational only (Settings → Vendors & Subscriptions). Not wired to billing APIs or `integration_connections`. Renewals with `renewal_date` also appear on the public iCal feed (`GET /api/calendar/ical?token=…`) as all-day VEVENTs (`UID: vendor-sub-{id}@chs`) with monthly/annual RRULE when applicable.

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/vendor-subscriptions` | O | List active subscriptions. Filters: `?category=&search=` |
| GET | `/api/vendor-subscriptions/:id` | O | Get one |
| POST | `/api/vendor-subscriptions` | O | Create |
| PUT | `/api/vendor-subscriptions/:id` | O | Update |
| DELETE | `/api/vendor-subscriptions/:id` | O | Soft-delete (`is_active = 0`) |

### Financial Reports & Exports

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/reports/financials` | O | Dashboard KPIs: YTD revenue, expenses, profit, unpaid invoices |
| GET | `/api/reports/cpa-export` | O | Generate CPA-ready annual export (CSV) |
| GET | `/api/reports/1099-summary` | O | 1099-NEC summary for subs exceeding $600/year |

### QuickBooks Sync (Sprint 14 — **push + reference-read**, not two-way)

QBO direction is **one-way transactional push (CHS → QBO)** plus a **reference-data
read** (Customers/Vendors/Accounts) for entity mapping. There is **no transactional
pull-back** and **no QBO webhook consumption** this sprint — `/api/webhooks/quickbooks`
remains a labeled seam. Push is **exactly-once**, keyed on the `qbo_*_id` columns.

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/integrations` | O | List integration connections + status |
| GET | `/api/integrations/:service` | O | Connection detail (QBO returns full status + counts) |
| POST | `/api/integrations/quickbooks/connect` | O | Start OAuth (returns Intuit authorize URL + anti-CSRF state) |
| GET | `/api/integrations/quickbooks/callback` | O (Access) | OAuth redirect: verify state, exchange code, store realmId + encrypted tokens |
| POST | `/api/integrations/quickbooks/disconnect` | O | Revoke + mark disconnected |
| POST | `/api/integrations/quickbooks/test` | O | CompanyInfo ping to confirm live creds |
| GET | `/api/integrations/quickbooks/reference` | O | QBO Accounts + client/vendor match suggestions + current map |
| POST | `/api/integrations/quickbooks/mapping` | O | Persist client→Customer, sub→Vendor, expense_type→Account, payment account |
| POST | `/api/quickbooks/sync` | O | On-demand push sweep (same code path as the nightly fold) |
| GET | `/api/quickbooks/status` | O | Connection status, last sweep, synced/pending/failed counts |

### WC Spreadsheet Sync (Sprint 14 — rebuilt to Module-Spec-WC-Spreadsheet)

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/wc-spreadsheet/sync` | O | Manual WC Spreadsheet sync (owner; also accepts SYNC_TRIGGER_SECRET) |
| GET | `/api/wc-spreadsheet/status` | O | Last sync status + structured snapshot |

---

## 6. Photo Capture

### Photos

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/photos` | O/PM/FC | Photo timeline for job. Filters: `?type=xxx&from=date&to=date&social_ready=1` |
| POST | `/api/photos` | O/PM/FC | Upload photo (multipart/form-data). Returns R2 key. Triggers thumbnail generation and Drive mirror |
| POST | `/api/photos/batch` | O/PM/FC | Batch upload (offline sync). Array of photos with metadata |
| GET | `/api/photos/:id` | O/PM/FC | Photo detail with metadata |
| PUT | `/api/photos/:id` | O/PM/FC | Update photo metadata (caption, type, social flag, before/after) |
| PUT | `/api/photos/:id/annotate` | O/PM/FC | **Built S18.** Save annotation overlay (`{ annotation_data }`); non-destructive — sets `is_annotated=1`, never rewrites the R2 original. Empty overlay clears it |
| GET | `/api/photos/:id/annotation` | O/PM/FC | **Built S18.** Load the saved overlay JSON for re-render |
| POST | `/api/photos/pair` | O/PM/FC | **Built S18.** Link before/after: `{ before_id, after_id }` (after→before; sets type flags so portal/completion seams surface it) |
| POST | `/api/photos/unpair` | O/PM/FC | **Built S18.** Clear a pair: `{ after_id }` |

### Receipt Processing

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/photos/receipt` | O/PM/FC | Upload receipt photo → triggers AI processing |
| GET | `/api/receipt-photos/:id` | O/PM/FC | Get AI extraction results |
| POST | `/api/receipt-photos/:id/confirm` | O/PM/FC | Confirm AI extraction → creates expense record |

### Photo Reports & Project Packet

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/jobs/:id/photo-report` | O/PM | **Built S18.** Generate a photo report (HTML-first, S15 pattern — no binary-PDF). Body: `{ photo_ids, include_gps, include_captions }`. Stores R2 + `documents` row `document_category='photo_report'` (`is_signed=0` — never swept into signed-doc queries). Shareable via `POST /api/documents/:id/share` |
| POST | `/api/jobs/:id/project-packet` | O/PM | **Built S18.** Generate a sales packet (HTML-first; before/after + scope + highlights). `documents` row `document_category='project_packet'`, distinct from the completion package. Shareable |

### Push Device Registration (Sprint 18)

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/devices/register` | ALL | Upsert a device token keyed on `token`: `{ platform: ios\|android\|web, token }` → `user_id` from `req.user`, `is_active=1`, refresh `last_seen_at`. Tokens masked in responses/logs |
| POST | `/api/devices/unregister` | ALL | Deactivate a token: `{ token }` (own device; owner may retire any) |
| GET | `/api/devices` | ALL | The caller's own devices (tokens masked) |

> **S18 push posture:** registration stores the token; the notification dispatcher's `push` branch resolves the recipient's active `device_tokens` and **SIMULATES** the send (logs the intended push, masked) — identical to SMS/email today. **No live FCM/APNS** — real send is a Pre-Launch dispatch-mode flip. Rides the existing `*/15` notification tick (no new cron).

---

## 7. Documents

### Document CRUD

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/documents` | O/PM/OA | List documents (active only). Filters: `?job_id=xxx&context_type=xxx&category=xxx&search=xxx` |
| GET | `/api/jobs/:id/documents` | O/PM/OA | Documents for a job, grouped by category |
| GET | `/api/documents/:id` | O/PM/OA | Document detail |
| POST | `/api/documents` | O/PM/OA | Upload document (multipart/form-data → R2 canonical store; 50 MB cap; audit-logged) |
| GET | `/api/documents/:id/file` | O/PM/OA | Stream the underlying file from R2 (GET/HEAD) |
| PUT | `/api/documents/:id` | O/PM/OA | Update metadata |
| DELETE | `/api/documents/:id` | O/PM/OA | Soft-delete (`is_active=0`; R2 object retained) |
| POST | `/api/documents/:id/share` | O/PM/OA | Generate 7-day shareable link (returns token + public URL with expiration) |
| GET | `/api/documents/company` | O/OA | Company documents (non-job) |

### Document Templates

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/document-templates` | O | List current template heads (one per lineage) + `merge_field_catalog` |
| GET | `/api/document-templates/:id` | O | Template detail + version history |
| POST | `/api/document-templates` | O | Create template (v1) |
| PUT | `/api/document-templates/:id` | O | Update template. Content change → **copy-on-write new version** (links `previous_version_id`); `is_active`-only toggle is in-place |
| POST | `/api/document-templates/:id/generate` | O/PM | Generate document from template. Body: `{ job_id, client_id }` — auto-populates merge fields, stores result in `documents` |
| POST | `/api/document-templates/:id/preview` | O | Preview rendered output with sample merge data |

### Public Document Access

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/share/:token` | PUBLIC | Access shared document by token (validates expiration; serves file or expired-link page). Also reachable as `/share/:token` on every host incl. `client.homesolutionsar.com` |

### Job Completion Package

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/jobs/:id/completion-package` | O/PM | Compile completion package — aggregates docs, before/after photos, financial summary into a **branded HTML package** (HTML-first, Workers-compatible; no Node PDF deps). Saved as a `completion_package` document **draft** |
| GET | `/api/jobs/:id/completion-package` | O/PM | Get existing completion package (draft or sent) |
| POST | `/api/jobs/:id/completion-package/send` | O/PM | Transition draft → **sent** (state tracked via `documents.is_signed`/`signed_date`); triggers `completion_package_sent` notification. Once sent, surfaces in the client portal |

---

## 8. Smart Notes

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/smart-notes` | O/PM/FC | List notes. Filters: `?job_id=xxx&category=xxx` |
| POST | `/api/smart-notes` | O/PM/FC | Create note (text or voice transcript). Triggers AI processing |
| GET | `/api/smart-notes/:id` | O/PM/FC | Note detail with AI results |
| POST | `/api/smart-notes/:id/process` | O/PM/FC | Re-trigger AI processing |
| POST | `/api/smart-notes/:id/accept-task` | O/PM | Accept AI-suggested task → creates task in job |
| POST | `/api/smart-notes/:id/accept-expense` | O/PM/FC | Accept AI-suggested expense → creates expense |
| POST | `/api/smart-notes/:id/accept-change-order` | O/PM | Accept AI-suggested CO → creates change order draft |

---

## 9. Notifications

### Templates (Admin)

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/notification-templates` | O | List all templates grouped by phase |
| GET | `/api/notification-templates/:id` | O | Template detail |
| PUT | `/api/notification-templates/:id` | O | Update template (body, timing, active toggle) |
| POST | `/api/notification-templates/:id/test` | O | Send test notification to owner |
| POST | `/api/notification-templates/:id/preview` | O | Preview rendered with sample data |

### Logs

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/notification-logs` | O | List logs. Filters: `?status=xxx&channel=xxx&trigger=xxx&job_id=xxx&from=date&to=date` |
| POST | `/api/notification-logs/:id/retry` | O | Retry failed notification |

### In-App Notifications

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/notifications/inbox` | ALL | Get in-app notifications for current user (unread count + recent) |
| PUT | `/api/notifications/:id/read` | ALL | Mark notification as read |
| PUT | `/api/notifications/read-all` | ALL | Mark all as read |

---

## 10. Social Media

### Posts

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/social-posts` | O/OA | List posts. Filters: `?status=xxx&type=xxx&from=date&to=date` |
| GET | `/api/social-posts/queue` | O/OA | Approval queue (pending_approval posts) |
| GET | `/api/social-posts/:id` | O/OA | Post detail |
| POST | `/api/social-posts` | O/OA | Create manual post |
| PUT | `/api/social-posts/:id` | O/OA | Update post (caption, hashtags, timing, platform) |
| POST | `/api/social-posts/:id/approve` | O | Approve post |
| POST | `/api/social-posts/approve-batch` | O | Approve many posts at once (`{ ids: [] }`); skips already-published/rejected |
| POST | `/api/social-posts/:id/reject` | O | Reject post with reason |
| POST | `/api/social-posts/:id/regenerate` | O | Regenerate caption via Claude |
| DELETE | `/api/social-posts/:id` | O | Delete post from queue |

### Content Schedule

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/content-schedules` | O/OA | List schedules |
| POST | `/api/content-schedules/generate` | O | Generate monthly schedule via AI |
| GET | `/api/content-schedules/:id` | O/OA | Schedule detail with posts |

### AI Image Generation

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/social-posts/:id/generate-image` | O | Generate AI image for a post (Replicate/Flux Pro). Degrades gracefully (`{ ok:false, unconfigured:true }`) when no Replicate key is set |
| GET | `/api/social-posts/:id/image` | O/OA | Stream the post's AI-generated image from R2 |

### Publishing (Cron-triggered, but can be manual)

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/social-posts/:id/publish` | O | Manually publish an approved post now |

---

## 11. Client Portal (Public)

All portal routes use token-based auth (no Cloudflare Access).

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/portal/:token` | PUBLIC | Portal landing page data (job overview, quick stats) |
| GET | `/api/portal/:token/photos` | PUBLIC | Photo timeline for the job |
| GET | `/api/portal/:token/schedule` | PUBLIC | Schedule entries for the job |
| GET | `/api/portal/:token/invoices` | PUBLIC | Invoices with status and payment links |
| GET | `/api/portal/:token/change-orders` | PUBLIC | Change orders for the job |
| POST | `/api/portal/:token/change-orders/:id/sign` | PUBLIC | Sign a change order |
| GET | `/api/portal/:token/documents` | PUBLIC | Documents shared with client |
| GET | `/api/portal/:token/messages` | PUBLIC | Message thread |
| POST | `/api/portal/:token/messages` | PUBLIC | Send message to contractor |
| POST | `/api/portal/:token/pay/:invoiceId` | PUBLIC | Process payment via Stripe |
| GET | `/api/portal/:token/budget` | PUBLIC | Cost-plus budget & costs tab (only for cost-plus jobs) |
| GET | `/api/portal/:token/completion-package` | PUBLIC | Access completion package |

---

## 12. Subcontractors

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/subcontractors` | O/PM | List subs. Filters: `?trade=xxx&search=xxx&active=1` |
| GET | `/api/subcontractors/:id` | O/PM | Sub detail |
| POST | `/api/subcontractors` | O/PM | Create sub |
| PUT | `/api/subcontractors/:id` | O/PM | Update sub |

---

## 13. Webhooks (Inbound)

External services that push data to CHS.

| Method | Route | Auth | Source | Description |
|--------|-------|------|--------|-------------|
| POST | `/api/webhooks/stripe` | Stripe signature | Stripe | Payment events |
| POST | `/api/webhooks/twilio/inbound` | Twilio signature | Twilio | Inbound SMS |
| POST | `/api/webhooks/twilio/status` | Twilio signature | Twilio | Delivery status callbacks |
| POST | `/api/webhooks/quickbooks` | QBO signature | QuickBooks | Sync events |
| POST | `/api/webhooks/resend` | Resend signature | Resend | Email delivery status |

---

## 14. Cron Jobs (Worker Scheduled)

Not REST endpoints, but the Worker's `scheduled()` triggers. The Cloudflare Workers
Free plan caps the account at **exactly 5 cron triggers** — so all recurring work is
folded into these 5 handlers (see `dispatchCron` in `src/index.ts`). This table is the
**as-built** reality (verified against `wrangler.toml [triggers].crons`), not a wishlist.

| Schedule | Folded work (in dispatch order) |
|----------|---------------------------------|
| `*/15 * * * *` | Notification processor (queued/scheduled sends) **+** social-post publisher (Sprint 16 folded the due-post sweep here — no new cron). |
| `*/30 * * * *` | Jobber tick **+** WC Spreadsheet sync (Google Sheets carry-forward). |
| `15 * * * *` | Reliability hourly: heartbeat **+** DLQ replay **+** Google Drive mirror (Sprint 15 added `documents` to the photos/job-files/company-docs batch loop). |
| `15 7 * * *` | Nightly: D1→R2 backup → invoice billing (late-fee accrual + due/past-due notices) → **QBO dirty-flag push sweep** (Sprint 14 — no standalone QBO cron). |
| `0 12 * * *` | Daily summary email (via Resend). |

> **Superseded standalone crons** (folded above, never deployed as their own trigger):
> Google Drive Mirror (Sprint 15 → `15 * * * *`), QBO Sync (Sprint 14 → `15 7 * * *`
> + on-demand `POST /api/quickbooks/sync`), invoice due-check / late-fee (→ `15 7 * * *`).

---

## Route Count Summary

| Module | Routes |
|--------|--------|
| System & Admin | 18 |
| Clients | 12 |
| Estimating | 22 |
| Job Management | 24 |
| Financial | 28 |
| Photo Capture | 10 |
| Documents | 13 |
| Smart Notes | 7 |
| Notifications | 8 |
| Social Media | 16 |
| Client Portal | 12 |
| Subcontractors | 4 |
| Webhooks | 5 |
| **Total** | **~179 endpoints** |

Plus 5 cron triggers (Workers Free plan cap — see §14; recurring work is folded into these 5 handlers).
