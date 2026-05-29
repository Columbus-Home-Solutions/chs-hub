# CHS Platform — Sprint 2 Remote Deploy Runbook
## Execute this BEFORE starting Sprint 3

This document walks through every command for the Sprint 2 remote step, in exact order.
Do not skip steps. Do not batch commands. Verify each step before moving to the next.

---

## Prerequisites

- [ ] Sprint 2 local smoke test passed (client list loads, "Tony Columbus" top-right, no wrangler reload churn)
- [ ] Sprint 2 committed locally as `cb28302`, tagged `v0.2.0-sprint2`
- [ ] You are in the `chs-hub` project directory
- [ ] `npx wrangler whoami` shows you are logged into the correct Cloudflare account

Confirm your working directory and login:
```bash
pwd
# Should show: /Users/tonycolumbus/...chs-hub (or wherever your repo lives)

npx wrangler whoami
# Should show your Cloudflare account name
```

---

## Step 1 — Backup Remote Database

**Do not skip this.** Takes 30 seconds. Saves you from disaster.

```bash
npx wrangler d1 export chs-hub-db --remote --output=backup_pre_sprint2_remote_$(date +%Y%m%d).sql
```

Verify the backup is non-empty:
```bash
wc -l backup_pre_sprint2_remote_*.sql
# Should show a number > 0 (likely hundreds or thousands of lines)

head -20 backup_pre_sprint2_remote_*.sql
# Should show SQL statements — CREATE TABLE, INSERT, etc.
```

Store the backup in R2 for safekeeping:
```bash
npx wrangler r2 object put chs-backups/backup_pre_sprint2_remote_$(date +%Y%m%d).sql \
  --file=backup_pre_sprint2_remote_$(date +%Y%m%d).sql
```

---

## Step 2 — Dry Run the 0025 Backfill

Before running the backfill for real, check what it will actually do to your 80 real clients.
This is read-only — it does not change anything.

```bash
# How many clients will be affected by the name split?
npx wrangler d1 execute chs-hub-db --remote --command="
  SELECT COUNT(*) as total_clients,
    SUM(CASE WHEN first_name IS NULL OR first_name = '' THEN 1 ELSE 0 END) as needs_name_split,
    SUM(CASE WHEN is_repeat_client IS NULL THEN 1 ELSE 0 END) as needs_repeat_flag
  FROM clients;
"

# Preview what the name split will look like on the first 10 clients
npx wrangler d1 execute chs-hub-db --remote --command="
  SELECT id,
    COALESCE(first_name, '') as current_first_name,
    COALESCE(last_name, '') as current_last_name,
    TRIM(SUBSTR(full_name, 1, INSTR(full_name || ' ', ' ') - 1)) as would_become_first,
    TRIM(SUBSTR(full_name, INSTR(full_name || ' ', ' ') + 1)) as would_become_last
  FROM clients
  WHERE (first_name IS NULL OR first_name = '')
    AND full_name IS NOT NULL
    AND full_name != ''
  LIMIT 10;
"

# How many clients would be flagged as repeat clients?
npx wrangler d1 execute chs-hub-db --remote --command="
  SELECT COUNT(*) as potential_repeat_clients
  FROM clients c1
  WHERE EXISTS (
    SELECT 1 FROM clients c2
    WHERE c2.id != c1.id
      AND (c2.phone = c1.phone OR c2.email = c1.email)
      AND c2.phone IS NOT NULL
      AND c2.phone != ''
  );
"
```

**Review the output before continuing.** If anything looks wrong — unexpected row counts, names splitting badly, etc. — stop and investigate before running the actual migration.

---

## Step 3 — Run the Remote Backfill Migration

Once the dry run looks correct, run the migration:

```bash
npx wrangler d1 execute chs-hub-db --remote --file=migrations/0025_client_data_backfill.sql
```

Verify it ran correctly:
```bash
# Check that name fields are now populated
npx wrangler d1 execute chs-hub-db --remote --command="
  SELECT COUNT(*) as clients_with_first_name
  FROM clients
  WHERE first_name IS NOT NULL AND first_name != '';
"

# Spot-check a few records
npx wrangler d1 execute chs-hub-db --remote --command="
  SELECT id, full_name, first_name, last_name, is_repeat_client
  FROM clients
  LIMIT 5;
"
```

---

## Step 4 — Fix Remote Owner Name

Update "Tony Whitaker" to "Tony Columbus" on the remote database:

```bash
# First, confirm what the current owner record looks like
npx wrangler d1 execute chs-hub-db --remote --command="
  SELECT id, email, first_name, last_name, role
  FROM users
  WHERE role = 'owner';
"

# Run the update
npx wrangler d1 execute chs-hub-db --remote --command="
  UPDATE users
  SET first_name = 'Tony', last_name = 'Columbus'
  WHERE role = 'owner' AND last_name = 'Whitaker';
"

# Verify the change
npx wrangler d1 execute chs-hub-db --remote --command="
  SELECT id, email, first_name, last_name, role
  FROM users
  WHERE role = 'owner';
"
# Should show: Tony | Columbus | owner
```

---

## Step 5 — Push to GitHub

Push the Sprint 2 commit and tag to remote before deploying:

```bash
git push origin main
git push origin v0.2.0-sprint2
```

Verify on GitHub that:
- The `main` branch shows commit `cb28302` at the top
- The tag `v0.2.0-sprint2` appears in the Tags list

---

## Step 6 — Deploy to Cloudflare Workers

```bash
npx wrangler deploy
```

You should see output like:
```
Total Upload: XX.XX KiB / gzip: XX.XX KiB
Worker ID: chs-hub
Worker ETag: xxxxxxxx
```

Note the new Worker ID/version hash shown in the output.

---

## Step 7 — Verify Production

Run each verification check and confirm all pass before marking done.

```bash
# 1. Health check — confirm Worker is live
curl https://app.homesolutionsar.com/api/health/heartbeat
# Expected: {"status":"ok","timestamp":"...","tables":40,"settings":N}

# 2. Confirm /api/me returns Tony Columbus
curl https://app.homesolutionsar.com/api/me
# Expected: {"id":"...","email":"...","first_name":"Tony","last_name":"Columbus","role":"owner"}

# 3. Confirm clients API is live
curl https://app.homesolutionsar.com/api/clients
# Expected: JSON array of clients (your real Jobber-imported data)

# 4. Confirm subcontractors API is live
curl https://app.homesolutionsar.com/api/subcontractors
# Expected: JSON array of subs
```

Also check in the browser:
- [ ] `https://dashboard.homesolutionsar.com` — existing dashboard still loads
- [ ] `https://app.homesolutionsar.com/app/` — new Preact app loads, shows client list
- [ ] "Tony Columbus" shows in the top-right corner of the new app
- [ ] No console errors in browser DevTools

---

## Step 8 — Tag the Remote Deploy

After verifying production is healthy, tag the remote deployment state:

```bash
git tag v0.2.0-sprint2-deployed
git push origin v0.2.0-sprint2-deployed
```

This gives you a clear marker of what is currently live in production.

---

## If Something Goes Wrong

### Worker deploy fails
```bash
# Check wrangler error output — usually a TypeScript error or missing binding
# Fix locally, then re-run: npx wrangler deploy
```

### Migration fails midway
```bash
# Check the error message. D1 migrations are additive — a partial run
# won't break existing functionality. Fix the SQL and re-run the file.
# The IF NOT EXISTS / duplicate column errors can be ignored if the
# table/column already exists.
```

### Production is broken after deploy — nuclear rollback
```bash
# Restore from the backup you made in Step 1
npx wrangler d1 delete chs-hub-db
npx wrangler d1 create chs-hub-db
npx wrangler d1 execute chs-hub-db --remote \
  --file=backup_pre_sprint2_remote_YYYYMMDD.sql

# Then redeploy the previous version
git checkout v0.1.0-sprint1
npx wrangler deploy
git checkout main
```

---

## Done Criteria

- [ ] Remote backup stored (local file + R2)
- [ ] Dry run reviewed and approved
- [ ] `0025_client_data_backfill.sql` ran on remote — name fields populated
- [ ] Owner name updated to "Tony Columbus" on remote
- [ ] Commit `cb28302` pushed to GitHub `main`
- [ ] Tag `v0.2.0-sprint2` pushed to GitHub
- [ ] `npx wrangler deploy` completed without errors
- [ ] `/api/health/heartbeat` returns OK on production
- [ ] `/api/me` returns Tony Columbus on production
- [ ] `/api/clients` returns real client data on production
- [ ] Existing dashboard at `dashboard.homesolutionsar.com` still works
- [ ] New app at `app.homesolutionsar.com/app/` loads and shows client list
- [ ] `v0.2.0-sprint2-deployed` tag pushed

**Once all boxes are checked → hand Sprint 3 prompt to Cursor.**
