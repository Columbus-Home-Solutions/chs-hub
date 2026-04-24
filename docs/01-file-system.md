# Cloudflare-Native File System — Build Plan

**Status:** Decision locked 2026-04-24 — Tony greenlit full Cloudflare-native approach
**Companion to:** REBUILD-ARCHITECTURE.md (which has the D1 schema)

---

## 1. What's changing

**Today:** files live in Google Shared Drive with a 10-folder structure, job photos go through iPhone Shortcut → `_Incoming` folder → Claude Cowork nightly sort → per-job folders.

**After Session 7:** files live in Cloudflare R2, indexed by D1, captured via PWA on any phone, browsable in the dashboard, shareable via signed links with expiration.

**Google Drive stays available** as a human-centric file storage for one-off needs (tax docs, HR stuff, etc.) but is no longer in any automation path.

---

## 2. Why the full Cloudflare approach won

I initially floated a hybrid (Drive as source of truth + R2 mirror). Tony correctly pointed out this adds complexity without clear benefit. The full-Cloudflare path wins on:

| Dimension | Drive-based today | Cloudflare-native |
|---|---|---|
| Mobile capture | iPhone Shortcut (fragile) | PWA works on any device |
| Sorting reliability | Nightly Cowork job on Tony's laptop | Workers cron in the cloud, 24/7 |
| Multi-employee | Awkward (everyone uses Tony's shortcut?) | Native (each user logs in, uploads tagged to them + their current job) |
| Search | Drive search (slow, no structured metadata) | D1 SQL (millisecond, filter by anything) |
| Share with client | Generate Drive link, permissions awkward | Signed URLs with expiration, view count |
| Audit | None | Every upload/view/share logged |
| Cost at 10K photos | $2-10/mo (Workspace per-seat) | $0.00 (free tier) |
| Cost at 100K photos | Same (Workspace) | ~$0.30/mo (R2 storage) |
| Scaling to 5 employees | $60/mo (5 × Workspace Business) | ~$0 (same R2 bucket, per-user auth) |

The only real cost is one build session (~2-3 hrs) and the one-time data migration.

---

## 3. The file model — structure without folders

Tony's current Drive SOP defines a mental model:
- Active Jobs / Completed Jobs / Leads
- Within each job: Before, Progress, Final, Issues, Contracts, Invoices, Receipts

**We preserve this model logically, not physically.**

Instead of folders in a tree, every file has structured metadata:
```
file {
  job_id: 'abc123'          → implicitly "which folder"
  category: 'before'         → implicitly "which sub-folder"
  tags: ['kitchen', 'demo']  → free-form labels
  taken_at: '2026-04-15'     → chronological sorting
  captured_by: 'user_xyz'    → who uploaded it
}
```

This means:
- **Browse as folders** if Tony prefers: "Show me Active Jobs → Johnson Kitchen → Before photos" → SQL: `WHERE job_id='X' AND category='before'`
- **Search across everything** if useful: "Show me all kitchen demo photos from Q1" → SQL: `WHERE taken_at BETWEEN ... AND tags CONTAINS 'kitchen' AND 'demo'`
- **Multi-category without duplication**: a photo can be both `category='final'` AND tagged `'social_ready'` without being in two folders. Single source of truth.

---

## 4. The PWA mobile capture flow

### Installation (one-time, 60 seconds)

Tony or crew opens `dashboard.homesolutionsar.com` in Safari/Chrome on phone → Share menu → "Add to Home Screen." Done. Now it's a full-screen app icon on their home screen.

### Daily use

1. Tap the app icon
2. Logged in automatically (Worker session cookie, stays signed in 30 days)
3. Top of app shows: "Uploading to: Johnson Bathroom Remodel" (user's current job — changeable)
4. Big **Camera** button → native camera opens
5. Take 1 or many photos → confirm → PWA uploads directly to R2 with:
   - `job_id` = current job
   - `category` = "progress" (default, changeable)
   - `taken_at` = photo EXIF timestamp
   - `captured_by_device` = user's phone
   - `captured_lat/lon` if location permission granted
6. Photo appears in dashboard within seconds

### Offline handling

If crew is on a job site with poor signal:
- PWA queues uploads locally (service worker + IndexedDB)
- Shows "3 photos pending — will upload when online"
- Auto-uploads when signal returns
- Zero data loss, zero user frustration

### Other actions in the PWA

- Switch current job (dropdown of active jobs)
- Toggle category for a photo after capture (Before/Progress/Final/Issues)
- View recent uploads for current job
- Tag a photo as "Ready for Social"
- Share a photo to a client (generates signed URL, copies to clipboard)

### Why a PWA vs. a native app

| Native app | PWA |
|---|---|
| App Store submission, review delays | Deploy in seconds |
| Separate codebases iOS + Android | One codebase |
| Updates require user opt-in | Always current |
| Camera access: full | Camera access: full (since 2019) |
| Push notifications: yes | Push notifications: yes (since 2023 on iOS) |
| Offline: yes | Offline: yes (service worker) |
| "Feels like a real app" | "Feels like a real app" (fullscreen, icon, splash) |

For this use case, zero compromise. For a public consumer app, native might still win — but for internal business tooling, PWA is the clear choice.

---

## 5. Migration from Google Drive — what happens to existing files

Session 7 includes a one-time migration step:

1. Worker reads the existing Drive folder structure via Drive API (one-time Google OAuth with a service account)
2. For each file in `Active Jobs` and `Completed Jobs`:
   - Download to Worker
   - Upload to R2 with generated key
   - Parse parent folder name to infer `job_id` + `category`
   - Insert into D1 `files` table
3. Progress displayed in dashboard during migration
4. Verify counts: "1,847 files migrated, 1,847 in D1, 0 errors"
5. Tony spot-checks a dozen files to confirm they're accessible
6. Drive folders are **not deleted** — they remain as a safety net. After 30 days of stable operation in R2, Tony can archive/delete Drive folders if he wants.

Migration runs in a background Queue so it doesn't block other hub usage.

---

## 6. Sharing files with clients

### Current state (Drive)

Tony generates a Drive sharing link, sets permissions (view-only), sends via email/text. Issues:
- Links are permanent (no auto-expiry)
- No view tracking
- Recipients occasionally need Google sign-in for "restricted" files
- Permissions management is clunky if you want to revoke later

### New state (R2 signed URLs)

- Tony clicks "Share" on a file (or a set)
- Picks expiration: 7 days / 30 days / 90 days
- Optional: recipient email (for audit, not required)
- Worker generates a signed URL (Cloudflare's R2 API), inserts into `file_shares` table
- URL copied to clipboard, Tony pastes wherever
- Recipient opens link, sees the file immediately (no sign-in)
- Dashboard shows: "Shared 3 days ago, viewed 7 times, last viewed yesterday 4:22 PM, expires in 4 days"
- Tony can revoke at any time ("Stop sharing" button → URL immediately dead)

This is a noticeable client-facing upgrade, not just an internal improvement. Shareable links with tracking signal professionalism.

---

## 7. Security + permissions (now and future)

### Now (single-user, Tony only)

- Tony logs into dashboard once, stays signed in 30 days
- Every API call requires session cookie
- R2 bucket is private (no public access) — all access via signed URLs
- Worker signs URLs with a short TTL (15 min for view, 24 hr for shares unless specified longer)

### Future (multi-user, 2+ employees)

Already in the schema (`users` table with `role` field):

| Role | Can upload | Can view all files | Can share externally | Can delete | Can push to Jobber |
|---|---|---|---|---|---|
| Owner (Tony) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Admin | ✓ | ✓ | ✓ | ✓ | ✓ |
| Office | ✓ | ✓ (not sensitive) | ✓ | limited | ✓ |
| Crew Lead | ✓ | own + current job | no | no | no |
| Crew | ✓ | current job | no | no | no |

Session 16 adds the role-based UI + API guards. Schema ready from Session 7.

---

## 8. What gets retired from the current setup

- Claude Cowork nightly sort job (entire Cowork workflow no longer needed for file management — Cowork stays available for other tasks)
- iPhone Shortcut uploading to Drive `_Incoming` (replaced by PWA camera)
- Manual Drive folder organization per job (created automatically via D1 `jobs` record)
- Manual Drive permissions when sharing files (replaced by signed URL with expiry)
- Tony's laptop as a dependency for nightly processing (Workers runs in the cloud)

---

## 9. Cost over time

| Files stored | R2 storage cost | R2 operations cost | Total/mo |
|---|---|---|---|
| 1,000 (~5 GB) | $0.08 | $0.00 (under free tier) | $0.08 |
| 10,000 (~50 GB) | $0.75 | ~$0.05 | $0.80 |
| 50,000 (~250 GB) | $3.75 | ~$0.25 | $4.00 |
| 200,000 (~1 TB) | $15 | ~$1 | $16 |

R2 has **zero egress fees** (this is R2's main differentiator vs S3). If Tony shares a file with 1,000 clients, no bandwidth cost.

Google Drive comparison: Workspace Business Standard is $12/user/month, so 5 employees = $720/year. At equivalent storage (2 TB pooled), it's technically cheaper per-user, but R2 doesn't care about user count and scales to any size for pennies.

---

## 10. Open questions — minimal

1. **When to cut over Drive → R2:** during Session 7 or as a separate session? Recommendation: during Session 7 for everything except already-complete jobs. Complete jobs can stay in Drive as archive (Tony rarely touches them) or bulk-migrate later.
2. **EXIF stripping for shared files:** phone photos have GPS coords, device info in EXIF. When sharing with clients, should the signed-URL view strip EXIF? Recommendation: yes, default to stripped; keep original in R2.
3. **Video size limits:** R2 has no per-file limit on paid tier, but uploads over 100 MB need multipart. PWA handles this transparently. Only constraint is cell-data for large video uploads — add a "Wifi only for >100MB" toggle in PWA settings.
4. **Backup strategy:** R2 is durable (99.999999999% — eleven 9s). But we should have a separate backup. Recommendation: weekly Worker cron that copies R2 to a second R2 bucket in a different region. Effectively free, runs unattended. Session 16.

---

## 11. Deliverable checkpoints during Session 7

So Tony can visualize progress mid-session:

- **30 min in:** R2 bucket exists, first test upload from browser succeeds
- **60 min in:** PWA installable on phone, camera opens, first real photo lands in R2
- **90 min in:** Dashboard file browser shows uploaded photos filtered by job
- **2 hrs in:** Share link works end-to-end (Tony texts himself a link, opens, sees photo)
- **2.5 hrs in:** Offline capture tested (airplane mode → take photo → reconnect → uploads)
- **End of session:** Drive migration initiated as background job (completes overnight)

Total session time estimate: 2-3 hrs. Migration runs unattended.
