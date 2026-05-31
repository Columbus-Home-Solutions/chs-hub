# API Route Map
## CHS Construction Management Platform
### Version 1.0 — May 28, 2026
### Revised May 31, 2026 (Sprint 8) — §6 Photo Capture reconciled to as-built; §4 Daily Logs & §8 Smart Notes role/behavior notes added

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
| POST | `/api/users` | O | Create new user (sends invite email) |
| PUT | `/api/users/:id` | O | Update user (role, info, deactivate) |
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
| GET | `/api/dlq` | O | List DLQ items. Filters: `?status=pending` |
| POST | `/api/dlq/:id/retry` | O | Retry a failed item |
| POST | `/api/dlq/:id/dismiss` | O | Dismiss/resolve an item |

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
| GET | `/api/jobs/:id/daily-logs` | ALL (read) | List daily logs for job, each hydrated with linked photos (`photos.daily_log_id` is the source of truth; `daily_logs.photo_ids` mirrors it) |
| POST | `/api/jobs/:id/daily-logs` | O/PM/FC/OA | Create daily log (optionally links `photo_ids` for the day) |
| PUT | `/api/daily-logs/:id` | O/PM/FC/OA | Update daily log (re-links photos) |

### Change Orders

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/change-orders` | O/PM | List change orders for job |
| POST | `/api/jobs/:id/change-orders` | O/PM | Create change order (can be triggered from Smart Note) |
| PUT | `/api/change-orders/:id` | O/PM | Update change order |
| POST | `/api/change-orders/:id/send` | O/PM | Send to client for signature |
| POST | `/api/change-orders/:id/approve` | SYSTEM (via portal signature) | Process client approval — updates budget, creates tasks |

### Schedule

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/schedule` | O/PM | Schedule entries for a job |
| GET | `/api/schedule` | O/PM | Calendar view across all jobs. Filters: `?from=date&to=date` |
| POST | `/api/jobs/:id/schedule` | O/PM | Create schedule entry (triggers sub notification if sub assigned) |
| PUT | `/api/schedule-entries/:id` | O/PM | Update entry (triggers sub notification if changed) |
| DELETE | `/api/schedule-entries/:id` | O/PM | Cancel entry (triggers sub cancellation notification) |

### Permits

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/permits` | O/PM | List permits for job |
| POST | `/api/jobs/:id/permits` | O/PM | Create permit record |
| PUT | `/api/permits/:id` | O/PM | Update permit (inspection result, status change) |

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
| PUT | `/api/lien-waivers/:id` | O/PM | Update waiver (received, filed) |

### Vendor / Material Database

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/vendor-materials` | O/PM | Search materials. Filters: `?search=xxx&category=xxx&vendor=xxx` |
| POST | `/api/vendor-materials` | O/PM | Create entry |
| PUT | `/api/vendor-materials/:id` | O/PM | Update entry |

### Financial Reports & Exports

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/reports/financials` | O | Dashboard KPIs: YTD revenue, expenses, profit, unpaid invoices |
| GET | `/api/reports/cpa-export` | O | Generate CPA-ready annual export (CSV) |
| GET | `/api/reports/1099-summary` | O | 1099-NEC summary for subs exceeding $600/year |

### QuickBooks Sync

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/quickbooks/sync` | O | Trigger manual QBO sync |
| GET | `/api/quickbooks/status` | O | Sync status and last sync date |

### WC Spreadsheet Sync

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/wc-spreadsheet/sync` | O | Trigger manual WC Spreadsheet sync (carry forward) |
| GET | `/api/wc-spreadsheet/status` | O | Sync status |

---

## 6. Photo Capture

> **As-built (Sprint 8, May 31 2026).** This section reflects the shipped
> implementation, which deviates from the v1.0 design in three ways worth
> calling out:
> 1. **`GET /api/photos/:id` streams the original image bytes** (carry-forward
>    of the deployed dashboard/PWA contract), so photo metadata moved to the new
>    **`GET /api/photos/:id/meta`** (JSON). Timeline JSON is at
>    `GET /api/jobs/:id/photos`.
> 2. **`DELETE /api/photos/:id` exists and is a SOFT delete** (`is_active=0`;
>    R2 object retained permanently — business rule #2). It was not in v1.0.
> 3. **Ingest routes are credential-light at the Worker.** `POST /api/photos`,
>    `/batch`, and `/receipt` carry forward the PWA's no-role-gate upload path
>    (they run behind Cloudflare Access at the edge, and stamp
>    `Cf-Access-Authenticated-User-Email` as `uploaded_by` when present). Record-
>    mutating routes (`PUT`, `DELETE`, receipt `confirm`) ARE role-gated.
>
> Server-side thumbnail generation and Google Drive mirror are **not** wired for
> photos this sprint: thumbnails are client-generated (the thumb key falls back
> to the full image if absent, rule #6).

### Photos

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/jobs/:id/photos` | ALL (read) | Photo timeline for job (active only). Filters: `?type=xxx&from=date&to=date`. Hydrates receipt extraction when present. (`social_ready` filter deferred) |
| POST | `/api/photos` | Ingest (not gated at Worker; Access edge) | Upload photo (multipart). Accepts new `image` + flat fields **or** legacy `original`/`thumb`/`metadata`. **Idempotent**: client `capture_uuid` becomes the photo PK; a retry returns `{ duplicate: true }`. Client-generated thumbnail |
| POST | `/api/photos/batch` | Ingest (not gated at Worker) | Batch offline-sync upload (`count` + `meta_<i>`/`image_<i>`/`thumb_<i>`). Idempotent per `capture_uuid`; returns per-item `created`/`duplicate`/`failed` |
| GET | `/api/photos` | ALL (read) | Legacy flat list (dashboard/PWA). Filters: `?job_id=xxx&since=date&limit=n` |
| GET | `/api/photos/:id` | ALL (read) | **Streams the original image bytes from R2** (not JSON) |
| GET | `/api/photos/:id/thumb` | ALL (read) | Streams the thumbnail bytes from R2 |
| GET | `/api/photos/:id/meta` | ALL (read) | **Photo detail as JSON** (caption, type, GPS, links, flags, receipt) |
| PUT | `/api/photos/:id` | O/PM/FC/OA | Update metadata (caption, photo_type, task/daily-log link, social/before/after flags) |
| DELETE | `/api/photos/:id` | O/PM/FC/OA | **Soft delete** (`is_active=0`; row + R2 retained). Drops from active timeline |
| PATCH | `/api/photos/:id` | Ingest (legacy, not gated) | Legacy move: reassign `job_id`/`category` (dashboard carry-forward) |
| PUT | `/api/photos/:id/annotate` | — | **DEFERRED (Sprint 18)** — returns `501`; `annotation_data`/`is_annotated` columns are seams |
| POST | `/api/photos/pair` | — | **DEFERRED (Sprint 18)** — before/after pairing not implemented (`before_after_pair_id` is a seam) |

### Receipt Processing

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/photos/receipt` | Ingest (not gated at Worker) | Upload receipt photo → Claude vision extraction (vendor/amount/date/category/confidence). Degrades gracefully if AI key/proxy unavailable: photo persists, `processing_status='failed'`, manual entry still works |
| GET | `/api/receipt-photos/:id` | ALL (read) | Get AI extraction results |
| POST | `/api/receipt-photos/:id/confirm` | O/PM/FC | Confirm extraction (editable) → creates `expenses` record + links. Idempotent on the receipt |

### Photo Reports

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/jobs/:id/photo-report` | O/PM | **DEFERRED** — photo-report PDF lands in a later sprint |

---

## 7. Documents

### Document CRUD

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/documents` | O/PM/OA | List documents. Filters: `?job_id=xxx&context_type=xxx&category=xxx&search=xxx` |
| GET | `/api/jobs/:id/documents` | O/PM/OA | Documents for a job, grouped by category |
| GET | `/api/documents/:id` | O/PM/OA | Document detail |
| POST | `/api/documents` | O/PM/OA | Upload document (multipart/form-data) |
| PUT | `/api/documents/:id` | O/PM/OA | Update metadata |
| POST | `/api/documents/:id/share` | O/PM/OA | Generate shareable link (returns token + URL with expiration) |
| GET | `/api/documents/company` | O/OA | Company documents (non-job) |

### Document Templates

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/document-templates` | O | List templates |
| GET | `/api/document-templates/:id` | O | Template detail |
| POST | `/api/document-templates` | O | Create template |
| PUT | `/api/document-templates/:id` | O | Update template (creates new version) |
| POST | `/api/document-templates/:id/generate` | O/PM | Generate document from template. Body: `{ job_id, client_id }` — auto-populates merge fields |
| POST | `/api/document-templates/:id/preview` | O | Preview with sample data |

### Public Document Access

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/share/:token` | PUBLIC | Access shared document by token (validates expiration) |

### Job Completion Package

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/jobs/:id/completion-package` | O/PM | Generate completion package (compiles photos, docs, financials into PDF) |
| GET | `/api/jobs/:id/completion-package` | O/PM | Get existing completion package |
| POST | `/api/jobs/:id/completion-package/send` | O/PM | Send to client via email |

---

## 8. Smart Notes

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/smart-notes` | ALL (read) | List notes. Filters: `?job_id=xxx&category=xxx` |
| POST | `/api/smart-notes` | O/PM/FC/OA | Create note (text or voice transcript). Triggers Claude processing; degrades gracefully if AI unavailable (`processing_status='failed'`, manual accept still works). Response includes `ai_ok` |
| GET | `/api/smart-notes/:id` | ALL (read) | Note detail with AI results (summary, category, extracted tasks/expense/change-order) |
| POST | `/api/smart-notes/:id/process` | O/PM/FC/OA | Re-trigger AI processing |
| POST | `/api/smart-notes/:id/accept-task` | O/PM | Accept AI-suggested task → creates task in job |
| POST | `/api/smart-notes/:id/accept-expense` | O/PM/FC | Accept AI-suggested expense → creates expense |
| POST | `/api/smart-notes/:id/accept-change-order` | O/PM | Accept AI-suggested CO → creates change order draft (`status='draft'`, `triggered_by_note_id` set) |

> **As-built (Sprint 8).** Voice notes are transcribed **client-side** via the
> browser Web Speech API; the server receives text either way (`entered_via`
> distinguishes `text`/`voice`). AI runs server-side (`ANTHROPIC_API_KEY` direct,
> falling back to the existing Claude proxy). All three accept-* routes are
> idempotent-safe (re-accepting creates an additional record only if re-invoked).

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
| POST | `/api/social-posts/:id/generate-image` | O | Generate AI image for a post (Replicate/Flux Pro) |

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

Not REST endpoints, but Worker cron triggers that need to be implemented.

| Schedule | Name | Description |
|----------|------|-------------|
| */15 * * * * | Notification Processor | Send queued/scheduled notifications |
| */15 * * * * | Social Post Publisher | Publish approved posts at scheduled time |
| */30 * * * * | WC Spreadsheet Sync | Push data to Google Sheets (carry forward) |
| 0 * * * * | Invoice Due Check | Check for invoices approaching due date or past due → trigger reminders |
| 0 */6 * * * | HL Pipeline Sync | Pull latest HL pipeline data |
| 0 0 * * * | Nightly Backup | D1 → R2 backup |
| 0 6 * * * | Daily Summary | Send daily summary email via Resend |
| 0 0 * * 0 | Weekly Photo Summary | Generate weekly photo summaries for active jobs |
| 0 0 * * * | Google Drive Mirror | Process pending document/photo mirrors |
| 0 0 * * * | Late Fee Calculator | Update late fee amounts on overdue invoices |
| 0 0 * * * | QBO Sync | Push pending financial data to QuickBooks |

---

## Route Count Summary

| Module | Routes |
|--------|--------|
| System & Admin | 18 |
| Clients | 12 |
| Estimating | 22 |
| Job Management | 24 |
| Financial | 28 |
| Photo Capture | 13 live + 3 deferred (annotate, pair, photo-report) |
| Documents | 13 |
| Smart Notes | 7 |
| Notifications | 8 |
| Social Media | 10 |
| Client Portal | 12 |
| Subcontractors | 4 |
| Webhooks | 5 |
| **Total** | **~173 endpoints** |

Plus 11 cron jobs.
