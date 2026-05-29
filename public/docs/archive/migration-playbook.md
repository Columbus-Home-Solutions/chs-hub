# CHS Infrastructure Migration Playbook

> **Who this is for:** Tony, working through the migration to the `columbus-home-solutions` GitHub org and preparing to build `chs-automation`.
>
> **Total time budget:** ~90 minutes of hands-on work. You can pause between any two phases — each phase is independent and safe to resume later.
>
> **How to use this doc:** Follow top-to-bottom. Each step has a checkbox ☐. Mark it ✅ when done. Time estimates in parentheses. When you hit a 🔵 **BACK IN CURSOR** marker, that's your cue to come back to the chat for me to help with that step.

---

## Legend

- 🌐 **IN YOUR BROWSER** — do this in a web browser
- 💻 **IN TERMINAL** — do this in Terminal.app on your Mac
- 🔵 **BACK IN CURSOR** — come back to the Cursor chat with me
- ⚠️ **GOTCHA** — something that could trip you up; read carefully
- ☐ Checkbox (copy this to ✅ when done)

---

## Pre-flight — what you'll need handy (5 min)

Before you start, gather:

- ☐ Admin access to your Jobber account (for looking up secrets if needed)
- ☐ Admin access to Cloudflare (for updating DNS mid-migration)
- ☐ Your current GitHub account (`tony791`) logged in
- ☐ Terminal open on your Mac
- ☐ Your `chs-estimator-seeder` repo's `.env` file accessible (you'll copy values from it)
- ☐ A notes app or sticky note for jotting down values during the process
- ☐ This document open in a separate window

⚠️ **GOTCHA:** Don't close the window you're working in. You'll be flipping between GitHub, Cloudflare, and your terminal. Keep them in three tabs.

---

# Phase 1 — Create the GitHub Organization (10 min)

## 1.1 Create the org

1. ☐ 🌐 Go to https://github.com/organizations/new
2. ☐ Click **"Create a free organization"** (the left-most option; should be $0/month)
3. ☐ Fill in:
   - **Organization account name:** `columbus-home-solutions`
   - **Contact email:** your primary business email
   - **This organization belongs to:** select **"My personal account"**
4. ☐ Click **"Next"**
5. ☐ Skip adding teammates for now (click **"Complete setup"** or similar)

**Expected result:** You land on a new page at `github.com/columbus-home-solutions` with an empty org.

## 1.2 Lock down the org

1. ☐ 🌐 Go to `github.com/organizations/columbus-home-solutions/settings/security`
2. ☐ Under **"Authentication security"**, check **"Require two-factor authentication for everyone in the columbus-home-solutions organization"**
3. ☐ Click **"Save"**. Confirm when prompted.

⚠️ **GOTCHA:** If your own `tony791` account doesn't have 2FA enabled, you'll be kicked out of your own org when you save this. Make sure 2FA is on for your personal account first (github.com/settings/security).

4. ☐ 🌐 Go to `github.com/organizations/columbus-home-solutions/settings/profile`
5. ☐ (Optional) Add a display name ("Columbus Home Solutions") and description. This is cosmetic only.

---

# Phase 2 — Transfer `chs-estimator-seeder` (15 min)

## 2.1 Start the transfer

1. ☐ 🌐 Go to `github.com/tony791/chs-estimator-seeder/settings`
2. ☐ Scroll all the way to the bottom to the **"Danger Zone"** section
3. ☐ Click **"Transfer ownership"**
4. ☐ In the dialog:
   - **New owner's GitHub username or organization name:** `columbus-home-solutions`
   - **Type the repository name to confirm:** `chs-estimator-seeder`
5. ☐ Click **"I understand, transfer this repository"**
6. ☐ If prompted for password/2FA, confirm

**Expected result:** You're redirected to `github.com/columbus-home-solutions/chs-estimator-seeder`. The repo is now owned by the org. GitHub automatically redirects old URLs, so any existing links still work.

## 2.2 Re-add the 12 repo secrets

Secrets don't transfer with the repo — intentional, for security. You need to re-add them.

1. ☐ 🌐 Go to `github.com/columbus-home-solutions/chs-estimator-seeder/settings/secrets/actions`
2. ☐ Click **"New repository secret"** for each of the following and paste the value:

| Secret name | Source |
|---|---|
| `SHEET_ID` | your `.env` file line 2 (just the ID portion of the URL, or the whole URL — both work) |
| `GCP_SERVICE_ACCOUNT_JSON` | the full JSON contents of `/Users/tonycolumbus/.config/chs-estimator/service-account.json` (open in terminal with `cat` and copy) |
| `JOBBER_CLIENT_ID` | `.env` line 5 |
| `JOBBER_CLIENT_SECRET` | `.env` line 6 |
| `JOBBER_REFRESH_TOKEN` | `.env` line 9 |
| `REPO_SECRETS_PAT` | **regenerate this** — see step 2.3 below |
| `SMTP_HOST` | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | e.g. `465` |
| `SMTP_USERNAME` | your SMTP user |
| `SMTP_PASSWORD` | your SMTP app password |
| `SMTP_FROM` | e.g. `"CHS Pricebook Bot <bot@yourdomain.com>"` |
| `NOTIFY_EMAIL_TO` | your email address |

## 2.3 Regenerate the PAT for token rotation

⚠️ **GOTCHA:** Your existing `REPO_SECRETS_PAT` was scoped to `tony791/chs-estimator-seeder`. Fine-grained PATs don't follow repo transfers to new owners. If you skip this, the quarterly workflow runs but silently fails to rotate the Jobber refresh token, and the sync breaks 30-90 days later.

1. ☐ 🌐 Go to https://github.com/settings/personal-access-tokens/new
2. ☐ Fill in:
   - **Token name:** `chs-seeder refresh-token rotation`
   - **Resource owner:** select **`columbus-home-solutions`** (not your personal account)
   - **Expiration:** 1 year out (put a reminder on your calendar)
   - **Repository access:** "Only select repositories" → `chs-estimator-seeder`
   - **Permissions:** under "Repository permissions" → **Secrets** → Access level: **Read and write**
3. ☐ Click **"Generate token"**
4. ☐ Copy the token immediately (GitHub only shows it once)
5. ☐ Paste it as the `REPO_SECRETS_PAT` secret in step 2.2

## 2.4 Update your local git remote

1. ☐ 💻 In your terminal:
   ```bash
   cd ~/projects/chs-estimator-seeder
   git remote set-url origin https://github.com/columbus-home-solutions/chs-estimator-seeder.git
   git remote -v
   ```
2. ☐ Confirm the output shows `columbus-home-solutions` as the owner, not `tony791`

## 2.5 Smoke-test the transferred repo

1. ☐ 🌐 Go to `github.com/columbus-home-solutions/chs-estimator-seeder/actions`
2. ☐ Click **"Quarterly Pricebook Update"** in the left sidebar
3. ☐ Click **"Run workflow"** dropdown on the right
4. ☐ Set **Dry run** to `true`
5. ☐ Click **"Run workflow"** button
6. ☐ Wait ~2 minutes, then click the running workflow to see live logs
7. ☐ Confirm it completes with a green ✓
8. ☐ Open the log for the **"Update rotated Jobber refresh token"** step. You should see `Refresh token rotated.` — this confirms your new PAT works.

⚠️ **GOTCHA:** If that step says `REPO_SECRETS_PAT not set; skipping refresh token rotation.` the PAT secret isn't set. Go back and add it.

⚠️ **GOTCHA:** If the step errors with `gh: HTTP 403` or similar, the PAT doesn't have access to the new repo. Regenerate it under the new org context (step 2.3).

**Phase 2 complete when:** the dry-run workflow succeeds and the token-rotation log line shows `Refresh token rotated.`

---

# Phase 3 — Transfer `CHS---Dashboard` (20 min, includes DNS)

This one's more involved because of the custom domain.

## 3.1 (Optional) Rename the repo first

The three dashes in `CHS---Dashboard` are ugly. You can rename to `chs-dashboard` before or after transferring. Rename first means one less URL change; I recommend doing it now.

1. ☐ 🌐 Go to `github.com/tony791/CHS---Dashboard/settings`
2. ☐ Under **"General"** → **"Repository name"**, change to `chs-dashboard`
3. ☐ Click **"Rename"**. GitHub auto-redirects from the old name.

## 3.2 Transfer the repo

1. ☐ 🌐 Go to `github.com/tony791/chs-dashboard/settings` (the new name)
2. ☐ Scroll to **"Danger Zone"** → **"Transfer ownership"**
3. ☐ New owner: `columbus-home-solutions`
4. ☐ Confirm the transfer.

## 3.3 Re-enable GitHub Pages

⚠️ **GOTCHA:** Pages settings don't always survive a transfer. You need to verify it's still enabled and pointed correctly.

1. ☐ 🌐 Go to `github.com/columbus-home-solutions/chs-dashboard/settings/pages`
2. ☐ Under **"Build and deployment"**:
   - **Source:** Deploy from a branch
   - **Branch:** `main` / `(root)`
3. ☐ Click **"Save"** if you changed anything
4. ☐ Under **"Custom domain"**, you should see `dashboard.homesolutionsar.com`. If it's empty, re-enter it and save.
5. ☐ Wait 1–2 minutes. The **"Enforce HTTPS"** checkbox should become enabled. Check it.

## 3.4 Update Cloudflare DNS

Your Cloudflare DNS currently has a CNAME pointing `dashboard.homesolutionsar.com` → `tony791.github.io`. After the transfer, GitHub serves the site from a different hostname.

1. ☐ 🌐 Go to your Cloudflare dashboard → select the `homesolutionsar.com` zone → **DNS → Records**
2. ☐ Find the `CNAME` record for `dashboard`
3. ☐ Click **"Edit"**
4. ☐ Change the **Target** from `tony791.github.io` to `columbus-home-solutions.github.io`
5. ☐ Leave proxy status (orange/gray cloud) unchanged
6. ☐ Save
7. ☐ 🌐 Open a new browser tab → go to `https://dashboard.homesolutionsar.com`
8. ☐ Confirm the dashboard loads. (It might take 1–5 minutes for DNS + Pages to sync. If you see a 404, wait 5 min and retry.)

⚠️ **GOTCHA:** If the site shows "There isn't a GitHub Pages site here," double-check that:
- The `CNAME` file in the repo still contains `dashboard.homesolutionsar.com`
- Pages Source is set to `main` / `(root)` in repo settings
- You spelled the new GitHub org correctly in Cloudflare's CNAME target

## 3.5 Re-add repo secrets

The dashboard repo's Python sync workflow needs these. I don't have the workflow filename yet — **before this step, come tell me the filename (`.github/workflows/<name>.yml`) so I can confirm the exact secret list.** For now, these are the ones the Python script references:

- ☐ `JOBBER_CLIENT_ID` (same value as seeder)
- ☐ `JOBBER_CLIENT_SECRET` (same value as seeder)
- ☐ `JOBBER_REFRESH_TOKEN` — **important**: right now both the seeder AND the dashboard are supposedly using the same refresh token. This is broken because Jobber rotates the token on every use. We'll solve this in Phase 5 (Hardening). For now, copy the same value as the seeder and we'll untangle later.
- ☐ `GOOGLE_API_KEY`
- ☐ `JOB_TRACKER_SHEET_ID`
- ☐ `WC_SHEET_ID`

1. ☐ 🌐 `github.com/columbus-home-solutions/chs-dashboard/settings/secrets/actions` → **"New repository secret"** for each

## 3.6 Update your local git remote (if you have the dashboard cloned)

Check first:

1. ☐ 💻 `ls ~/projects/chs-dashboard` — if it exists, continue. If not, skip this step.
2. ☐ 💻 If it exists:
   ```bash
   cd ~/projects/chs-dashboard
   git remote set-url origin https://github.com/columbus-home-solutions/chs-dashboard.git
   git remote -v
   ```

**Phase 3 complete when:** the dashboard loads at `dashboard.homesolutionsar.com`, all secrets are re-added, and DNS points at the new org's github.io URL.

---

# Phase 4 — Post-transfer verification (10 min)

A sanity pass to catch anything that drifted.

## 4.1 Seeder repo checks

1. ☐ 🌐 `github.com/columbus-home-solutions/chs-estimator-seeder`
   - ☐ Confirm the repo page loads
   - ☐ Confirm the README shows the file tree correctly
   - ☐ Check Actions tab → confirm your dry-run from Phase 2.5 is green

## 4.2 Dashboard repo checks

1. ☐ 🌐 `github.com/columbus-home-solutions/chs-dashboard`
   - ☐ Confirm the repo page loads
   - ☐ Check Actions tab → look at the most recent workflow run
   - ☐ Note whether it's green, red, or hasn't run since the transfer

2. ☐ 🌐 `dashboard.homesolutionsar.com`
   - ☐ Confirm it loads (data freshness is a Phase 5 task — see backlog)

## 4.3 Run a fresh dashboard sync — ✅ DONE in Phase 3

Jobber Sync workflow ran green with fresh scopes and a fresh token. Do **NOT** re-run it until Phase 5 hardens the rotation bug.

## 4.4 Archive the pre-move state

Useful in case you ever need to prove what the codebase looked like pre-migration.

1. ☐ 💻 In the seeder repo:
   ```bash
   cd ~/projects/chs-estimator-seeder
   git tag v1.0-pre-migration
   git push origin v1.0-pre-migration
   ```
2. ☐ If you have the dashboard cloned, do the same there.

**Phase 4 complete when:** both repos load, both workflows run successfully, the dashboard site is live, and you've tagged a pre-migration snapshot.

---

# Phase 5 — Hardening pass 🔵 (30 min, with me in Cursor)

This phase isn't solo — it's where you come back to Cursor with me and we fix the things the audit flagged.

## 5.1 🔵 **BACK IN CURSOR**

Open the current Cursor chat (where this playbook was generated) and say:

> "Phase 4 is complete. Let's do the hardening pass."

I will then (ordered by urgency):

**🚨 CRITICAL — do first:**
- Fix the `jobber_sync.py` in `chs-dashboard`:
  - **Refresh-token rotation + persistence** back to GitHub secrets (so the script stops silently breaking itself — this is blocking hourly syncs right now)
  - Add proper error handling around the token exchange (Jobber's non-JSON error responses crash the script currently — confirmed in Phase 3 test run)
  - Add `jobber_test.py` defensive checks before attempting sync (or remove the redundant test step entirely — already removed from workflow)
- Give seeder and dashboard **separate Jobber apps / refresh tokens** so they stop rotating each other's tokens
- **Re-enable hourly cron** in `.github/workflows/jobber_sync.yml` (currently commented out)
- **Investigate dashboard data freshness issue** (Phase 3 closeout): after a successful Jobber Sync, dashboard.homesolutionsar.com did not display current data. Possible causes: stale GitHub Pages deployment (Deploy Dashboard workflow hasn't re-run since transfer), browser cache, Sheets gap from past cron failures, or dashboard frontend pointing at wrong Sheet IDs. Diagnose before shipping hardening.

**HIGH:**
- Replace hardcoded `"2026"` with dynamic current year
- Add pagination past 50 jobs
- Safer clear-then-write pattern (stage in tab, atomic swap)
- Add a dry-run mode

**NORMAL:**
- Add a top-level `README.md` and `.env.example` to `chs-estimator-seeder`
- Add `docs/runbooks/` with at least 2 runbooks (quarterly run failed, refresh token died)
- Tag `v1.0` on each repo

**Phase 5 complete when:** both repos have READMEs + `.env.example`, runbooks exist, the Python sync is patched, and `v1.0` tags are pushed.

---

# Phase 6 — Kickoff `chs-automation` 🔵 (new workspace, with me)

This is where the real build begins.

## 6.1 Export Google Sheets snapshots (5 min)

Critical — prevents me from hallucinating column letters in the new session.

For each of your two Google Sheets:

1. ☐ 🌐 Open the sheet in Google Sheets
2. ☐ For each tab we care about: File → Download → **Comma-Separated Values (.csv)**
3. ☐ Name them descriptively and save to a folder (e.g. `~/Desktop/chs-sheet-snapshots/`):
   - ☐ `job-tracker--main-tab.csv`
   - ☐ `job-tracker--dashboard-tab.csv`
   - ☐ `wc--kbpi-tab.csv`
   - ☐ Any other tab the automation reads or writes

## 6.2 Create the new project folder

1. ☐ 💻 In your terminal:
   ```bash
   mkdir -p ~/projects/chs-automation/docs/sheet-snapshots
   cp ~/Desktop/chs-sheet-snapshots/*.csv ~/projects/chs-automation/docs/sheet-snapshots/
   cd ~/projects/chs-automation
   git init
   ```

## 6.3 Open the new Cursor workspace

1. ☐ In Cursor, **File → Open Folder** → `~/projects/chs-automation`
2. ☐ Start a **new chat** in the new workspace (the icon to start a new conversation)
3. ☐ Paste the full contents of `KICKOFF-BRIEF.md` (see Appendix D below) as your first message
4. ☐ Follow with: "Scaffold the repo per the brief. Before writing code, review the sheet snapshots in `docs/sheet-snapshots/` and confirm the column assumptions with me."

**Phase 6 complete when:** the new session has scaffolded the repo (Worker + D1 schema + processor skeleton + wrangler config + GitHub Actions + runbooks).

---

# Appendix A — Required secrets reference

## `chs-estimator-seeder` secrets

| Secret | Where it comes from | Notes |
|---|---|---|
| `SHEET_ID` | Google Sheet URL for pricebook | Quarterly-updates sheet |
| `GCP_SERVICE_ACCOUNT_JSON` | Service account JSON file | Full contents, not a path |
| `JOBBER_CLIENT_ID` | Jobber Developer Center | |
| `JOBBER_CLIENT_SECRET` | Jobber Developer Center | |
| `JOBBER_REFRESH_TOKEN` | From bootstrap, rotates every run | |
| `REPO_SECRETS_PAT` | GitHub fine-grained PAT | Must be scoped to new org |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `SMTP_FROM` | Your email provider | Gmail needs App Password |
| `NOTIFY_EMAIL_TO` | Your email | |

## `chs-dashboard` secrets (tentative — confirm with workflow file)

| Secret | Notes |
|---|---|
| `JOBBER_CLIENT_ID` | Same as seeder |
| `JOBBER_CLIENT_SECRET` | Same as seeder |
| `JOBBER_REFRESH_TOKEN` | **Both repos currently share this — this is the bug we fix in Phase 5** |
| `GOOGLE_API_KEY` | Google Cloud Console API key for Sheets |
| `JOB_TRACKER_SHEET_ID` | Spreadsheet ID of the Job Tracker workbook |
| `WC_SHEET_ID` | Spreadsheet ID of the Wealthy Contractor workbook |

## Future `chs-automation` secrets (for reference)

Not needed yet. Listed here so you know what's coming:

- `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`, `JOBBER_REFRESH_TOKEN` — Jobber API access
- `JOBBER_WEBHOOK_SECRET` — HMAC signature verification for webhooks
- `SHEETS_SERVICE_ACCOUNT_JSON` — writes to Sheets
- `CLOUDFLARE_API_TOKEN` — Worker deploys (optional if using wrangler locally)
- `D1_DATABASE_ID` — created during wrangler setup
- `R2_BUCKET_NAME` — for nightly backups
- `NOTIFY_EMAIL_TO` / SMTP secrets — alerts

---

# Appendix B — Troubleshooting

## "I transferred the repo but my old git clone stopped working"

Run `git remote set-url origin https://github.com/columbus-home-solutions/<repo-name>.git` in the repo directory. GitHub auto-redirects old URLs, so even if you forget this, pushes/pulls still work; updating the remote is just for cleanliness.

## "The workflow says `REPO_SECRETS_PAT not set`"

You skipped step 2.3 or didn't save the secret correctly. Go to the new repo's Secrets page and confirm `REPO_SECRETS_PAT` is in the list. If it is but still fails, the PAT needs to be regenerated under the org context (not your personal account).

## "Dashboard site returns a 404 after the transfer"

Three things to check in order:
1. Is the `CNAME` file still in the repo? (`cat CNAME` or look at it on GitHub)
2. Is GitHub Pages enabled on the transferred repo? (`Settings → Pages` → Source should be main/root)
3. Does Cloudflare DNS point at `columbus-home-solutions.github.io`? (NOT `tony791.github.io`)

If all three are correct, wait 10 minutes and retry — DNS propagation is sometimes slow.

## "I accidentally enforced 2FA before enabling it on my personal account"

You'll be locked out of the org. Log into GitHub on your personal account, go to `github.com/settings/security`, enable 2FA, and the org will re-accept you.

## "The dashboard Python sync failed after the transfer"

Most likely cause: `JOBBER_REFRESH_TOKEN` secret not re-added, or wrong value. Second most likely: Cloudflare DNS still points at the old hostname and the script is somehow fetching from there. Third: pre-existing bug surfaced by the transfer (likely the refresh-token rotation issue — Phase 5 fixes this).

---

# Appendix C — Rollback

If anything goes catastrophically wrong in the first 72 hours post-transfer, you can transfer the repo back to your personal account: `Settings → Danger Zone → Transfer ownership → tony791`. Secrets you added to the org repo will be lost; you'll need to re-add them in your personal repo. This is why Phase 4 exists — catch issues before they compound.

Past 72 hours, rollback isn't practical (you'll have new commits, CI runs, etc.). Call out any concerns during verification instead of proceeding if something feels wrong.

---

# Appendix D — `chs-automation` Kickoff Brief

Copy-paste this entire block as the first message in the new Cursor workspace after Phase 6:

````markdown
# chs-automation — Kickoff Brief

## What this project is

A reliable, observable event pipeline for Columbus Home Solutions. Jobber is the source of truth. This repo owns the *write path* to Google Sheets. The dashboard and seeder repos own other, separate jobs.

**One-sentence architecture:**
Jobber → Cloudflare Worker (webhook receiver) → D1 event log → every-5-min processor → Google Sheets (display only). Side effects (email, SMS, Drive folders) live in Zapier or native Jobber, triggered off the event log, never off Jobber directly.

## Related repos (in the `columbus-home-solutions` GitHub org)

All three live under `~/projects/` locally.

- `chs-estimator-seeder`: quarterly pricebook sync. Reference only — reuse its Jobber OAuth + token rotation pattern; never modify from here.
- `chs-dashboard`: static PWA frontend on GitHub Pages at `dashboard.homesolutionsar.com`. Contains a legacy `jobber_sync.py` that will be decommissioned once this repo's pipeline is proven in shadow mode for a week.
- `chs-automation` (this repo): owns the write path to Sheets.

## Architecture (decided — do not re-litigate)

Jobber webhook → Cloudflare Worker → D1 append-only event log → every-5-min processor → Sheets. Side effects are separate (Zapier / native Jobber), triggered off the log, not off Jobber directly.

## Guiding principles (non-negotiable)

1. Idempotent recomputes only. Never read-modify-write counters.
2. Sheets own nothing. They display derived state via SUMIFS/QUERY against raw event tabs.
3. One event log, one processor. No scattered Zaps doing Jobber → Sheets.
4. Separate "know" from "do". Aggregation = code. Side effects = Zapier / Jobber native.
5. Use Jobber's native automations before building anything. ~30% of the playbook duplicates built-in features.
6. Dry-run by default on every script.
7. Everything in Git.

## Reliability patterns required from day one

- Event dedup via `event_id` unique key in D1
- Dead-letter table for failed events + hourly retry
- Heartbeat alert: if no Jobber webhook received in 4 business hours → SMS/email
- Replay command: `npm run replay -- --since=YYYY-MM-DD`
- Dry-run flag on every processor script, default true
- Daily "everything is fine" summary email
- Nightly D1 backup to Cloudflare R2
- No `.env` committed. Worker secrets + GitHub Actions Secrets. Plan to migrate to 1Password/Doppler on first hire.

## Repo structure (target)

```
chs-automation/
├── worker/
│   ├── src/index.ts
│   └── wrangler.toml
├── processor/
│   ├── src/
│   │   ├── jobber.ts
│   │   ├── sheets.ts
│   │   ├── kbpi.ts
│   │   ├── cost-breakdown.ts
│   │   ├── job-tracker.ts
│   │   └── cli.ts
│   └── package.json
├── migrations/
├── .github/workflows/
│   ├── process-events.yml
│   ├── nightly-backup.yml
│   └── heartbeat.yml
├── docs/
│   ├── kickoff.md
│   ├── sheet-snapshots/
│   ├── runbooks/
│   └── architecture.md
├── .env.example
└── README.md
```

## First task

Scaffold the repo per the structure above. Before writing code, review the sheet snapshots in `docs/sheet-snapshots/` and confirm the column assumptions with me. No deploys yet. Dry-run by default.
````

---

# Summary — Your action list

Use this as your top-level checklist.

- ✅ **Phase 1** — Create GitHub org + enforce 2FA (10 min)
- ✅ **Phase 2** — Transfer `chs-estimator-seeder`, re-add secrets, regenerate PAT, smoke-test (15 min)
- ✅ **Phase 3** — Rename + transfer dashboard, update DNS, re-enable Pages, re-add secrets (20 min)
- ✅ **Phase 4** — Verify both repos work post-transfer, tag `v1.0-pre-migration` (10 min)
- 🟡 **Phase 5** — 🔵 Back in Cursor for hardening pass (next session)
- ⬜ **Phase 6** — Export sheets, create new project folder, kick off `chs-automation` in new workspace

## Session handoff — state as of Apr 23, 2026

**Resume tomorrow by saying:** "Let's start Phase 5."

### Current state
- Both repos live under `Columbus-Home-Solutions` org
- `dashboard.homesolutionsar.com` CNAME points to new org's Pages
- All secrets migrated and verified
- Jobber Sync workflow succeeded once tonight with fresh token + broader scopes
- **Hourly cron is DISABLED** (commented out in `jobber_sync.yml`) — do not re-enable until Phase 5 rotation fix is shipped
- **Redundant `Test Jobber Connection` step was removed** from workflow
- Jobber Developer app scopes are now broad (Clients, Quotes, Jobs, Invoices, Expenses, Payments, etc.)

### Dashboard vision (context for future rebuild)
The dashboard is not a Jobber report viewer — it's an **operational hub** for daily work:
- Revenue tracking (gross/net × weekly/monthly) — Jobber doesn't surface these cleanly
- Google Tasks integration
- HighLevel CRM integration (this is what `HL_TOKEN` is for)
- Smart notes feature with Claude auto-categorization
- Google Meetings
- Central launch point for all daily tools

Future rebuild (Phase 7+) should be approached as a **proper ops dashboard**, not a Sheets-backed MVP. Candidates: Next.js on Cloudflare Pages (most flexible), Retool (fastest), or Metabase (best for pure analytics).

### Phase 5 backlog (in priority order)

**🚨 CRITICAL:**
1. ✅ Refresh-token rotation + persistence in `jobber_sync.py` (shipped — writes new token back to `JOBBER_REFRESH_TOKEN` secret via `GH_TOKEN_ROTATOR` PAT)
2. Separate Jobber Developer apps for seeder vs dashboard (stop cross-contaminating tokens) — deferred, low risk now that rotation is persisted
3. ✅ Re-enable cron in `jobber_sync.yml` (shipped — every 2 hours)
4. ✅ **Dashboard data freshness** — root cause: `Dashboard!B2:G2` (the sync's KPI write target) was inside a merged cell `A2:N2` containing descriptive text. Writes were silently absorbed. Fix shipped: sync now writes to a dedicated `KPI_Sync` tab; frontend `fetchJobberMetrics()` reads from the same tab. Pretty "Business Performance Dashboard" view remains untouched.

**HIGH:**
5. ✅ Replace hardcoded `"2026"` year filter with dynamic `datetime.now().year`
6. ✅ Add pagination past 50 jobs (now paginates up to 5,000 via `pageInfo.endCursor`)
7. ✅ Defensive parsing + retry/backoff on `THROTTLED` GraphQL errors + skip-KPI-write safeguard on empty result
8. Safer clear-then-write pattern for Sheets (stage in hidden tab, atomic swap) — Apps Script change, queued
9. Batch expense queries instead of per-job calls (rate-limit friendly)
10. Add `--dry-run` mode

**NORMAL:**
11. Add top-level `README.md` and `.env.example` to `chs-estimator-seeder`
12. Add `docs/runbooks/` (quarterly-run-failed.md, refresh-token-died.md, kpi-sync-tab-deleted.md)
13. Tag `v1.0` on both repos after hardening

### Do NOT do before Phase 5
- ❌ Re-run Jobber Sync workflow — will invalidate the stored token
- ❌ Re-enable the hourly cron
- ❌ Touch Jobber Developer app settings

### Phase 7 backlog (dashboard rebuild)
- Many DevTools console errors on the current dashboard (observed during Phase 5). Most likely causes: stale OAuth tokens, HL API issues, service worker caching, Cloudflare Worker timeouts. Triage when rebuild starts — many will disappear when data plane moves to D1 in Phase 6.

Good luck. Take breaks between phases — none of this is time-pressured except for maintaining focus during DNS changes.
