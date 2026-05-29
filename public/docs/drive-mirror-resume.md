# Google Drive mirror — resume from ground zero

**Where this file lives:** `docs/` is the right place for topic runbooks (versioned, easy to find). Root **`HANDOFF.md`** is for in-flight agent/session work and backlogs, not a substitute for this mirror checklist.

**When to use this:** Use this when wiring or re-verifying the Drive mirror. **`HANDOFF.md`** lists it under “Next session” as the current ops priority (Gmail quick link is verified working; no prerequisite).

Upload this file (or paste its contents) when you want to set up or re-verify the **D1 + R2 → Google Shared Drive** one-way copy in **chs-hub**. The implementation lives in `src/lib/ops/drive-mirror.ts` and runs on the **hourly cron** (`15 * * * *`); you can also trigger it manually.

## What actually gets mirrored

**Layout under `Jobs/`:** **`Jobs/<calendar year>/<client folder>/<#number Title>/`** then the same structure as Hub Files Explorer:

- **Year / client / job** — calendar year from **`jobs.start_at`**, else **`created_at`**, else **`synced_at`**; client folder from **`clients.name`** (or **`Unassigned clients`**); job folder **`#<number> <title>`** (same rules as before).

- **`SITE PHOTOS/`** — **`Before`**, **`Progress`**, **`Final`** (legacy on-site categories map to **Progress** for Drive). Job photos mirror into the matching subfolder.
- **`PROJECT FILES/`** — **`Drawings & plans`**, **`Field notes`**, **`Contracts`**, **`Project receipts`**, **`Sub / pay records`**, **`Design & finishes`** (legacy **`other`** job files mirror under Design & finishes). Job **`job_files`** and job-linked **expense receipts** use these folders (receipts → **Project receipts**).

Unassigned photos still go to top-level **`Photos/`**. Unassigned expense receipts → **`Expenses/`**.

For each **`jobs`** row, the mirror eventually creates the empty **`SITE PHOTOS` + `PROJECT FILES`** subtree (**`jobs_without_drive_stub`** drains at **25** jobs per run).

### Jobber quote/invoice PDFs → **Contracts** / **Sub / pay records** (not yet wired)

Jobber removed **`previewUrl`** on Quote and Invoice (Nov 2023). There is no documented replacement PDF URL in the public changelog. Use **GraphiQL** (Developer Center → your app → Test in GraphiQL) to find a **`Quote` / `Invoice` / `PaymentRecord` field** that returns a downloadable PDF or signed URL, then extend **`src/lib/jobber/`** ingestion to store rows in **`job_files`** with **`doc_type`** **`contracts`** (approved quotes) or **`pay_stub`** (invoices / payment receipts) — same R2 + Drive path as other project files.

### Jobber job note attachments → hub + Drive (**implemented**)

On each **`jobber_full`** sync, every job page includes **note attachments** (root `noteAttachments` plus `notes { ... on JobNote { fileAttachments } }`, deduped by file id). New files are downloaded from Jobber (Bearer retry on 401/403), stored under **`job-files/<job_id>/jobber/…`** in R2, and inserted as **`job_files`** with **`source = 'jobber'`** and **`jobber_attachment_id`** (unique — skips already-imported rows). The hourly Drive mirror then copies them like other project files.

**Limits:** 32 MB per file; failures append to sync **`errors`** but do not fail the whole job row.

If Jobber’s schema errors on this query (field names differ by API version), adjust **`JOBS_PAGE_QUERY`** in **`src/lib/jobber/queries.ts`** to match your app’s GraphiQL schema (see [Jobber developer docs](https://developer.getjobber.com/)).

## D1 schema

Apply migrations through **`0013`** on production D1 if not already ( **`0013`** = `job_files` source columns for Jobber ingestion):

```bash
npm run db:migrate:remote
```

## Worker configuration (production)

1. **Secret `GOOGLE_SERVICE_ACCOUNT_JSON`** — full JSON for a Google Cloud **service account** (same pattern as other Google integrations; use `wrangler secret put` or the Cloudflare dashboard).  
2. **Variable `DRIVE_SHARED_DRIVE_ID`** — the Shared Drive ID (from the URL when that drive is open in the browser).  
3. **Variable `DRIVE_MIRROR_ROOT_FOLDER_ID`** — a folder *inside* that drive where the mirror creates **`Jobs/`**, **`Photos/`**, **`Expenses/`**, and **`Company/`** (ID from the URL `.../folders/FOLDER_ID`).

**Note:** You can add the two Drive vars under **`[vars]`** in **`wrangler.toml`** (public IDs only) or set them in **Worker → Settings → Variables**. Secrets never go in **`wrangler.toml`**.

**Trigger secret:** Manual/cron-style ops (including drive mirror) use **`SYNC_TRIGGER_SECRET`** for `GET`/`POST` to `/api/ops/drive-mirror` (`?secret=` or header `x-sync-token`).

## Google Cloud / Drive (operator checklist)

- In the **same GCP project** as the service account, enable the **Google Drive API**.  
- In **Google Drive**, open the **Shared Drive** and add the service account’s **client email** with a role that can **create and upload files** (e.g. **Content manager** on that drive, or a suitable contributor role).  
- Confirm the **root folder** lives under that Shared Drive and copy its folder ID.  
- If token minting fails, check JSON validity, API enablement, and Shared Drive membership.

## Verify (after deploy)

Use your worker’s public origin (e.g. `https://<worker>.<subdomain>.workers.dev` or your custom host). If the dashboard host sits behind **Cloudflare Access**, call **`*.workers.dev`** (or another path that bypasses Access) so the ops route is reachable.

**Auth:** Pass **`SYNC_TRIGGER_SECRET`** as **`?secret=…`** or header **`x-sync-token: …`**. Omitting or mismatching returns **403**.

**1. Read-only status (no uploads):**

```bash
curl -sS "https://<your-worker-host>/api/ops/drive-mirror?secret=$SYNC_TRIGGER_SECRET"
```

You should see JSON with:

- `configured` — all three of secret + two Drive vars present  
- `reason` — if not configured, why (e.g. missing vars)  
- `pending` — row counts for file rows not yet mirrored (photos, receipts, job_files, company docs)  
- `jobs_without_drive_stub` — D1 **`jobs`** rows that have not yet had the empty **Photos / Receipts / Files** tree created in Drive (drains over successive runs, **25** per run)
- `drive_token_ok` — when configured, whether a **Drive-scoped** OAuth token can be obtained (false ⇒ fix Google side)  
- `mirrors` — lists what the job copies (documentation for operators)

**2. Run one batch (bounded limits per run):**

```bash
curl -sS -X POST "https://<your-worker-host>/api/ops/drive-mirror?secret=$SYNC_TRIGGER_SECRET"
# or: curl -sS -X POST -H "x-sync-token: $SYNC_TRIGGER_SECRET" "https://<your-worker-host>/api/ops/drive-mirror"
```

Same auth as `GET`. Inspect `skipped`, `errors`, **`job_folder_stubs`**, and per-type counts. Use **`npm run tail`** (or **`wrangler tail`**) to follow cron and manual errors.

## Reset job folders to new naming (one-time)

After changing how folders are named (e.g. Jobber **title** in the path), **`drive_mirror_folders`** still points at the **old** Google folder IDs until you clear those rows.

1. **Deploy** the Worker that contains the new naming logic.  
2. **Clear cached job/stub paths** in **remote** D1 (does **not** delete anything in Google Drive):

```bash
cd /Users/tonycolumbus/projects/chs-hub
npx wrangler d1 execute chs-hub-db --remote --file scripts/drive-mirror-reset-job-folder-cache.sql
```

3. **Google Drive:** Old **`Jobs/…`** trees (wrong **year / client / job** nesting) may be orphaned. Remove or archive in the UI if needed. Top-level **`Jobs`**, **`Photos`**, **`Expenses`**, **`Company`** segment cache (`seg_*` / `co_*`) is unchanged.  
4. **Re-create trees:** run **`POST /api/ops/drive-mirror`** repeatedly (or wait for cron) until **`jobs_without_drive_stub`** hits **0**. New folders use the **current** name format.  
5. **Optional — re-upload files** into the new job folders: null out **`drive_mirrored_at`** on `photos`, `expenses` (with receipt), `job_files`, and/or `company_documents`, then run **`POST`** until **`pending`** is clear. This **copies bytes again**; old files in removed/orphan folders are your cleanup.

## If nothing appears in Drive

- `GET` shows **`pending` all zero** — nothing left to mirror, or no eligible rows (e.g. no expense receipts in R2).  
- **`configured: false`** — set the missing env vars in **production** and redeploy if needed.  
- **`drive_token_ok: false`** — fix service account, Drive API, or Shared Drive access.  
- **403 on Drive** after upload — folder/drive ID wrong or service account not on the drive.  
- **Expecting every Jobber-only attachment in hub/Drive automatically** — needs **`0013`** + a future Jobber sync pass (see **Jobber attachments** above). Dashboard **`POST /api/job-files`** rows mirror today.

Last aligned with code path: `runDriveMirror` + `getDriveMirrorStatus` in `src/lib/ops/drive-mirror.ts`, routes in `src/routes/ops.ts` and `src/index.ts`.
