# Google Drive mirror — resume from ground zero

**Where this file lives:** `docs/` is the right place for topic runbooks (versioned, easy to find). Root **`HANDOFF.md`** is for in-flight agent/session work and backlogs, not a substitute for this mirror checklist.

**When to use this:** The next session is sequenced in **`HANDOFF.md` under “Next session”** — complete the **Gmail quick link** item there first, then return here for the Drive mirror.

Upload this file (or paste its contents) when you want to set up or re-verify the **D1 + R2 → Google Shared Drive** one-way copy in **chs-hub**. The implementation lives in `src/lib/ops/drive-mirror.ts` and runs on the **hourly cron** (`15 * * * *`); you can also trigger it manually.

## What actually gets mirrored

- **Job photos** (`photos` in D1, R2) until `drive_mirrored_at` is set  
- **Expense receipts** (expenses with `receipt_r2_key`, not mirrored)  
- **Company documents** (`company_documents`, R2)  

**Not mirrored:** project **`job_files`** and other file types. Extending the mirror to job files would be a separate code change.

## Worker configuration (production)

1. **Secret `GOOGLE_SERVICE_ACCOUNT_JSON`** — full JSON for a Google Cloud **service account** (same pattern as other Google integrations; use `wrangler secret put` or the Cloudflare dashboard).  
2. **Variable `DRIVE_SHARED_DRIVE_ID`** — the Shared Drive ID (from the URL when that drive is open in the browser).  
3. **Variable `DRIVE_MIRROR_ROOT_FOLDER_ID`** — a folder *inside* that drive where the mirror creates `Photos`, `Expenses`, and `Company` subfolders (ID from the URL `.../folders/FOLDER_ID`).

**Note:** In `wrangler.toml` you may only see comment placeholders; set real values in the **Worker → Settings → Variables** (and secrets) for the deployed worker.

**Trigger secret:** Manual/cron-style ops (including drive mirror) use **`SYNC_TRIGGER_SECRET`** for `GET`/`POST` to `/api/ops/drive-mirror` (`?secret=` or header `x-sync-token`).

## Google Cloud / Drive (operator checklist)

- In the **same GCP project** as the service account, enable the **Google Drive API**.  
- In **Google Drive**, open the **Shared Drive** and add the service account’s **client email** with a role that can **create and upload files** (e.g. **Content manager** on that drive, or a suitable contributor role).  
- Confirm the **root folder** lives under that Shared Drive and copy its folder ID.  
- If token minting fails, check JSON validity, API enablement, and Shared Drive membership.

## Verify (after deploy)

Use your worker’s public origin (e.g. `https://<worker>.<subdomain>.workers.dev` or your custom host).

**1. Read-only status (no uploads)** — requires `SYNC_TRIGGER_SECRET`:

```http
GET /api/ops/drive-mirror
```

You should see JSON with:

- `configured` — all three of secret + two Drive vars present  
- `reason` — if not configured, why (e.g. missing vars)  
- `pending` — row counts for photos / expenses with receipt / company docs not yet mirrored  
- `drive_token_ok` — when configured, whether a **Drive-scoped** OAuth token can be obtained (false ⇒ fix Google side)  
- `mirrors` — lists what the job copies (documentation for operators)

**2. Run one batch (bounded limits per run):**

```http
POST /api/ops/drive-mirror
```

Same auth as `GET`. Inspect `skipped`, `errors`, and per-type counts. Use **`wrangler tail`** to follow cron and manual errors.

## If nothing appears in Drive

- `GET` shows **`pending` all zero** — nothing left to mirror, or no eligible rows (e.g. no expense receipts in R2).  
- **`configured: false`** — set the missing env vars in **production** and redeploy if needed.  
- **`drive_token_ok: false`** — fix service account, Drive API, or Shared Drive access.  
- **403 on Drive** after upload — folder/drive ID wrong or service account not on the drive.  
- **Expecting project files in Drive** — not supported by the current mirror; plan an extension if required.

Last aligned with code path: `runDriveMirror` + `getDriveMirrorStatus` in `src/lib/ops/drive-mirror.ts`, routes in `src/routes/ops.ts` and `src/index.ts`.
