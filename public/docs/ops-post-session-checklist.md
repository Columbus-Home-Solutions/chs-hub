# Ops checklist — post-session wrap-up (Jobber, deploy, Drive, Hub Files)

Use this after a big code change or a long manual **Jobber sync**, so you don’t have to dig through chat history. Replace placeholder values with yours.

**May 11, 2026 — Worker config note:** `wrangler.toml` includes **`[limits]`** with **`subrequests = 10000`** and **`cpu_ms = 300000`** (5 minutes) so heavy **Jobber + WC** cron runs and **Drive mirror** are less likely to hit **“Exceeded CPU Limit”** or **“Too many subrequests”**. **Deploy** for this to apply. Confirm your Cloudflare **Workers usage model** supports configurable limits.

---

## 1. Wait for the running Jobber sync (`curl`)

If `curl` is still open with no output, that’s normal: the Worker runs the **entire** sync inside one HTTP request. With `-sS` there’s no progress bar.

When it finishes you should see:

- A line like `HTTP 200 in …s` (or `500` if something threw).
- JSON from `/tmp/jobber-sync.json` (from `cat`).

Check the JSON for:

- `ok` — `true` if `errors` is empty (your route may still return stats with per-file errors; read `errors` array).
- `jobber_job_files_written` — Jobber note attachments ingested this run.
- `errors` — any `jobber_file …` or other messages.

---

## 2. Rotate sync secret (if it was exposed)

If **`SYNC_TRIGGER_SECRET`** / `x-sync-token` ever appeared in a screenshot, chat, or repo, treat it as compromised.

```bash
cd /path/to/chs-hub
npx wrangler secret put SYNC_TRIGGER_SECRET
```

Update any scripts, cron jobs, or password managers that stored the old value.

---

## 3. Deploy latest Worker

```bash
cd /path/to/chs-hub
npm run deploy
```

If tonight’s fixes aren’t deployed yet, deploy **before** treating a sync result as authoritative.

---

## 4. Trigger Jobber sync (production Worker)

Use **`*.workers.dev`** so Cloudflare Access on the dashboard hostname doesn’t return `302` to login.

```bash
cd /path/to/chs-hub
export BASE="https://chs-hub.<your-subdomain>.workers.dev"
export SECRET="<paste-new-secret-after-rotation>"

curl -sS -X POST "$BASE/api/sync/jobber" \
  -H "Content-Type: application/json" \
  -H "x-sync-token: $SECRET" \
  -w "\n\nHTTP %{http_code} in %{time_total}s\n" \
  -o /tmp/jobber-sync.json && cat /tmp/jobber-sync.json
```

Optional second run: confirms Jobber file idempotency (`jobber_attachment_id` / no duplicate rows for same attachment).

**Logs (second terminal):**

```bash
cd /path/to/chs-hub
npm run tail
```

You may see `[jobber] throttled — waiting …` during retries; that’s expected after rate-limit changes.

**Leaving `curl` running overnight:** The Worker may still be working, but the **HTTP connection** can be closed by **proxies or Cloudflare edge timeouts** on very long requests — you might see **`524`**, an empty response, or a dropped client **even if** partial work happened. **Ground truth:** `sync_log` in D1 (Jobber row `jobber_full`) and **`npm run tail`**. The **`*/30`** cron also runs **Jobber + WC** (same code path in `waitUntil`) — good backup if manual **`curl`** doesn’t finish cleanly.

---

## 5. Verify Hub Files + Capture

- Open **Hub Files** (`/files` on your dashboard host): explorer should show **SITE PHOTOS** (Before / Progress / Final) and **PROJECT FILES** without the removed folders; try a small upload.
- Open **CHS Capture** (`/capture/`): only **three** photo categories; send a test photo and confirm it appears on the job.

---

## 6. Verify Google Drive mirror

After there is something pending to mirror, either wait for the **hourly** mirror cron or trigger it the same way you usually do, e.g.:

```bash
# Example only — your ops route may differ; use your documented token + host.
curl -sS -X POST "$BASE/api/ops/drive-mirror" \
  -H "Content-Type: application/json" \
  -H "x-sync-token: $SECRET"
```

In Drive, under a job folder, **new** copies should follow **SITE PHOTOS** / **PROJECT FILES** subfolders. Older runs may still have legacy **Photos / Receipts / Files** paths; that’s expected until you clean or re-mirror intentionally.

**Pending counts (optional):**

```bash
cd /path/to/chs-hub
npx wrangler d1 execute chs-hub-db --remote --command \
  "SELECT id, job_name, status, started_at, finished_at, rows_affected, duration_ms, error_message FROM sync_log ORDER BY started_at DESC LIMIT 10"
```

(Or `npm run ops:sync:log` if that script exists in `package.json`.)

---

## 7. Optional D1 cleanup

- **Photos** with legacy categories (`issue`, `marketing`, `safety`, `incident`): use **`PATCH /api/photos/:id`** with `category` in `before` | `progress` | `final` if you want everything aligned.
- **`job_files`** with `doc_type = 'other'`: optional **`PATCH /api/job-files/:id`** to move to another type; new uploads can’t use `other` from the dashboard.

---

## 8. Later: Jobber quote / invoice PDFs

Not automated until GraphQL exposes a **stable download URL** for quote/invoice PDFs (`previewUrl` was removed in 2023). Next step: **GraphiQL** in Jobber Developer Center → find fields on `Quote` / `Invoice` / `PaymentRecord` → wire `src/lib/jobber/financial-pdfs-ingest.ts` (currently a **stub**). See **`docs/drive-mirror-resume.md`** for the short note.

## 9. Drive mirror stub throughput

With **hub-aligned** folders, each **new** job stub uses **many** Drive API calls. **`BATCH_JOB_FOLDER_STUBS`** is **4** per mirror run (`src/lib/ops/drive-mirror.ts`) so hourly **`drive_mirror`** stays under subrequest budgets during **backfill**. After the **`stub_*`** queue is small, you can **raise** the batch (e.g. 8–12) if **`npm run tail`** stays clean and **`[limits]`** is deployed.

---

## Quick reference — production URLs

- Dashboard (often behind Access): your `dashboard.*` custom domain.
- Raw Worker (good for `curl` / ops): `https://chs-hub.<subdomain>.workers.dev` (confirm in Cloudflare → Workers → **chs-hub** → Domains).

When in doubt, deploy → sync on **workers.dev** → tail logs → then spot-check Hub Files, Capture, and Drive.
