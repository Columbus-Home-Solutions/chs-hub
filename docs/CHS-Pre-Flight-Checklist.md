# Pre-Flight Checklist & Backup Plan
## CHS Construction Management Platform
### Version 1.0 — May 28, 2026

---

## 1. External Service Setup Checklist

Each service needs to be set up before the sprint that depends on it. Do these ahead of time so Cursor is never blocked waiting on an account.

### Before Sprint 1 (Schema & Auth)

- [ ] **Confirm chs-hub D1 database name** — run `npx wrangler d1 list` to get the exact database name and ID
- [ ] **Export existing schema** — run `SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name;` against the live D1 and share the output so migrations can be written correctly (ALTER vs CREATE)
- [ ] **Verify Cloudflare Access** is still configured and working for the app domain
- [ ] **Verify wrangler.toml** has correct D1 binding, R2 binding, and Workers route

### Before Sprint 5 (Quote Delivery & Stripe)

- [ ] **Stripe account** — sign up at stripe.com if not already done
  - [ ] Get **test mode** API keys (publishable + secret)
  - [ ] Set up a **webhook endpoint** (can use Stripe CLI for local testing initially)
  - [ ] Note: Do NOT switch to live mode until full lifecycle testing is complete
  - [ ] Stripe charges: 2.9% + $0.30 per CC transaction, 1% for ACH

### Before Sprint 7 (Notifications & SMS)

- [ ] **Twilio account** — sign up at twilio.com
  - [ ] Purchase a **local phone number** (501 area code if available, or 870)
  - [ ] Get Account SID and Auth Token
  - [ ] Configure webhook URL for inbound SMS
  - [ ] Test mode available — use Twilio test credentials first
  - [ ] Estimated cost: ~$1/month for number + ~$0.0079/message

- [ ] **Resend account** — likely already set up from chs-hub
  - [ ] Verify sending domain (homesolutionsar.com) has DNS records configured
  - [ ] Verify API key is in Workers environment variables
  - [ ] Test send to confirm deliverability

### Before Sprint 14 (QuickBooks)

- [ ] **QuickBooks Online account** — should already exist for CHS
  - [ ] Register as a **QBO developer** at developer.intuit.com
  - [ ] Create an **app** to get OAuth client ID and client secret
  - [ ] Set redirect URI to your Workers callback URL
  - [ ] Use QBO sandbox for testing before connecting production
  - [ ] Map your CHS expense categories to QBO chart of accounts categories

### Before Sprint 16 (Social Media)

- [ ] **Facebook Developer account**
  - [ ] Create app at developers.facebook.com
  - [ ] Request **Page publishing** permissions
  - [ ] Connect your Columbus Home Solutions Facebook Page
  - [ ] Get long-lived Page Access Token

- [ ] **Instagram Business account**
  - [ ] Ensure CHS Instagram is a **Business account** (not Personal or Creator)
  - [ ] Connect to the Facebook Page (required for API access)
  - [ ] Instagram posting goes through the Facebook Graph API

- [ ] **Replicate account** (for AI image generation)
  - [ ] Sign up at replicate.com
  - [ ] Get API token
  - [ ] Test with Flux Pro model
  - [ ] Budget: ~$0.05-0.10 per generated image

### Already Available (from chs-hub)

- [x] **Cloudflare Workers** — deployed and running
- [x] **Cloudflare D1** — database exists
- [x] **Cloudflare R2** — bucket exists
- [x] **Cloudflare Access** — auth configured
- [x] **Claude API (Anthropic)** — key exists for Smart Notes
- [x] **Google Drive service account** — configured for file mirroring
- [x] **Google Sheets API** — configured for WC Spreadsheet sync
- [x] **High Level API** — PIT proxy pattern working
- [x] **Resend** — email sending configured

---

## 2. DNS & Domain Setup

### Required DNS Records

| Record | Type | Name | Value | Notes |
|--------|------|------|-------|-------|
| CNAME | CNAME | app | workers-route | Points to Workers — Cloudflare proxied |

The `app.homesolutionsar.com` subdomain routes all traffic through the Worker. All routing (API, portal, estimates, shared docs) is path-based within the Worker.

### Workers Route Configuration

In `wrangler.toml`:
```toml
route = { pattern = "app.homesolutionsar.com/*", zone_name = "homesolutionsar.com" }
```

Or if using a custom domain on Workers:
```toml
[env.production]
routes = [
  { pattern = "app.homesolutionsar.com/*", zone_name = "homesolutionsar.com" }
]
```

---

## 3. Environment Variables / Secrets

Store these as **Cloudflare Workers secrets** (not in code, not in wrangler.toml):

```bash
# Stripe
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put STRIPE_PUBLISHABLE_KEY

# Twilio
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_PHONE_NUMBER

# QuickBooks
npx wrangler secret put QBO_CLIENT_ID
npx wrangler secret put QBO_CLIENT_SECRET

# Claude (Anthropic)
npx wrangler secret put ANTHROPIC_API_KEY

# Resend
npx wrangler secret put RESEND_API_KEY

# High Level
npx wrangler secret put HIGH_LEVEL_API_KEY

# Google (service account JSON stored as single secret)
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY

# Facebook
npx wrangler secret put FACEBOOK_PAGE_ACCESS_TOKEN

# Replicate
npx wrangler secret put REPLICATE_API_TOKEN
```

---

## 4. Backup & Rollback Strategy

### Pre-Migration Backup (Before Sprint 1)

Before running any new migrations against the live D1:

```bash
# Step 1: Export current database as SQL dump
npx wrangler d1 export <db-name> --remote --output=backup_pre_migration_$(date +%Y%m%d).sql

# Step 2: Store backup in R2
npx wrangler r2 object put chs-backups/pre_migration_$(date +%Y%m%d).sql --file=backup_pre_migration_$(date +%Y%m%d).sql

# Step 3: Verify backup is readable
head -50 backup_pre_migration_$(date +%Y%m%d).sql
```

### Migration Execution Strategy

Run migrations one at a time, not in batch. This way if one fails, you know exactly which one and can fix it without rolling back everything.

```bash
# Run each migration individually
npx wrangler d1 execute <db-name> --remote --file=migrations/0012_core_schema.sql
# Verify: check table exists
npx wrangler d1 execute <db-name> --remote --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"

npx wrangler d1 execute <db-name> --remote --file=migrations/0013_estimating_schema.sql
# Verify again...

# Continue through 0022
```

### Rollback Approach

SQLite (D1) has limited ALTER TABLE support — you can't DROP COLUMN. So rollback means:

**For new tables (most of the migration):**
```sql
-- Rollback is straightforward: drop the table
DROP TABLE IF EXISTS estimate_requests;
DROP TABLE IF EXISTS estimates;
-- etc.
```

**For altered existing tables (adding columns to existing tables):**
```sql
-- SQLite can't drop columns, so you'd need to:
-- 1. Create a new table without the added columns
-- 2. Copy data from the old table
-- 3. Drop the old table
-- 4. Rename the new table
-- This is destructive — avoid unless absolutely necessary
```

**Practical rollback strategy:** Since all migrations are additive (new tables, new columns), a failed migration doesn't break existing functionality. The old code still works with the old schema. New code won't work until the migration succeeds, but nothing is lost.

**Nuclear option (restore from backup):**
```bash
# If something goes catastrophically wrong:
# 1. Drop the D1 database
npx wrangler d1 delete <db-name>

# 2. Recreate it
npx wrangler d1 create <db-name>

# 3. Import the backup
npx wrangler d1 execute <db-name> --remote --file=backup_pre_migration_YYYYMMDD.sql

# 4. Update wrangler.toml with new database ID
```

### Ongoing Backup (Carry Forward)

The chs-hub reliability subsystem already runs nightly D1→R2 backups. This continues unchanged. The backup Worker:

1. Runs on a cron schedule (nightly at midnight CT).
2. Exports D1 to SQL.
3. Stores in R2 with date-stamped key: `backups/nightly/YYYY-MM-DD.sql`.
4. Retains 30 days of backups.
5. Alerts if backup fails (two consecutive failures trigger SMS/email alert to owner).

### Per-Sprint Backup Habit

Before each sprint that modifies the schema or runs data migrations:

1. Run a manual backup: `npx wrangler d1 export <db-name> --remote --output=backup_sprint_N.sql`
2. Store in R2.
3. Run the sprint's migrations.
4. Verify data integrity.
5. If anything breaks, restore from the sprint backup.

---

## 5. Local Development Setup

For Cursor to work effectively on the chs-hub codebase:

```bash
# Clone the repo (if not already local)
git clone <repo-url>
cd chs-hub

# Install dependencies
npm install

# Set up local D1 for development
npx wrangler d1 execute <db-name> --local --file=migrations/0012_core_schema.sql
# ... (run all migrations locally)

# Start local dev server
npx wrangler dev

# Local dev server runs at http://localhost:8787
# Cloudflare Access is bypassed in local dev
# D1 uses a local SQLite file
# R2 uses local file storage
```

### Wrangler.toml Bindings Reference

Make sure these bindings exist:

```toml
[[d1_databases]]
binding = "DB"
database_name = "<your-db-name>"
database_id = "<your-db-id>"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "<your-bucket-name>"

[vars]
ENVIRONMENT = "production"    # or "development"
```

---

## 6. Go-Live Readiness Checklist (End of Each Phase)

### End of Phase 1 (Sprint 8 Complete)

- [ ] All core tables populated and functional
- [ ] Clients, estimates, jobs CRUD working
- [ ] Quote-to-job conversion tested end-to-end
- [ ] Photo capture (online + offline) tested on iPhone
- [ ] Smart Notes processing working
- [ ] HL pipeline integration still working
- [ ] WC Spreadsheet sync still working
- [ ] All notifications firing correctly
- [ ] Existing chs-hub functionality not broken

### End of Phase 2 (Sprint 13 Complete)

- [ ] Full billing lifecycle tested for all 3 models
- [ ] Stripe payments processing in live mode
- [ ] Convenience fee calculating correctly
- [ ] Late fees accruing correctly
- [ ] Client portal tested on multiple phones
- [ ] Cost-plus billing cycle reconciliation tested
- [ ] Change orders with digital signature tested
- [ ] Job completion package generating correctly
- [ ] Disable or remove Jobber sync code

### End of Phase 3 (Sprint 18 Complete)

- [ ] QuickBooks sync verified with accountant
- [ ] Social media posting to real Facebook/Instagram
- [ ] App Store submission accepted
- [ ] Push notifications working on both iOS and Android
- [ ] Role-based access tested (add a test PM user)
- [ ] Full lifecycle test: lead → estimate → job → invoice → payment → completion → social post
- [ ] Performance acceptable on 3G connection (field conditions)
- [ ] Cancel Jobber subscription
- [ ] Cancel CompanyCam subscription
- [ ] Cancel Metricool subscription
