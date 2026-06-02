# Unified Database Schema
## CHS Construction Management Platform
### Version 1.0 — May 28, 2026

---

## Overview

This document consolidates every data model from the 9 module specs into a single canonical schema for the Cloudflare D1 (SQLite) database. It defines all tables, columns, types, constraints, foreign keys, indexes, and enums. This is the single source of truth for Cursor when writing D1 migration files.

**Database:** Cloudflare D1 (SQLite dialect)
**Migration sequence:** Continues from existing chs-hub at 0011+
**UUID strategy:** Generated via `crypto.randomUUID()` in the Worker, stored as TEXT
**Timestamps:** ISO 8601 strings stored as TEXT (SQLite has no native datetime)
**Computed fields:** Calculated in application code or via SQL views — not stored unless caching is needed for performance

---

## Table of Contents

1. System & Admin Tables (users, system_settings, audit_logs, integration_connections)
2. Client Tables (clients, properties, communications)
3. Estimating Tables (estimate_requests, estimates, estimate_line_items, estimate_sub_items, payment_schedules, estimate_templates, saved_reviews)
4. Job Tables (jobs, tasks, daily_logs, change_orders, schedule_entries, permits, warranties)
5. Financial Tables (invoices, payments, expenses, time_entries, billing_cycles, mileage, lien_waivers, vendor_materials)
6. Photo Tables (photos, receipt_photos)
7. Document Tables (documents, document_templates)
8. Notification Tables (notification_templates, notification_logs)
9. Social Media Tables (social_posts, content_schedules)
10. Shared/Reference Tables (subcontractors, smart_notes)
11. Indexes
12. Views (computed aggregates)

---

## 1. System & Admin Tables

### users

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| email | TEXT | NOT NULL, UNIQUE | Login identity — matches Cloudflare Access |
| first_name | TEXT | NOT NULL | |
| last_name | TEXT | NOT NULL | |
| phone | TEXT | | |
| role | TEXT | NOT NULL, CHECK(role IN ('owner','project_manager','field_crew','office_admin')) | |
| is_active | INTEGER | NOT NULL DEFAULT 1 | 0/1 boolean |
| last_login | TEXT | | ISO 8601 |
| notification_preferences | TEXT | | JSON blob |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| updated_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### system_settings

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| key | TEXT | PRIMARY KEY | e.g. "labor_rate_general" |
| value | TEXT | NOT NULL | Stored as text, parsed by value_type |
| value_type | TEXT | NOT NULL, CHECK(value_type IN ('string','number','boolean','json')) | |
| category | TEXT | NOT NULL | "financial", "notifications", "integrations", "company", "billing" |
| label | TEXT | NOT NULL | Human-readable |
| description | TEXT | | |
| updated_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| updated_by | TEXT | | User email |

### audit_logs

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| user_email | TEXT | NOT NULL | |
| action | TEXT | NOT NULL | e.g. "job_status_changed", "invoice_created" |
| entity_type | TEXT | NOT NULL | e.g. "job", "invoice", "client" |
| entity_id | TEXT | NOT NULL | UUID of affected record |
| details | TEXT | | JSON — old/new values |
| ip_address | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### integration_connections

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| service | TEXT | NOT NULL, CHECK(service IN ('stripe','quickbooks','twilio','high_level','google_drive','facebook','instagram','replicate')) | |
| status | TEXT | NOT NULL, CHECK(status IN ('connected','disconnected','error','pending')) | |
| access_token | TEXT | | Encrypted |
| refresh_token | TEXT | | Encrypted |
| token_expiry | TEXT | | ISO 8601 |
| account_id | TEXT | | External account ID |
| configuration | TEXT | | JSON — service-specific settings |
| last_sync | TEXT | | |
| last_error | TEXT | | |
| connected_at | TEXT | | |
| connected_by | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| updated_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

---

## 2. Client Tables

### clients

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| first_name | TEXT | NOT NULL | |
| last_name | TEXT | NOT NULL | |
| email | TEXT | NOT NULL | Primary — for invoices, portal links |
| phone | TEXT | NOT NULL | |
| phone_secondary | TEXT | | |
| mailing_address | TEXT | | |
| mailing_city | TEXT | | |
| mailing_state | TEXT | | |
| mailing_zip | TEXT | | |
| lead_source | TEXT | | direct_call, google_lsa, thumbtack, website, referral, repeat |
| high_level_contact_id | TEXT | | FK to HL contact for sync |
| is_repeat_client | INTEGER | DEFAULT 0 | |
| review_requested | INTEGER | DEFAULT 0 | Google review requested for latest job |
| google_review_left | INTEGER | DEFAULT 0 | |
| notes | TEXT | | |
| last_interaction_date | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| updated_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| created_by | TEXT | | |

### properties

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| client_id | TEXT | NOT NULL REFERENCES clients(id) | |
| address | TEXT | NOT NULL | |
| city | TEXT | NOT NULL | |
| state | TEXT | NOT NULL DEFAULT 'Arkansas' | |
| zip | TEXT | NOT NULL | |
| property_type | TEXT | | "residential", "commercial", "rental" |
| notes | TEXT | | Gate codes, dog warnings, etc. |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### communications

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| client_id | TEXT | NOT NULL REFERENCES clients(id) | |
| job_id | TEXT | REFERENCES jobs(id) | Null for non-job comms |
| channel | TEXT | NOT NULL, CHECK(channel IN ('phone_call','text_sms','email','portal_message','in_person','other')) | |
| direction | TEXT | NOT NULL, CHECK(direction IN ('inbound','outbound')) | |
| summary | TEXT | NOT NULL | Brief description |
| body | TEXT | | Full content |
| duration_seconds | INTEGER | | For phone calls |
| call_recording_url | TEXT | | |
| sent_via | TEXT | | "twilio", "google_lsa", "high_level", "manual", "system_auto" |
| high_level_message_id | TEXT | | |
| attachments | TEXT | | Comma-separated document IDs |
| logged_by | TEXT | | User or "system" |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

---

## 3. Estimating Tables

### estimate_requests

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| request_number | INTEGER | NOT NULL UNIQUE | Auto-increment (REQ-001) |
| status | TEXT | NOT NULL, CHECK(status IN ('new_request','appointment_set','visit_done','building','sent','follow_up','won','lost')) | |
| client_id | TEXT | NOT NULL REFERENCES clients(id) | |
| property_address | TEXT | NOT NULL | |
| property_city | TEXT | NOT NULL | |
| property_state | TEXT | NOT NULL DEFAULT 'Arkansas' | |
| property_zip | TEXT | NOT NULL | |
| job_type | TEXT | NOT NULL | new_build, addition, remodel, etc. |
| lead_source | TEXT | NOT NULL | |
| lead_source_detail | TEXT | | |
| high_level_opportunity_id | TEXT | | |
| appointment_date | TEXT | | ISO 8601 |
| appointment_completed | INTEGER | DEFAULT 0 | |
| visit_notes | TEXT | | |
| visit_photo_ids | TEXT | | Comma-separated |
| estimate_id | TEXT | REFERENCES estimates(id) | |
| sent_date | TEXT | | |
| follow_up_count | INTEGER | DEFAULT 0 | |
| last_follow_up_date | TEXT | | |
| lost_reason | TEXT | | price_too_high, went_with_competitor, project_cancelled, no_response, timing, other |
| lost_notes | TEXT | | |
| converted_job_id | TEXT | REFERENCES jobs(id) | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| updated_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| created_by | TEXT | | |

### estimates

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| estimate_number | INTEGER | NOT NULL UNIQUE | Auto-increment (EST-001) |
| request_id | TEXT | NOT NULL REFERENCES estimate_requests(id) | |
| client_id | TEXT | NOT NULL REFERENCES clients(id) | |
| title | TEXT | NOT NULL | |
| estimate_mode | TEXT | NOT NULL, CHECK(estimate_mode IN ('lump_sum','trade_by_trade')) | |
| billing_model | TEXT | NOT NULL, CHECK(billing_model IN ('fixed_price','trade_by_trade','cost_plus')) | |
| status | TEXT | NOT NULL, CHECK(status IN ('draft','sent','viewed','approved','expired','revised')) | |
| subtotal | REAL | | Computed: sum of parent line items |
| tax_amount | REAL | DEFAULT 0 | |
| total | REAL | | Computed: subtotal + tax |
| deposit_amount | REAL | NOT NULL | |
| deposit_type | TEXT | NOT NULL | "percentage" or "fixed" |
| deposit_percentage | REAL | | |
| valid_days | INTEGER | NOT NULL DEFAULT 7 | |
| expiration_date | TEXT | | Computed: sent_date + valid_days |
| portal_token | TEXT | UNIQUE | Secure link token |
| include_reviews | INTEGER | NOT NULL DEFAULT 1 | |
| review_ids | TEXT | | Comma-separated |
| include_contract | INTEGER | NOT NULL DEFAULT 1 | |
| contract_template_id | TEXT | REFERENCES document_templates(id) | |
| client_signature | TEXT | | |
| signed_date | TEXT | | |
| notes | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| updated_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| created_by | TEXT | | |

### estimate_line_items

Parent items — what the client sees.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| estimate_id | TEXT | NOT NULL REFERENCES estimates(id) ON DELETE CASCADE | |
| sort_order | INTEGER | NOT NULL | |
| product_service | TEXT | NOT NULL | Category name |
| description | TEXT | NOT NULL | Scope of work |
| quantity | REAL | NOT NULL DEFAULT 1 | |
| unit | TEXT | | "each", "sqft", etc. |
| unit_price | REAL | NOT NULL | |
| total | REAL | | Computed: quantity × unit_price |
| includes_note | TEXT | | e.g. "Price includes labor and materials" |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### estimate_sub_items

Internal cost breakdown — NOT visible to client.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| parent_line_item_id | TEXT | NOT NULL REFERENCES estimate_line_items(id) ON DELETE CASCADE | |
| sort_order | INTEGER | NOT NULL | |
| description | TEXT | NOT NULL | |
| category | TEXT | NOT NULL | "material", "labor", "subcontractor", "permit", "equipment", "other" |
| vendor | TEXT | | |
| quantity | REAL | | |
| unit | TEXT | | |
| unit_cost | REAL | NOT NULL | |
| total_cost | REAL | | Computed: quantity × unit_cost |
| material_id | TEXT | REFERENCES vendor_materials(id) | |
| notes | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### payment_schedules

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| estimate_id | TEXT | NOT NULL REFERENCES estimates(id) ON DELETE CASCADE | |
| sort_order | INTEGER | NOT NULL | |
| description | TEXT | NOT NULL | |
| percentage | REAL | | |
| fixed_amount | REAL | | |
| amount | REAL | | Computed |
| is_deposit | INTEGER | DEFAULT 0 | |
| trigger | TEXT | | "contract_signing", "milestone", "trade_completion", "bi_weekly_cycle", "completion" |
| notes | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### estimate_templates

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| name | TEXT | NOT NULL | |
| job_type | TEXT | NOT NULL | |
| description | TEXT | | |
| default_billing_model | TEXT | | |
| line_items | TEXT | NOT NULL | JSON array |
| default_payment_schedule | TEXT | | JSON |
| is_active | INTEGER | NOT NULL DEFAULT 1 | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| updated_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### saved_reviews

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| reviewer_name | TEXT | NOT NULL | |
| review_date | TEXT | | |
| rating | INTEGER | NOT NULL CHECK(rating BETWEEN 1 AND 5) | |
| review_text | TEXT | NOT NULL | |
| source | TEXT | NOT NULL | "google", "facebook", "manual" |
| is_active | INTEGER | NOT NULL DEFAULT 1 | |
| sort_order | INTEGER | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

---

## 4. Job Tables

### jobs

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_number | INTEGER | NOT NULL UNIQUE | Auto-increment (JOB-001) |
| title | TEXT | NOT NULL | |
| status | TEXT | NOT NULL, CHECK(status IN ('deposit_paid','scheduled','in_progress','punch_list','complete','closed')) | |
| billing_model | TEXT | NOT NULL, CHECK(billing_model IN ('fixed_price','trade_by_trade','cost_plus')) | |
| client_id | TEXT | NOT NULL REFERENCES clients(id) | |
| property_address | TEXT | NOT NULL | |
| property_city | TEXT | NOT NULL | |
| property_state | TEXT | NOT NULL DEFAULT 'Arkansas' | |
| property_zip | TEXT | NOT NULL | |
| job_type | TEXT | NOT NULL | |
| lead_source | TEXT | | |
| estimate_id | TEXT | NOT NULL REFERENCES estimates(id) | |
| start_date | TEXT | | |
| target_end_date | TEXT | | |
| actual_end_date | TEXT | | |
| contract_total | REAL | | From approved estimate |
| deposit_amount | REAL | | |
| deposit_paid | INTEGER | DEFAULT 0 | |
| portal_token | TEXT | UNIQUE | Secure portal link |
| portal_type | TEXT | | "standard" or "cost_plus" |
| notes | TEXT | | |
| warranty_expiration | TEXT | | Computed: actual_end_date + 1 year |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| updated_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| created_by | TEXT | | |

### tasks

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_id | TEXT | NOT NULL REFERENCES jobs(id) ON DELETE CASCADE | |
| task_group | TEXT | NOT NULL | Trade/phase name |
| task_group_order | INTEGER | NOT NULL | |
| title | TEXT | NOT NULL | |
| status | TEXT | NOT NULL, CHECK(status IN ('pending','in_progress','complete','skipped')) | |
| assigned_to | TEXT | | Sub or crew member name |
| scheduled_date | TEXT | | |
| completed_date | TEXT | | |
| completed_by | TEXT | | |
| notes | TEXT | | |
| sort_order | INTEGER | NOT NULL | |
| is_punch_list | INTEGER | DEFAULT 0 | |
| photo_ids | TEXT | | Comma-separated |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### daily_logs

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_id | TEXT | NOT NULL REFERENCES jobs(id) | |
| log_date | TEXT | NOT NULL | |
| weather | TEXT | | |
| work_performed | TEXT | NOT NULL | |
| issues | TEXT | | |
| materials_used | TEXT | | |
| crew_on_site | TEXT | | |
| hours_worked | REAL | | |
| photo_ids | TEXT | | |
| entered_via | TEXT | NOT NULL | "web", "mobile", "voice" |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| created_by | TEXT | | |

### change_orders

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_id | TEXT | NOT NULL REFERENCES jobs(id) | |
| change_order_number | INTEGER | NOT NULL | Sequential per job |
| title | TEXT | NOT NULL | |
| description | TEXT | NOT NULL | |
| amount | REAL | NOT NULL | Positive = addition, negative = credit |
| status | TEXT | NOT NULL, CHECK(status IN ('draft','sent','approved','rejected')) | |
| requested_date | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| approved_date | TEXT | | |
| client_signature | TEXT | | |
| triggered_by_note_id | TEXT | REFERENCES smart_notes(id) | |
| created_by | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| applied_at | TEXT | | Set exactly once when the signed CO is applied (idempotency guard) — see migration 0035 |
| end_date_extension_days | INTEGER | DEFAULT 0 | Days added to `jobs.estimated_end_date` on apply |
| signed_name | TEXT | | Client's typed name captured at portal signature |
| signed_ip | TEXT | | Client IP captured at portal signature |

**Indexes:** `idx_change_orders_job_id (job_id)`, `idx_change_orders_job_number_unique (job_id, change_order_number)` UNIQUE — enforces sequential per-job numbering (added in migration 0035).

`applied_at`/`end_date_extension_days`/`signed_name`/`signed_ip` and the unique index were added in **0035_change_orders_apply.sql** to support the digital-signature → auto-apply flow. The atomic `UPDATE ... WHERE applied_at IS NULL` makes `applyChangeOrder()` exactly-once even under concurrent portal signatures.

### schedule_entries

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_id | TEXT | NOT NULL REFERENCES jobs(id) | |
| scheduled_date | TEXT | NOT NULL | |
| trade_or_work | TEXT | NOT NULL | |
| sub_id | TEXT | REFERENCES subcontractors(id) | |
| start_time | TEXT | | |
| end_time | TEXT | | |
| notes | TEXT | | |
| notification_sent | INTEGER | DEFAULT 0 | |
| status | TEXT | NOT NULL, CHECK(status IN ('scheduled','in_progress','completed','cancelled','weather_delay')) | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### permits

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_id | TEXT | NOT NULL REFERENCES jobs(id) | |
| permit_type | TEXT | NOT NULL | "building", "electrical", "plumbing", "mechanical", "demo" |
| permit_number | TEXT | | |
| status | TEXT | NOT NULL, CHECK(status IN ('applied','approved','inspection_scheduled','passed','failed','closed')) | |
| applied_date | TEXT | | |
| approved_date | TEXT | | |
| inspection_date | TEXT | | |
| inspection_result | TEXT | | |
| cost | REAL | | |
| document_id | TEXT | REFERENCES documents(id) | |
| notes | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### warranties

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_id | TEXT | NOT NULL REFERENCES jobs(id) | |
| claim_date | TEXT | NOT NULL | |
| description | TEXT | NOT NULL | |
| status | TEXT | NOT NULL, CHECK(status IN ('reported','scheduled','resolved')) | |
| resolution | TEXT | | |
| resolved_date | TEXT | | |
| cost | REAL | | |
| photo_ids | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

---

## 5. Financial Tables

### invoices

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| invoice_number | INTEGER | NOT NULL UNIQUE | Auto-increment (INV-001) |
| job_id | TEXT | NOT NULL REFERENCES jobs(id) | |
| client_id | TEXT | NOT NULL REFERENCES clients(id) | |
| billing_model | TEXT | NOT NULL | |
| invoice_type | TEXT | NOT NULL, CHECK(invoice_type IN ('deposit','milestone','trade_completion','cost_plus_cycle','final','change_order','manual')) | |
| title | TEXT | NOT NULL | |
| description | TEXT | | |
| amount | REAL | NOT NULL | |
| tax_amount | REAL | DEFAULT 0 | |
| late_fee_amount | REAL | DEFAULT 0 | Computed: $50/day after due |
| credits_applied | REAL | DEFAULT 0 | |
| total_due | REAL | | Computed: amount + tax - credits + late_fee |
| status | TEXT | NOT NULL, CHECK(status IN ('draft','sent','viewed','paid','partial','past_due','void')) | |
| sent_date | TEXT | | |
| due_date | TEXT | NOT NULL | |
| paid_date | TEXT | | |
| paid_amount | REAL | | |
| payment_method | TEXT | | |
| stripe_payment_id | TEXT | | |
| portal_link | TEXT | | |
| cost_plus_cycle_id | TEXT | REFERENCES billing_cycles(id) | |
| milestone_number | INTEGER | | |
| trade_line_item_id | TEXT | REFERENCES estimate_line_items(id) | |
| notes | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| created_by | TEXT | | |

### payments

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| invoice_id | TEXT | NOT NULL REFERENCES invoices(id) | |
| job_id | TEXT | NOT NULL REFERENCES jobs(id) | |
| client_id | TEXT | NOT NULL REFERENCES clients(id) | |
| amount | REAL | NOT NULL | |
| payment_method | TEXT | NOT NULL, CHECK(payment_method IN ('credit_card','ach','check','cash')) | |
| stripe_payment_id | TEXT | | |
| stripe_fee | REAL | | |
| convenience_fee | REAL | | 3.5% on electronic |
| net_amount | REAL | | Computed: amount - stripe_fee |
| received_date | TEXT | NOT NULL | |
| deposited_date | TEXT | | |
| notes | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### expenses

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_id | TEXT | REFERENCES jobs(id) | Null for general/non-job expenses |
| expense_type | TEXT | NOT NULL, CHECK(expense_type IN ('material','subcontractor','labor','permit','equipment_rental','vehicle','office','insurance','other')) | |
| vendor | TEXT | | |
| description | TEXT | NOT NULL | |
| amount | REAL | NOT NULL | |
| incurred_date | TEXT | NOT NULL | |
| estimate_line_item_id | TEXT | REFERENCES estimate_sub_items(id) | For job costing alignment |
| receipt_photo_id | TEXT | REFERENCES photos(id) | |
| receipt_r2_key | TEXT | | |
| tax_category | TEXT | | IRS category for CPA export |
| is_1099_reportable | INTEGER | DEFAULT 0 | |
| sub_id | TEXT | REFERENCES subcontractors(id) | |
| entered_via | TEXT | NOT NULL | "web", "mobile", "pwa", "receipt_capture", "auto" |
| pushed_to_qbo | INTEGER | DEFAULT 0 | |
| qbo_transaction_id | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| created_by | TEXT | | |

### time_entries

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_id | TEXT | NOT NULL REFERENCES jobs(id) | |
| worker | TEXT | NOT NULL | |
| role | TEXT | NOT NULL, CHECK(role IN ('general','pm_skilled')) | |
| clock_in | TEXT | NOT NULL | |
| clock_out | TEXT | | Null = still clocked in |
| hours | REAL | | Computed: rounded to 0.25 |
| hourly_rate | REAL | | 90.00 or 105.00 |
| labor_cost | REAL | | Computed: hours × rate |
| notes | TEXT | | |
| entered_via | TEXT | NOT NULL | "web", "mobile", "auto" |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### billing_cycles

Cost-plus bi-weekly billing cycles.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_id | TEXT | NOT NULL REFERENCES jobs(id) | |
| cycle_number | INTEGER | NOT NULL | Sequential per job |
| period_start | TEXT | NOT NULL | |
| period_end | TEXT | NOT NULL | |
| is_final_cycle | INTEGER | DEFAULT 0 | |
| status | TEXT | NOT NULL, CHECK(status IN ('planning','active','reconciling','closed')) | |
| projected_materials | REAL | DEFAULT 0 | |
| projected_labor | REAL | DEFAULT 0 | |
| projected_subs | REAL | DEFAULT 0 | |
| projected_subtotal | REAL | | Computed |
| pm_fee_rate | REAL | NOT NULL DEFAULT 0.10 | |
| contractor_fee_rate | REAL | NOT NULL DEFAULT 0.20 | |
| projected_pm_fee | REAL | | Computed |
| projected_contractor_fee | REAL | | Computed |
| projected_total | REAL | | Computed |
| actual_materials | REAL | DEFAULT 0 | |
| actual_labor | REAL | DEFAULT 0 | |
| actual_subs | REAL | DEFAULT 0 | |
| actual_subtotal | REAL | | Computed |
| actual_pm_fee | REAL | | Computed |
| actual_contractor_fee | REAL | | Computed |
| actual_total | REAL | | Computed |
| delta | REAL | | Computed: projected - actual |
| credit_from_prior | REAL | DEFAULT 0 | |
| credit_to_next | REAL | DEFAULT 0 | |
| invoice_id | TEXT | REFERENCES invoices(id) | Upfront invoice |
| reconciliation_invoice_id | TEXT | REFERENCES invoices(id) | If over budget |
| reconciliation_date | TEXT | | |
| notes | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### mileage

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_id | TEXT | REFERENCES jobs(id) | Null for non-job trips |
| trip_purpose | TEXT | NOT NULL | "job_site", "supply_run", "estimate_appointment", "office", "other" |
| start_location | TEXT | | |
| end_location | TEXT | | |
| distance_miles | REAL | NOT NULL | |
| trip_date | TEXT | NOT NULL | |
| irs_rate | REAL | | From system_settings |
| deduction_amount | REAL | | Computed: miles × rate |
| notes | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### lien_waivers

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_id | TEXT | NOT NULL REFERENCES jobs(id) | |
| sub_id | TEXT | NOT NULL REFERENCES subcontractors(id) | |
| waiver_type | TEXT | NOT NULL, CHECK(waiver_type IN ('conditional','unconditional','partial','final')) | |
| payment_amount | REAL | NOT NULL | |
| status | TEXT | NOT NULL, CHECK(status IN ('requested','received','filed')) | |
| requested_date | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| received_date | TEXT | | |
| document_id | TEXT | REFERENCES documents(id) | |
| notes | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### vendor_materials

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| vendor_name | TEXT | NOT NULL | |
| material_name | TEXT | NOT NULL | |
| category | TEXT | NOT NULL | "lumber", "concrete", "electrical", "plumbing", etc. |
| unit | TEXT | NOT NULL | |
| last_price | REAL | NOT NULL | |
| last_purchased_date | TEXT | | |
| average_price | REAL | | Computed rolling average |
| price_history | TEXT | | JSON array |
| notes | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| updated_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

---

## 6. Photo Tables

### photos

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_id | TEXT | REFERENCES jobs(id) | Null for non-job photos |
| estimate_request_id | TEXT | REFERENCES estimate_requests(id) | For visit photos |
| r2_key | TEXT | NOT NULL | Full-size R2 key |
| r2_thumbnail_key | TEXT | | |
| r2_url | TEXT | NOT NULL | |
| google_drive_id | TEXT | | After mirror |
| photo_type | TEXT | NOT NULL, CHECK(photo_type IN ('job_progress','before','after','receipt','permit','punch_list','visit','general')) | |
| caption | TEXT | | |
| latitude | REAL | | |
| longitude | REAL | | |
| location_accuracy | REAL | | Meters |
| taken_at | TEXT | NOT NULL | Device/EXIF time |
| uploaded_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| synced_from_offline | INTEGER | DEFAULT 0 | |
| task_id | TEXT | REFERENCES tasks(id) | |
| daily_log_id | TEXT | REFERENCES daily_logs(id) | |
| is_annotated | INTEGER | DEFAULT 0 | |
| annotation_data | TEXT | | JSON overlay |
| is_social_ready | INTEGER | DEFAULT 0 | |
| is_before_photo | INTEGER | DEFAULT 0 | |
| is_after_photo | INTEGER | DEFAULT 0 | |
| before_after_pair_id | TEXT | REFERENCES photos(id) | Links before to after |
| ai_tags | TEXT | | JSON |
| entered_via | TEXT | NOT NULL | "pwa", "web", "mobile_app" |
| is_active | INTEGER | NOT NULL DEFAULT 1 | Soft delete |
| created_by | TEXT | | |

### receipt_photos

Extension of photos for AI-processed receipts.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| photo_id | TEXT | NOT NULL UNIQUE REFERENCES photos(id) ON DELETE CASCADE | |
| ai_vendor | TEXT | | |
| ai_amount | REAL | | |
| ai_date | TEXT | | |
| ai_category | TEXT | | |
| ai_confidence | REAL | | |
| expense_id | TEXT | REFERENCES expenses(id) | Linked after confirmation |
| processing_status | TEXT | NOT NULL, CHECK(processing_status IN ('pending','processed','confirmed','failed')) | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

---

## 7. Document Tables

### documents

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| title | TEXT | NOT NULL | |
| file_type | TEXT | NOT NULL | MIME type or extension |
| file_size | INTEGER | | Bytes |
| r2_key | TEXT | NOT NULL | |
| r2_url | TEXT | NOT NULL | |
| google_drive_id | TEXT | | |
| google_drive_url | TEXT | | |
| mirror_status | TEXT | | "pending", "synced", "failed" |
| mirror_date | TEXT | | |
| context_type | TEXT | NOT NULL, CHECK(context_type IN ('job','client','estimate','company','template')) | |
| job_id | TEXT | REFERENCES jobs(id) | |
| client_id | TEXT | REFERENCES clients(id) | |
| estimate_id | TEXT | REFERENCES estimates(id) | |
| document_category | TEXT | NOT NULL | "contract", "change_order", "permit", "plan_drawing", "receipt", "invoice", "lien_waiver", "insurance", "license", "sop", "photo_report", "completion_package", "other" |
| is_signed | INTEGER | DEFAULT 0 | |
| signed_date | TEXT | | |
| signature_data | TEXT | | |
| share_token | TEXT | UNIQUE | |
| share_expiration | TEXT | | |
| is_active | INTEGER | NOT NULL DEFAULT 1 | Soft delete |
| uploaded_by | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| updated_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### document_templates

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| name | TEXT | NOT NULL | |
| template_type | TEXT | NOT NULL | "service_agreement", "cost_plus_agreement", "change_order", "lien_waiver", "proposal", "other" |
| content | TEXT | NOT NULL | Template with {{merge_field}} placeholders |
| merge_fields | TEXT | NOT NULL | JSON array of available fields |
| is_active | INTEGER | NOT NULL DEFAULT 1 | |
| version | INTEGER | NOT NULL DEFAULT 1 | Auto-increment on edit |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| updated_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

---

## 8. Notification Tables

### notification_templates

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| trigger_event | TEXT | NOT NULL | e.g. "lead_created", "payment_received" |
| name | TEXT | NOT NULL | |
| recipient_type | TEXT | NOT NULL, CHECK(recipient_type IN ('client','subcontractor','internal','owner')) | |
| channel | TEXT | NOT NULL, CHECK(channel IN ('sms','email','push','in_app')) | |
| subject | TEXT | | Email only |
| body_template | TEXT | NOT NULL | With {{merge_fields}} |
| merge_fields | TEXT | NOT NULL | JSON |
| is_active | INTEGER | NOT NULL DEFAULT 1 | |
| delay_minutes | INTEGER | DEFAULT 0 | |
| send_time | TEXT | | Specific time of day |
| phase | TEXT | | "estimating", "job", "financial", "post_job" |
| sort_order | INTEGER | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| updated_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### notification_logs

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| template_id | TEXT | NOT NULL REFERENCES notification_templates(id) | |
| trigger_event | TEXT | NOT NULL | |
| recipient_type | TEXT | NOT NULL | |
| recipient_name | TEXT | NOT NULL | |
| recipient_contact | TEXT | NOT NULL | Phone or email |
| channel | TEXT | NOT NULL | |
| subject | TEXT | | |
| body | TEXT | NOT NULL | Rendered message |
| status | TEXT | NOT NULL, CHECK(status IN ('queued','sent','delivered','failed','bounced')) | |
| error_message | TEXT | | |
| job_id | TEXT | REFERENCES jobs(id) | |
| client_id | TEXT | REFERENCES clients(id) | |
| estimate_request_id | TEXT | REFERENCES estimate_requests(id) | |
| communication_id | TEXT | REFERENCES communications(id) | |
| sent_at | TEXT | | |
| delivered_at | TEXT | | |
| external_id | TEXT | | Twilio SID, email ID |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

---

## 9. Social Media Tables

### social_posts

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| post_type | TEXT | NOT NULL, CHECK(post_type IN ('job_completion','seasonal_tips','tips_tricks','promotion','review_highlight','manual')) | |
| status | TEXT | NOT NULL, CHECK(status IN ('draft','pending_approval','approved','scheduled','published','rejected','failed')) | |
| caption | TEXT | NOT NULL | |
| hashtags | TEXT | | |
| platform | TEXT | NOT NULL, CHECK(platform IN ('both','facebook_only','instagram_only')) | |
| scheduled_date | TEXT | | |
| published_date | TEXT | | |
| job_id | TEXT | REFERENCES jobs(id) | |
| photo_ids | TEXT | | Comma-separated |
| ai_generated_image_url | TEXT | | R2 key or URL |
| facebook_post_id | TEXT | | |
| instagram_post_id | TEXT | | |
| facebook_url | TEXT | | |
| instagram_url | TEXT | | |
| engagement_data | TEXT | | JSON |
| rejection_reason | TEXT | | |
| generated_by | TEXT | NOT NULL | "ai_schedule", "ai_job_complete", "manual" |
| approved_by | TEXT | | |
| approved_date | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### content_schedules

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| month | INTEGER | NOT NULL | 1-12 |
| year | INTEGER | NOT NULL | |
| status | TEXT | NOT NULL, CHECK(status IN ('draft','active','completed')) | |
| generated_date | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| notes | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

---

## 10. Shared / Reference Tables

### subcontractors

Carry forward from chs-hub.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| company_name | TEXT | NOT NULL | |
| contact_name | TEXT | | |
| phone | TEXT | | |
| email | TEXT | | |
| trade | TEXT | NOT NULL | "electrical", "plumbing", "hvac", "concrete", "roofing", "drywall", "painting", "flooring", "cabinetry", "tile", "stone", "insulation", "framing", "general" |
| license_number | TEXT | | |
| insurance_on_file | INTEGER | DEFAULT 0 | |
| w9_on_file | INTEGER | DEFAULT 0 | |
| hourly_rate | REAL | | If applicable |
| flat_rate_notes | TEXT | | Common flat-rate pricing |
| rating | INTEGER | | Internal 1-5 rating |
| notes | TEXT | | |
| is_active | INTEGER | NOT NULL DEFAULT 1 | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| updated_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### smart_notes

Carry forward from chs-hub.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| job_id | TEXT | REFERENCES jobs(id) | Null for general notes |
| raw_content | TEXT | NOT NULL | Original voice-to-text or typed input |
| ai_summary | TEXT | | Claude-generated summary |
| ai_category | TEXT | | "general", "task", "expense", "change_order", "scheduling", "client_communication" |
| ai_extracted_tasks | TEXT | | JSON array of suggested tasks |
| ai_extracted_expense | TEXT | | JSON — suggested expense entry |
| ai_extracted_change_order | TEXT | | JSON — suggested CO |
| is_processed | INTEGER | DEFAULT 0 | Whether AI has processed |
| processing_status | TEXT | | "pending", "processed", "failed" |
| entered_via | TEXT | NOT NULL | "voice", "text", "web", "mobile" |
| created_by | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |

### dead_letter_queue

Carry forward from chs-hub reliability subsystem.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PRIMARY KEY | UUID |
| operation | TEXT | NOT NULL | What failed |
| payload | TEXT | | JSON — original request data |
| error_message | TEXT | | |
| retry_count | INTEGER | NOT NULL DEFAULT 0 | |
| max_retries | INTEGER | NOT NULL DEFAULT 3 | |
| status | TEXT | NOT NULL, CHECK(status IN ('pending','retrying','resolved','dismissed')) | |
| next_retry_at | TEXT | | |
| created_at | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| resolved_at | TEXT | | |

---

## 11. Indexes

Performance-critical indexes for the most common queries.

```sql
-- Jobs
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_client_id ON jobs(client_id);
CREATE INDEX idx_jobs_job_type ON jobs(job_type);
CREATE INDEX idx_jobs_start_date ON jobs(start_date);

-- Tasks
CREATE INDEX idx_tasks_job_id ON tasks(job_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_scheduled_date ON tasks(scheduled_date);

-- Estimates
CREATE INDEX idx_estimate_requests_status ON estimate_requests(status);
CREATE INDEX idx_estimate_requests_client_id ON estimate_requests(client_id);
CREATE INDEX idx_estimates_request_id ON estimates(request_id);
CREATE INDEX idx_estimates_status ON estimates(status);
CREATE INDEX idx_estimate_line_items_estimate_id ON estimate_line_items(estimate_id);
CREATE INDEX idx_estimate_sub_items_parent_id ON estimate_sub_items(parent_line_item_id);

-- Financial
CREATE INDEX idx_invoices_job_id ON invoices(job_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);
CREATE INDEX idx_payments_invoice_id ON payments(invoice_id);
CREATE INDEX idx_payments_job_id ON payments(job_id);
CREATE INDEX idx_expenses_job_id ON expenses(job_id);
CREATE INDEX idx_expenses_incurred_date ON expenses(incurred_date);
CREATE INDEX idx_time_entries_job_id ON time_entries(job_id);
CREATE INDEX idx_billing_cycles_job_id ON billing_cycles(job_id);

-- Photos
CREATE INDEX idx_photos_job_id ON photos(job_id);
CREATE INDEX idx_photos_photo_type ON photos(photo_type);
CREATE INDEX idx_photos_taken_at ON photos(taken_at);
CREATE INDEX idx_photos_is_social_ready ON photos(is_social_ready) WHERE is_social_ready = 1;

-- Documents
CREATE INDEX idx_documents_job_id ON documents(job_id);
CREATE INDEX idx_documents_context_type ON documents(context_type);
CREATE INDEX idx_documents_document_category ON documents(document_category);

-- Clients
CREATE INDEX idx_clients_email ON clients(email);
CREATE INDEX idx_clients_phone ON clients(phone);
CREATE INDEX idx_clients_high_level_contact_id ON clients(high_level_contact_id);

-- Communications
CREATE INDEX idx_communications_client_id ON communications(client_id);
CREATE INDEX idx_communications_job_id ON communications(job_id);
CREATE INDEX idx_communications_created_at ON communications(created_at);

-- Notifications
CREATE INDEX idx_notification_logs_job_id ON notification_logs(job_id);
CREATE INDEX idx_notification_logs_status ON notification_logs(status);
CREATE INDEX idx_notification_logs_trigger_event ON notification_logs(trigger_event);

-- Social
CREATE INDEX idx_social_posts_status ON social_posts(status);
CREATE INDEX idx_social_posts_scheduled_date ON social_posts(scheduled_date);

-- Schedule
CREATE INDEX idx_schedule_entries_job_id ON schedule_entries(job_id);
CREATE INDEX idx_schedule_entries_scheduled_date ON schedule_entries(scheduled_date);
CREATE INDEX idx_schedule_entries_sub_id ON schedule_entries(sub_id);

-- Audit
CREATE INDEX idx_audit_logs_entity_type ON audit_logs(entity_type);
CREATE INDEX idx_audit_logs_entity_id ON audit_logs(entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);

-- Smart Notes
CREATE INDEX idx_smart_notes_job_id ON smart_notes(job_id);

-- DLQ
CREATE INDEX idx_dlq_status ON dead_letter_queue(status);

-- Misc
CREATE INDEX idx_change_orders_job_id ON change_orders(job_id);
CREATE UNIQUE INDEX idx_change_orders_job_number_unique ON change_orders(job_id, change_order_number); -- 0035
CREATE INDEX idx_permits_job_id ON permits(job_id);
CREATE INDEX idx_warranties_job_id ON warranties(job_id);
CREATE INDEX idx_daily_logs_job_id ON daily_logs(job_id);
CREATE INDEX idx_daily_logs_log_date ON daily_logs(log_date);
CREATE INDEX idx_lien_waivers_job_id ON lien_waivers(job_id);
CREATE INDEX idx_mileage_job_id ON mileage(job_id);
CREATE INDEX idx_properties_client_id ON properties(client_id);
CREATE INDEX idx_vendor_materials_category ON vendor_materials(category);
```

---

## 12. SQL Views (Computed Aggregates)

These views provide computed values referenced in the specs without storing duplicate data.

```sql
-- Job financial summary (replaces computed fields on jobs table)
CREATE VIEW v_job_financials AS
SELECT
  j.id AS job_id,
  COALESCE(SUM(CASE WHEN i.status != 'void' THEN i.amount END), 0) AS total_invoiced,
  COALESCE(SUM(p.amount), 0) AS total_paid,
  COALESCE(SUM(e.amount), 0) AS total_expenses,
  COALESCE(SUM(p.amount), 0) - COALESCE(SUM(e.amount), 0) AS profit,
  CASE WHEN COALESCE(SUM(p.amount), 0) > 0
    THEN (COALESCE(SUM(p.amount), 0) - COALESCE(SUM(e.amount), 0)) / COALESCE(SUM(p.amount), 0) * 100
    ELSE 0 END AS profit_margin
FROM jobs j
LEFT JOIN invoices i ON i.job_id = j.id
LEFT JOIN payments p ON p.job_id = j.id
LEFT JOIN expenses e ON e.job_id = j.id
GROUP BY j.id;

-- Client computed fields
CREATE VIEW v_client_summary AS
SELECT
  c.id AS client_id,
  COUNT(DISTINCT j.id) AS total_jobs,
  COALESCE(SUM(p.amount), 0) AS total_revenue
FROM clients c
LEFT JOIN jobs j ON j.client_id = c.id
LEFT JOIN payments p ON p.client_id = c.id
GROUP BY c.id;

-- Content schedule computed counts
CREATE VIEW v_content_schedule_counts AS
SELECT
  cs.id AS schedule_id,
  COUNT(sp.id) AS total_posts_planned,
  COUNT(CASE WHEN sp.post_type = 'job_completion' THEN 1 END) AS job_completion_count,
  COUNT(CASE WHEN sp.post_type = 'seasonal_tips' THEN 1 END) AS seasonal_count,
  COUNT(CASE WHEN sp.post_type = 'tips_tricks' THEN 1 END) AS tips_count
FROM content_schedules cs
LEFT JOIN social_posts sp ON
  CAST(strftime('%m', sp.scheduled_date) AS INTEGER) = cs.month
  AND CAST(strftime('%Y', sp.scheduled_date) AS INTEGER) = cs.year
GROUP BY cs.id;
```

---

## 13. Table Summary

| # | Table | Module | Records (est.) | Notes |
|---|-------|--------|----------------|-------|
| 1 | users | System | < 10 | Starts with 1 (Owner) |
| 2 | system_settings | System | ~30 | Key-value store |
| 3 | audit_logs | System | High volume | Append-only |
| 4 | integration_connections | System | ~8 | One per service |
| 5 | clients | Client | Growing | Seed from Jobber imports |
| 6 | properties | Client | Growing | Multi-property support |
| 7 | communications | Client | High volume | All comms logged |
| 8 | estimate_requests | Estimating | Growing | Full pre-job pipeline |
| 9 | estimates | Estimating | Growing | One per request |
| 10 | estimate_line_items | Estimating | Med volume | Client-facing |
| 11 | estimate_sub_items | Estimating | High volume | Internal cost detail |
| 12 | payment_schedules | Estimating | Low volume | Per estimate |
| 13 | estimate_templates | Estimating | < 20 | Job type templates |
| 14 | saved_reviews | Estimating | < 50 | Curated reviews |
| 15 | jobs | Job Mgmt | Growing | Core table |
| 16 | tasks | Job Mgmt | High volume | Per job |
| 17 | daily_logs | Job Mgmt | High volume | Per job per day |
| 18 | change_orders | Job Mgmt | Low volume | Per job |
| 19 | schedule_entries | Job Mgmt | Med volume | Per job |
| 20 | permits | Job Mgmt | Low volume | Per job |
| 21 | warranties | Job Mgmt | Low volume | Post-completion |
| 22 | invoices | Financial | Growing | Per job |
| 23 | payments | Financial | Growing | Per invoice |
| 24 | expenses | Financial | High volume | Receipts, subs, labor |
| 25 | time_entries | Financial | High volume | Daily time tracking |
| 26 | billing_cycles | Financial | Low volume | Cost-plus only |
| 27 | mileage | Financial | Med volume | Tax deductions |
| 28 | lien_waivers | Financial | Low volume | Per sub per job |
| 29 | vendor_materials | Financial | Growing | Price database |
| 30 | photos | Photo | Very high volume | Core capture |
| 31 | receipt_photos | Photo | Med volume | AI-processed subset |
| 32 | documents | Document | High volume | All files |
| 33 | document_templates | Document | < 10 | Merge templates |
| 34 | notification_templates | Notifications | ~30 | Configurable |
| 35 | notification_logs | Notifications | Very high volume | Every notification |
| 36 | social_posts | Social | Growing | Monthly content |
| 37 | content_schedules | Social | ~12/year | Monthly |
| 38 | subcontractors | Shared | < 50 | Reference list |
| 39 | smart_notes | Shared | High volume | AI-processed |
| 40 | dead_letter_queue | System | Low volume | Failed ops |

**Total: 40 tables + 3 views**

---

## 14. Migration Strategy

Migrations continue from the existing chs-hub sequence (0011+). Recommended approach:

```
0012_core_schema.sql         — clients, properties, users, system_settings, subcontractors (extend existing)
0013_estimating_schema.sql   — estimate_requests, estimates, line_items, sub_items, schedules, templates, reviews
0014_jobs_schema.sql         — jobs, tasks, daily_logs, change_orders, schedule_entries, permits, warranties
0015_financial_schema.sql    — invoices, payments, expenses, time_entries, billing_cycles, mileage, lien_waivers, vendor_materials
0016_photos_schema.sql       — photos, receipt_photos (extend existing)
0017_documents_schema.sql    — documents, document_templates (extend existing)
0018_notifications_schema.sql — notification_templates, notification_logs
0019_social_schema.sql       — social_posts, content_schedules
0020_indexes.sql             — All indexes
0021_views.sql               — All computed views
0022_seed_data.sql           — Default system_settings, notification_templates, estimate_templates
...
0035_change_orders_apply.sql — change_orders: applied_at, end_date_extension_days, signed_name, signed_ip; UNIQUE(job_id, change_order_number); change_order_sent/_approved templates (Sprint 13)
0036_qbo_sync.sql            — QBO push targets + reference mapping (Sprint 14):
                               invoices.qbo_invoice_id, invoices.qbo_synced_at,
                               payments.qbo_payment_id, payments.qbo_synced_at,
                               clients.qbo_customer_id, subcontractors.qbo_vendor_id;
                               partial-UNIQUE idx_invoices_qbo_id / idx_payments_qbo_id,
                               idx_invoices_unsynced / idx_payments_unsynced;
                               sync_log.details TEXT (WC sync snapshot);
                               WC Spreadsheet config rows in system_settings (category 'wc_spreadsheet')
```

> **Sprint 14 note:** `integration_connections` was reused as-is for the QBO connection
> (encrypted `access_token`/`refresh_token`/`token_expiry`, `account_id`=realmId,
> `configuration` JSON for environment + expense_type→Account map). `expenses` already
> carried `pushed_to_qbo` + `qbo_transaction_id` (reused as the expense dirty flag + dedup
> anchor). QBO tokens are stored **AES-GCM encrypted** (key: `QBO_TOKEN_ENCRYPTION_KEY`) —
> there was no prior at-rest encryption scheme in the repo. **Direct-execute 0036**
> (`wrangler d1 execute --file=…`); do NOT `migrations apply` (ledger only records 0001–0013).

Each migration is idempotent where possible (CREATE TABLE IF NOT EXISTS, etc.) and tested with `npm run db:migrate:remote` after deployment.
