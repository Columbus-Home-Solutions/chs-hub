# Schema Bridge Migration
## CHS Construction Management Platform
### Version 1.0 — May 28, 2026

---

## Overview

The existing chs-hub D1 database has 26 user tables with production data. The new CHS platform schema defines 40 tables. This document maps every existing table to the new schema and tells Cursor exactly what to do: ALTER existing tables, CREATE new tables, or leave tables as-is for archival.

**Cardinal rule:** Never DROP existing tables or columns. All changes are additive. Existing data is preserved.

---

## Existing Tables (from live D1 dump)

```
ai_generations       drive_mirror_folders  integrations    leads          photos
audit_log            estimates             invoices        line_items     quotes
clients              expenses              job_files       notes          subcontractors
company_documents    file_shares           jobs            payments       sync_dead_letters
d1_migrations        file_tags             kv_cache        sync_log       users
files
```

System tables (ignore): `_cf_KV`, `sqlite_sequence`

---

## Migration Strategy by Table

### Category A: ALTER TABLE — Existing tables that map to new schema tables (add columns)

These tables exist and contain data. We add the missing columns defined in the Database Schema doc.

**Important:** Before writing ALTER statements, Cursor must inspect each table's current columns with:
```sql
PRAGMA table_info(table_name);
```
Only ADD columns that don't already exist. Wrap each ALTER in a try/catch or check first.

| Existing Table | New Schema Table | Action |
|---------------|-----------------|--------|
| `clients` | `clients` | ALTER — add missing columns (phone_secondary, mailing fields, high_level_contact_id, is_repeat_client, review fields, last_interaction_date) |
| `jobs` | `jobs` | ALTER — add missing columns (billing_model, property fields, job_type, lead_source, estimate_id, target_end_date, actual_end_date, contract_total, financial computed fields, deposit fields, portal_token, portal_type, warranty_expiration) |
| `estimates` | `estimates` | ALTER — add missing columns (estimate_number, request_id, estimate_mode, billing_model, deposit fields, portal_token, review/contract fields, signature fields) |
| `expenses` | `expenses` | ALTER — add missing columns (expense_type, estimate_line_item_id, receipt_photo_id, receipt_r2_key, tax_category, is_1099_reportable, sub_id, entered_via, qbo fields) |
| `invoices` | `invoices` | ALTER — add missing columns (billing_model, invoice_type, late_fee_amount, credits_applied, total_due, portal_link, cost_plus_cycle_id, milestone_number, trade_line_item_id) |
| `payments` | `payments` | ALTER — add missing columns (payment_method, stripe_fee, convenience_fee, net_amount, deposited_date) |
| `photos` | `photos` | ALTER — add missing columns (estimate_request_id, r2_thumbnail_key, photo_type, GPS fields, synced_from_offline, task_id, daily_log_id, annotation fields, social_ready, before/after fields, ai_tags, entered_via, is_active) |
| `subcontractors` | `subcontractors` | ALTER — add missing columns (trade, license_number, insurance_on_file, w9_on_file, hourly_rate, flat_rate_notes, rating, is_active) |
| `users` | `users` | ALTER — add missing columns (phone, role, is_active, last_login, notification_preferences) |
| `line_items` | `estimate_line_items` | Keep as-is. New `estimate_line_items` table created separately. Existing data preserved for historical estimates. |

### Category B: RENAME or MAP — Existing tables with different names

These tables exist but the new schema uses a different name. Strategy: create the new table, do NOT rename or drop the old one. Old table stays as an archive. New code uses the new table.

| Existing Table | New Schema Table | Action |
|---------------|-----------------|--------|
| `audit_log` | `audit_logs` | CREATE `audit_logs` (new schema). Keep `audit_log` for historical entries. New code writes to `audit_logs`. |
| `integrations` | `integration_connections` | CREATE `integration_connections`. Migrate active connection data from `integrations`. Keep `integrations` as archive. |
| `sync_dead_letters` | `dead_letter_queue` | CREATE `dead_letter_queue`. Keep `sync_dead_letters` for historical failed ops. New code uses `dead_letter_queue`. |
| `files` | `documents` | CREATE `documents` (new schema with expanded fields). Migrate file records from `files`. Keep `files` as archive. |
| `notes` | `smart_notes` | CREATE `smart_notes` (new schema with AI processing fields). Migrate existing notes. Keep `notes` as archive. |
| `leads` | `estimate_requests` | CREATE `estimate_requests` (completely new pipeline model). Keep `leads` for historical lead data. New leads go into `estimate_requests`. |
| `quotes` | Merged into `estimates` | No new table needed. `quotes` data is conceptually part of the estimate delivery flow. Keep `quotes` as archive. New quote flow uses `estimates` with portal_token. |

### Category C: ARCHIVE — Existing tables not needed in new schema but preserved

| Existing Table | Action |
|---------------|--------|
| `company_documents` | Keep as-is. New `documents` table with `context_type = 'company'` replaces this functionality. Migrate existing records to `documents` during Sprint 15. |
| `drive_mirror_folders` | Keep as-is. Mirror folder config may still be referenced by existing code. |
| `file_shares` | Keep as-is. New `documents` table has built-in `share_token` and `share_expiration`. |
| `file_tags` | Keep as-is. Future document search may reference tags. |
| `job_files` | Keep as-is. Junction table linking jobs to files. New `documents` table has `job_id` directly. |
| `kv_cache` | Keep as-is. May still be used by existing caching logic. |
| `sync_log` | Keep as-is. Historical sync records from Jobber era. |
| `ai_generations` | Keep as-is. Historical AI generation records. |
| `d1_migrations` | Keep as-is. System table tracking migrations. |

### Category D: CREATE NEW — Tables that don't exist yet

| New Table | Module | Notes |
|-----------|--------|-------|
| `properties` | Client | Client multi-property support |
| `communications` | Client | Unified communication timeline |
| `estimate_requests` | Estimating | Full pre-job pipeline |
| `estimate_line_items` | Estimating | New parent line items (client-facing) |
| `estimate_sub_items` | Estimating | Internal cost breakdown |
| `payment_schedules` | Estimating | Per-estimate payment milestones |
| `estimate_templates` | Estimating | Reusable estimate templates |
| `saved_reviews` | Estimating | Curated reviews for quote display |
| `tasks` | Job Mgmt | Per-job task tracking |
| `daily_logs` | Job Mgmt | Field daily reports |
| `change_orders` | Job Mgmt | Scope change management |
| `schedule_entries` | Job Mgmt | Day-by-day trade scheduling |
| `permits` | Job Mgmt | Permit and inspection tracking |
| `warranties` | Job Mgmt | Post-completion warranty claims |
| `time_entries` | Financial | Clock in/out labor tracking |
| `billing_cycles` | Financial | Cost-plus bi-weekly cycles |
| `mileage` | Financial | Tax-deductible mileage |
| `lien_waivers` | Financial | Sub lien waiver management |
| `vendor_materials` | Financial | Material/vendor price database |
| `receipt_photos` | Photo | AI-processed receipt extension |
| `document_templates` | Document | Merge-field templates |
| `notification_templates` | Notifications | Configurable notification catalog |
| `notification_logs` | Notifications | Delivery tracking |
| `social_posts` | Social | Content management |
| `content_schedules` | Social | Monthly content planning |
| `system_settings` | System | Key-value settings store |
| `audit_logs` | System | New audit log table (replaces audit_log) |
| `integration_connections` | System | New integrations table |
| `dead_letter_queue` | System | New DLQ table |
| `smart_notes` | Shared | New notes table with AI fields |
| `documents` | Document | New unified document table |

---

## Migration File Sequence (Revised)

Given the existing schema, the migration sequence changes from the original plan:

```
0012_schema_bridge.sql
  — ALTER existing tables (clients, jobs, estimates, expenses, invoices, payments, photos, subcontractors, users)
  — CREATE new system tables (system_settings, audit_logs, integration_connections, dead_letter_queue)

0013_client_tables.sql
  — CREATE properties
  — CREATE communications

0014_estimating_tables.sql
  — CREATE estimate_requests
  — CREATE estimate_line_items
  — CREATE estimate_sub_items
  — CREATE payment_schedules
  — CREATE estimate_templates
  — CREATE saved_reviews

0015_job_tables.sql
  — CREATE tasks
  — CREATE daily_logs
  — CREATE change_orders
  — CREATE schedule_entries
  — CREATE permits
  — CREATE warranties

0016_financial_tables.sql
  — CREATE time_entries
  — CREATE billing_cycles
  — CREATE mileage
  — CREATE lien_waivers
  — CREATE vendor_materials

0017_photo_tables.sql
  — CREATE receipt_photos
  — CREATE smart_notes
  — CREATE documents
  — CREATE document_templates

0018_notification_tables.sql
  — CREATE notification_templates
  — CREATE notification_logs

0019_social_tables.sql
  — CREATE social_posts
  — CREATE content_schedules

0020_indexes.sql
  — All indexes from Database Schema doc

0021_views.sql
  — All computed views (v_job_financials, v_client_summary, v_content_schedule_counts)

0022_seed_data.sql
  — system_settings defaults
  — notification_templates catalog
  — owner user record (if not already in users table)
  — saved_reviews placeholders
```

---

## Data Migration Notes

### Existing Jobber-imported data

The chs-hub already has client, job, invoice, payment, and expense data imported from Jobber. This data stays in the existing tables. The ALTER TABLE migrations add new columns with NULL defaults — existing rows are unaffected.

Going forward:
- New jobs are created through the Estimating pipeline (quote-to-job conversion), not directly.
- Existing Jobber jobs in the `jobs` table remain as historical records. They won't have `estimate_id`, `billing_model`, or `portal_token` populated — that's fine.
- New code should handle NULL gracefully for these legacy fields.

### Migrating active integration connections

After creating `integration_connections`, migrate active records from `integrations`:

```sql
INSERT INTO integration_connections (id, service, status, access_token, refresh_token, configuration, created_at, updated_at)
SELECT id, service, status, access_token, refresh_token, configuration, created_at, updated_at
FROM integrations
WHERE status = 'connected';
```

### Migrating existing notes

After creating `smart_notes`, migrate from `notes`:

```sql
INSERT INTO smart_notes (id, job_id, raw_content, ai_summary, ai_category, is_processed, entered_via, created_by, created_at)
SELECT id, job_id, content, ai_summary, ai_category, 
  CASE WHEN ai_summary IS NOT NULL THEN 1 ELSE 0 END,
  'web', created_by, created_at
FROM notes;
```

*Note: Column names in the SELECT depend on the actual `notes` table schema. Cursor should inspect with `PRAGMA table_info(notes)` first.*

### Migrating file records

After creating `documents`, migrate from `files`:

```sql
INSERT INTO documents (id, title, file_type, file_size, r2_key, r2_url, context_type, job_id, document_category, uploaded_by, created_at, updated_at, is_active)
SELECT id, title, mime_type, size, r2_key, r2_url,
  CASE WHEN job_id IS NOT NULL THEN 'job' ELSE 'company' END,
  job_id, 'other', uploaded_by, created_at, updated_at, 1
FROM files;
```

*Again: column names depend on actual `files` schema. Inspect first.*

---

## Column Inspection Template

Before writing any ALTER TABLE statement, Cursor should run:

```sql
-- Get current columns for a table
PRAGMA table_info(clients);
PRAGMA table_info(jobs);
PRAGMA table_info(estimates);
PRAGMA table_info(expenses);
PRAGMA table_info(invoices);
PRAGMA table_info(payments);
PRAGMA table_info(photos);
PRAGMA table_info(subcontractors);
PRAGMA table_info(users);
```

Then compare with the Database Schema doc and only ADD columns that are missing.

**SQLite ALTER TABLE ADD COLUMN pattern:**
```sql
-- SQLite allows only one column per ALTER statement
ALTER TABLE clients ADD COLUMN phone_secondary TEXT;
ALTER TABLE clients ADD COLUMN mailing_address TEXT;
ALTER TABLE clients ADD COLUMN mailing_city TEXT;
-- ... etc
```

**To avoid errors on re-run (idempotent pattern):**

SQLite doesn't have `IF NOT EXISTS` for ALTER TABLE ADD COLUMN. Use a try/catch approach in the migration runner, or check first:

```sql
-- Option 1: Just let it fail silently if column exists (depends on migration runner behavior)
-- Option 2: Check via PRAGMA before altering (requires programmatic migration)
```

For D1 migrations run via wrangler CLI, the simplest approach is to write each ALTER as a separate statement and accept that re-running a migration may produce "duplicate column" errors that can be ignored. Alternatively, wrap the migration in a Worker script that checks PRAGMA first.

---

## Jobber Sync Code Removal

During Phase 2 (after native invoicing, payments, and job creation are working):

1. Remove the Jobber GraphQL polling cron job.
2. Remove Jobber API credentials from integrations/secrets.
3. Remove Jobber-related sync code from the Worker.
4. Keep all Jobber-imported data in the existing tables — do not delete.
5. Add a `data_source` column to `jobs` (and other tables if needed) to distinguish `'jobber_import'` from `'native'` records.

This should happen in Sprint 13 or later, after the new system is fully handling all job creation and financial operations.
