# Sprint 1: Schema & Auth Foundation
## Cursor Prompt — CHS Construction Management Platform

---

## Context

You are working on the chs-hub codebase — an existing Cloudflare Workers application for Columbus Home Solutions, a residential general contractor. The app currently syncs data from Jobber, manages photos, processes Smart Notes via Claude AI, syncs to a WC Spreadsheet via Google Sheets API, and integrates with High Level CRM.

We are evolving this into a complete construction management platform that replaces Jobber, CompanyCam, and Metricool. The existing codebase and data must remain fully functional throughout this process. Nothing should break.

---

## Step 0: Explore the Existing Codebase

Before writing ANY new code, read and understand the current codebase:

1. **Read `wrangler.toml`** — understand the D1 binding name, R2 binding, Workers route, and any environment variables.

2. **Read the main Worker entry file** (likely `src/worker.ts` or `src/index.ts`) — understand how routes are dispatched, how auth is handled, and how the request/response flow works.

3. **List the `src/` directory structure** — understand how routes, utilities, and services are organized.

4. **Read the existing `migrations/` folder** — understand the current migration numbering and what the highest migration number is.

5. **Run against the local D1:**
   ```sql
   PRAGMA table_info(clients);
   PRAGMA table_info(jobs);
   PRAGMA table_info(estimates);
   PRAGMA table_info(expenses);
   PRAGMA table_info(invoices);
   PRAGMA table_info(payments);
   PRAGMA table_info(photos);
   PRAGMA table_info(subcontractors);
   PRAGMA table_info(users);
   PRAGMA table_info(notes);
   PRAGMA table_info(files);
   PRAGMA table_info(integrations);
   PRAGMA table_info(audit_log);
   PRAGMA table_info(leads);
   PRAGMA table_info(sync_dead_letters);
   ```
   This shows the current columns on every table we need to ALTER. Save this output — you'll need it for Step 2.

6. **Do NOT modify any existing files in Step 0.** Just read and understand.

---

## Step 1: Pre-Migration Backup

Before any schema changes, export the current database:

```bash
npx wrangler d1 export chs-hub-db --remote --output=backup_pre_sprint1.sql
```

Verify the backup file is non-empty and readable.

---

## Step 2: Schema Bridge Migration (0012_schema_bridge.sql)

Reference documents:
- **CHS-Database-Schema.md** — the target schema for all 40 tables
- **CHS-Schema-Bridge.md** — maps existing tables to new schema (ALTER vs CREATE)

Create `migrations/0012_schema_bridge.sql`.

This migration does TWO things:

### Part A: ALTER existing tables to add missing columns

Compare the PRAGMA output from Step 0 against the Database Schema doc. For each existing table, add only the columns that don't already exist.

**Tables to ALTER:** clients, jobs, estimates, expenses, invoices, payments, photos, subcontractors, users

Example pattern (adjust based on actual PRAGMA output — only add columns that are missing):

```sql
-- clients: add missing columns from Database Schema doc
ALTER TABLE clients ADD COLUMN phone_secondary TEXT;
ALTER TABLE clients ADD COLUMN mailing_address TEXT;
ALTER TABLE clients ADD COLUMN mailing_city TEXT;
ALTER TABLE clients ADD COLUMN mailing_state TEXT;
ALTER TABLE clients ADD COLUMN mailing_zip TEXT;
ALTER TABLE clients ADD COLUMN high_level_contact_id TEXT;
ALTER TABLE clients ADD COLUMN is_repeat_client INTEGER DEFAULT 0;
ALTER TABLE clients ADD COLUMN review_requested INTEGER DEFAULT 0;
ALTER TABLE clients ADD COLUMN google_review_left INTEGER DEFAULT 0;
ALTER TABLE clients ADD COLUMN last_interaction_date TEXT;
-- ... add any other columns from Database Schema that don't exist yet

-- jobs: add missing columns
ALTER TABLE jobs ADD COLUMN billing_model TEXT;
ALTER TABLE jobs ADD COLUMN property_city TEXT;
ALTER TABLE jobs ADD COLUMN property_state TEXT DEFAULT 'Arkansas';
ALTER TABLE jobs ADD COLUMN property_zip TEXT;
ALTER TABLE jobs ADD COLUMN job_type TEXT;
ALTER TABLE jobs ADD COLUMN lead_source TEXT;
ALTER TABLE jobs ADD COLUMN estimate_id TEXT;
ALTER TABLE jobs ADD COLUMN target_end_date TEXT;
ALTER TABLE jobs ADD COLUMN actual_end_date TEXT;
ALTER TABLE jobs ADD COLUMN contract_total REAL;
ALTER TABLE jobs ADD COLUMN deposit_amount REAL;
ALTER TABLE jobs ADD COLUMN deposit_paid INTEGER DEFAULT 0;
ALTER TABLE jobs ADD COLUMN portal_token TEXT;
ALTER TABLE jobs ADD COLUMN portal_type TEXT;
ALTER TABLE jobs ADD COLUMN warranty_expiration TEXT;
-- ... check PRAGMA and add what's missing

-- Repeat for: estimates, expenses, invoices, payments, photos, subcontractors, users
-- ONLY add columns that don't already exist based on PRAGMA output
```

**Important:** SQLite will error if a column already exists. Each ALTER statement should be on its own line. If this migration is run via wrangler CLI and a column already exists, that individual ALTER will fail but the rest of the file may not execute. To handle this safely, consider:
- Splitting into one ALTER per migration file (tedious but safe), OR
- Writing a small Worker script that runs ALTERs with try/catch, OR
- Carefully checking PRAGMA output and only including truly missing columns

The recommended approach: **check PRAGMA output carefully and only write ALTER statements for columns that are genuinely missing.** This makes the migration safe to run once.

### Part B: CREATE new system tables

```sql
-- system_settings (key-value store for all configurable settings)
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK(value_type IN ('string','number','boolean','json')),
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

-- audit_logs (new table — existing audit_log is preserved for historical data)
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- integration_connections (new table — existing integrations is preserved)
CREATE TABLE IF NOT EXISTS integration_connections (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL CHECK(service IN ('stripe','quickbooks','twilio','high_level','google_drive','facebook','instagram','replicate')),
  status TEXT NOT NULL CHECK(status IN ('connected','disconnected','error','pending')),
  access_token TEXT,
  refresh_token TEXT,
  token_expiry TEXT,
  account_id TEXT,
  configuration TEXT,
  last_sync TEXT,
  last_error TEXT,
  connected_at TEXT,
  connected_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- dead_letter_queue (new table — existing sync_dead_letters preserved)
CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  payload TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL CHECK(status IN ('pending','retrying','resolved','dismissed')),
  next_retry_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
```

---

## Step 3: Remaining Schema Migrations (0013-0019)

Create each migration file per the sequence in the Database Schema doc. All use `CREATE TABLE IF NOT EXISTS`.

**0013_client_tables.sql** — properties, communications

**0014_estimating_tables.sql** — estimate_requests, estimate_line_items, estimate_sub_items, payment_schedules, estimate_templates, saved_reviews

**0015_job_tables.sql** — tasks, daily_logs, change_orders, schedule_entries, permits, warranties

**0016_financial_tables.sql** — time_entries, billing_cycles, mileage, lien_waivers, vendor_materials

**0017_photo_document_tables.sql** — receipt_photos, smart_notes, documents, document_templates

**0018_notification_tables.sql** — notification_templates, notification_logs

**0019_social_tables.sql** — social_posts, content_schedules

Use the exact column definitions from the Database Schema doc (CHS-Database-Schema.md). Every column, type, constraint, and foreign key reference should match.

---

## Step 4: Indexes (0020_indexes.sql)

Create all indexes from Section 11 of the Database Schema doc. Use `CREATE INDEX IF NOT EXISTS` for idempotency.

---

## Step 5: Views (0021_views.sql)

Create the 3 computed views from Section 12 of the Database Schema doc:
- `v_job_financials`
- `v_client_summary`
- `v_content_schedule_counts`

Use `CREATE VIEW IF NOT EXISTS`.

---

## Step 6: Seed Data (0022_seed_data.sql)

Reference: **CHS-Seed-Data.md**

### 6a: System Settings

Insert all financial settings and company settings from the Seed Data doc using `INSERT OR IGNORE` (so re-running doesn't duplicate):

```sql
INSERT OR IGNORE INTO system_settings (key, value, value_type, category, label, description, updated_at)
VALUES
  ('labor_rate_general', '90.00', 'number', 'financial', 'General Labor Rate ($/hr)', 'Hourly rate for general labor', datetime('now')),
  ('labor_rate_pm_skilled', '105.00', 'number', 'financial', 'PM / Skilled Carpenter Rate ($/hr)', 'Hourly rate for PM or skilled carpenter work', datetime('now')),
  -- ... all settings from Seed Data doc
;
```

### 6b: Owner User Record

Check if Tony's user record already exists in the `users` table. If it does, ALTER it to add the `role` column value. If it doesn't exist, INSERT it.

```sql
-- If users table already has Tony's record, update it to add role
UPDATE users SET role = 'owner', is_active = 1 WHERE email = 'tony@homesolutionsar.com';

-- If no record exists, insert
INSERT OR IGNORE INTO users (id, email, first_name, last_name, phone, role, is_active, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'tony@homesolutionsar.com', 'Tony', 'Whitaker', '5015511814', 'owner', 1, datetime('now'), datetime('now'));
```

### 6c: Notification Templates

Insert all notification templates from the Seed Data doc. These define the full notification catalog.

### 6d: Saved Reviews

Insert the 3 placeholder reviews from the Seed Data doc (these will be replaced with real Google reviews before go-live).

---

## Step 7: Run Migrations

Run each migration one at a time against the LOCAL D1 first:

```bash
npx wrangler d1 execute chs-hub-db --local --file=migrations/0012_schema_bridge.sql
npx wrangler d1 execute chs-hub-db --local --file=migrations/0013_client_tables.sql
# ... through 0022
```

Verify after each:
```bash
npx wrangler d1 execute chs-hub-db --local --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Once all pass locally, run against REMOTE:
```bash
npx wrangler d1 execute chs-hub-db --remote --file=migrations/0012_schema_bridge.sql
# ... through 0022, one at a time, verifying after each
```

---

## Step 8: Auth Middleware

Create `src/middleware/auth.ts`:

```typescript
import { Env } from '../types';

export interface AuthenticatedUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: 'owner' | 'project_manager' | 'field_crew' | 'office_admin';
  is_active: number;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

export async function authenticateRequest(request: Request, env: Env): Promise<AuthenticatedRequest> {
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');

  if (!email) {
    throw new Error('UNAUTHORIZED: No authenticated user email in request headers');
  }

  const user = await env.DB.prepare(
    'SELECT id, email, first_name, last_name, role, is_active FROM users WHERE email = ? AND is_active = 1'
  ).bind(email).first<AuthenticatedUser>();

  if (!user) {
    throw new Error('UNAUTHORIZED: User not found or inactive');
  }

  const authedRequest = request as AuthenticatedRequest;
  authedRequest.user = user;
  return authedRequest;
}
```

Create `src/middleware/roles.ts`:

```typescript
import { AuthenticatedRequest } from './auth';

export function requireRole(request: AuthenticatedRequest, allowedRoles: string[]): void {
  if (!allowedRoles.includes(request.user.role)) {
    throw new Error('FORBIDDEN: Insufficient permissions');
  }
}
```

---

## Step 9: Settings API

Create `src/routes/settings.ts`:

```typescript
// GET /api/settings — returns all system settings
// GET /api/settings/:key — returns a single setting
// PUT /api/settings/:key — updates a setting (owner only)
```

This is the first new API route. Wire it into the main Worker route dispatcher (the existing `worker.ts` or `index.ts`).

**Important:** Integrate with the EXISTING route dispatching pattern. Read how the current Worker handles routes and follow the same pattern. Do not create a separate routing system — add to the existing one.

---

## Step 10: Health Check Endpoint

Add a simple health check to verify everything works:

```typescript
// GET /api/health/heartbeat
// Returns: { status: "ok", timestamp: "...", tables: 40, settings: N }
// Checks: D1 connectivity, table count, settings count
```

---

## Step 11: Verify Nothing is Broken

After all changes are deployed:

1. Confirm the existing chs-hub dashboard still loads and functions.
2. Confirm Smart Notes still processes notes via Claude.
3. Confirm the HL pipeline Kanban still works.
4. Confirm the WC Spreadsheet sync still fires on schedule.
5. Confirm photo capture (CHS Capture PWA) still works.
6. Confirm the nightly backup cron still runs.

**If anything breaks, it's a Sprint 1 bug — fix it before moving on.**

---

## Done Criteria

Sprint 1 is complete when:

- [ ] All 40 tables exist in both local and remote D1
- [ ] All indexes are created
- [ ] All 3 views are created
- [ ] system_settings is populated with all default values
- [ ] notification_templates is populated with the full catalog
- [ ] Tony's user record has `role = 'owner'`
- [ ] Auth middleware resolves email → user with role on every request
- [ ] `GET /api/settings` returns all settings
- [ ] `PUT /api/settings/:key` updates a setting (owner only)
- [ ] `GET /api/health/heartbeat` returns OK with table count
- [ ] ALL existing chs-hub functionality still works (dashboard, Smart Notes, HL, WC sync, photos, backup)
- [ ] Pre-migration backup stored safely

---

## Reference Documents

These documents are in the project knowledge. Read them before writing code:

1. **cursorrules.md** — coding conventions, patterns, naming, architecture
2. **CHS-Database-Schema.md** — all 40 table definitions with columns, types, constraints
3. **CHS-Schema-Bridge.md** — maps existing 26 tables to new schema (ALTER vs CREATE)
4. **CHS-Seed-Data.md** — system settings values, notification templates, estimate templates, reviews
5. **CHS-API-Route-Map.md** — all 173 API endpoints (Sprint 1 only implements settings + health)
6. **CHS-Build-Order-Plan.md** — overall sprint plan (you are in Sprint 1)
7. **CHS-Design-System.md** — CSS tokens and component specs (not needed for Sprint 1 — backend only)
