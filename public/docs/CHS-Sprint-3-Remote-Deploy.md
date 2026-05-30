# CHS Platform — Sprint 3 Remote Deploy Runbook
## Execute this BEFORE starting Sprint 4

Sprint 3 is simpler than Sprint 2's deploy: the code is already committed and pushed to
GitHub, and `0026_estimate_requests.sql` is an idempotent no-op (the table already exists
from `0016_estimating_tables.sql`). No data backfill, no owner-name fix this time.

Do not skip steps. Verify each before moving on.

---

## Prerequisites

- [ ] Sprint 3 committed as `475bc90`, tagged `v0.3.0-sprint3`, pushed to GitHub
- [ ] Sprint 3 verified locally (pipeline board loads, all done-criteria green)
- [ ] You are in the `chs-hub` project directory
- [ ] `npx wrangler whoami` shows the correct Cloudflare account

```bash
pwd
# Should show your chs-hub repo path

npx wrangler whoami
# Should show your Cloudflare account

git status
# Should show: working tree clean, up to date with origin/main
```

---

## Step 1 — Backup Remote Database

Always backup before any remote migration, even a no-op. Takes 30 seconds.

```bash
npx wrangler d1 export chs-hub-db --remote --output=backup_pre_sprint3_remote_$(date +%Y%m%d).sql
```

Verify it's non-empty:
```bash
wc -l backup_pre_sprint3_remote_*.sql
head -20 backup_pre_sprint3_remote_*.sql
```

Store in R2:
```bash
npx wrangler r2 object put chs-backups/backup_pre_sprint3_remote_$(date +%Y%m%d).sql \
  --file=backup_pre_sprint3_remote_$(date +%Y%m%d).sql
```

(The `backup_pre_sprint*_remote_*.sql` gitignore pattern from the Sprint 2 step already
covers this file — confirm with `git status` that it's not showing as untracked.)

---

## Step 2 — Confirm the Migration Is a No-Op on Remote

Check whether `estimate_requests` already exists on the remote DB (it should, from `0016`):

```bash
npx wrangler d1 execute chs-hub-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name='estimate_requests';"
```

- **If it returns `estimate_requests`** → the table exists. Running `0026` is a safe no-op
  (it's `CREATE TABLE IF NOT EXISTS`). Proceed to Step 3 to run it anyway for record-keeping.
- **If it returns nothing** → the table is missing on remote. `0026` will create it. Proceed
  to Step 3 — this is exactly what the migration is for.

Either way, confirm the columns match what the code expects:
```bash
npx wrangler d1 execute chs-hub-db --remote --command="PRAGMA table_info(estimate_requests);"
```

---

## Step 3 — Run the Migration on Remote

```bash
npx wrangler d1 execute chs-hub-db --remote --file=migrations/0026_estimate_requests.sql
```

Verify the table exists with the right shape afterward:
```bash
npx wrangler d1 execute chs-hub-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name='estimate_requests';"

npx wrangler d1 execute chs-hub-db --remote --command="SELECT COUNT(*) as request_count FROM estimate_requests;"
# Real data count — likely 0 if this is the first native estimating use on prod.
# The local seed data does NOT go to remote.
```

**Do NOT run `dev-seed-sprint3.local.sql` against remote.** That's local fixture data only.

---

## Step 4 — Deploy the Worker

The Sprint 3 commit is already on GitHub `main`, so no push needed. Just deploy the code:

```bash
npx wrangler deploy
```

Watch the output for the new Worker version hash. Note it.

---

## Step 5 — Verify Production

```bash
# 1. Health check
curl https://app.homesolutionsar.com/api/health/heartbeat
# Expected: {"status":"ok",...}

# 2. New pipeline endpoint responds (grouped by status, all 8 keys even if empty)
curl https://app.homesolutionsar.com/api/estimate-requests/pipeline
# Expected: JSON with status-keyed groups; empty arrays are fine on a fresh prod table

# 3. List endpoint responds
curl https://app.homesolutionsar.com/api/estimate-requests
# Expected: JSON array (likely empty on prod — no real requests yet)

# 4. Confirm Sprint 2 endpoints still work (regression check)
curl https://app.homesolutionsar.com/api/me
curl https://app.homesolutionsar.com/api/clients
```

Browser checks:
- [ ] `https://app.homesolutionsar.com/app/estimating` — pipeline board loads with all 8 columns (empty on prod is expected and correct)
- [ ] "Estimating" appears in the nav between Clients and Subs
- [ ] `https://app.homesolutionsar.com/app/` — client list still loads
- [ ] "Tony Columbus" still shows top-right
- [ ] `https://dashboard.homesolutionsar.com` — legacy dashboard still works
- [ ] The deploy fix is confirmed: the legacy SW no longer hijacks `/app/*`, and `/app/` loads fresh (not a stale cached build)
- [ ] No console errors in DevTools

---

## Step 6 — Tag the Remote Deploy

```bash
git tag v0.3.0-sprint3-deployed
git push origin v0.3.0-sprint3-deployed
```

This marks exactly what's live in production.

---

## If Something Goes Wrong

### Worker deploy fails
Check the error — usually a TypeScript or binding issue. Fix locally, re-run `npx wrangler deploy`.

### Pipeline endpoint 500s on remote
Most likely the table shape differs from what the code expects. Compare:
```bash
npx wrangler d1 execute chs-hub-db --remote --command="PRAGMA table_info(estimate_requests);"
```
against the local table. Add any missing columns with a small follow-up migration.

### Nuclear rollback
```bash
# Redeploy the last known-good production version
git checkout v0.2.0-sprint2-deployed
npx wrangler deploy
git checkout main
# The DB migration was additive/no-op, so no data restore needed.
# If you must restore data: use backup_pre_sprint3_remote_YYYYMMDD.sql
```

---

## Done Criteria

- [ ] Remote backup stored (local + R2)
- [ ] `0026` ran on remote (no-op or create, verified)
- [ ] `estimate_requests` confirmed present with correct columns on remote
- [ ] `npx wrangler deploy` completed without errors
- [ ] `/api/estimate-requests/pipeline` returns grouped JSON on production
- [ ] Pipeline board loads at `app.homesolutionsar.com/app/estimating`
- [ ] "Estimating" nav item present
- [ ] Sprint 2 endpoints still healthy (`/api/me`, `/api/clients`)
- [ ] Legacy dashboard still works
- [ ] `/app/*` loads fresh (deploy fix confirmed, no stale cache, SW not hijacking)
- [ ] `v0.3.0-sprint3-deployed` tag pushed

**Once all boxes are checked → production is current through Sprint 3. Hand Sprint 4 prompt to Cursor.**

---

## Note on the Deploy Fix

This is the first remote deploy since the `7d1a174` deploy fix (rebuild frontend on deploy +
SW scoped to exclude `/app/*`). If `npm run deploy` is your deploy command, it should rebuild
the frontend first so `public/app/` can't go stale. Confirm you're using whichever command
includes the rebuild — if you run bare `npx wrangler deploy`, make sure the frontend build ran
first:

```bash
npm --prefix frontend run build   # if not already wired into your deploy script
npx wrangler deploy
```

Check what your `package.json` "deploy" script does and use that if it chains the build.
