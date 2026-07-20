# Session F Phase 2 — Cleanup Script Manifest

**Do not run as one transaction. Run one file at a time after reviewing preview COUNTs.**

DB rows only. Google Drive folders/files and R2 objects are **not** deleted.

Source of IDs: `/tmp/chs-session-f-inventory/INVENTORY.md`

## Run order

```bash
cd /Users/tonycolumbus/projects/chs-hub

npx wrangler d1 execute chs-hub-db --remote --file=scripts/session-f-cleanup/01-cleanup-jobs108-costplus-children.sql
npx wrangler d1 execute chs-hub-db --remote --file=scripts/session-f-cleanup/02-cleanup-fixedprice-jobs-children.sql
npx wrangler d1 execute chs-hub-db --remote --file=scripts/session-f-cleanup/03-cleanup-shared-documents-communications.sql
npx wrangler d1 execute chs-hub-db --remote --file=scripts/session-f-cleanup/04-cleanup-drive-mirror-folder-rows.sql
npx wrangler d1 execute chs-hub-db --remote --file=scripts/session-f-cleanup/05-cleanup-orphan-estimates.sql
npx wrangler d1 execute chs-hub-db --remote --file=scripts/session-f-cleanup/06-cleanup-jobs.sql
npx wrangler d1 execute chs-hub-db --remote --file=scripts/session-f-cleanup/07-cleanup-converted-estimates.sql
npx wrangler d1 execute chs-hub-db --remote --file=scripts/session-f-cleanup/08-cleanup-clients-properties-subs.sql
```

Optional: before each file, skim the leading `SELECT COUNT(*)` results in the wrangler output.

## Expected impact (Phase 1 inventory)

| # | File | Expected deletes (approx) |
|---|------|---------------------------|
| 01 | JOB-108 cost-plus children | billing_cycles **2**, invoices **3** (INV-003–005), payments (108 subset), expenses **6** + line items/receipts, punch_lists **3** + items **4** + tokens **3**, warranties **1**, EST-99011 schedules/selections, plus remaining JOB-108 job-scoped rows (tasks/photos/job_documents/…) |
| 02 | Fixed-price job children (100–107, 109–110) | billing_schedule (~most of **19**), tasks (~most of **13**), photos (~most of **10**), expenses **9**, invoices **2** (INV-001/002 void), payment_schedules for converted FP estimates, selections/choices, change_orders **1**, job_documents, daily_logs **2**, etc. |
| 03 | documents / communications / notification_logs | documents **~47**, communications **~71**, notification_logs **~79** |
| 04 | drive_mirror_folders | **~29** DB rows (Drive content untouched) |
| 05 | Orphan estimates | **11** estimates (99004, 99006, 99007, 99009, 99010, 99013, 99015–99019) + their schedules/selections/line items |
| 06 | Jobs | **11** jobs (JOB-100–110) |
| 07 | Converted estimates | **8** estimates (99001–99003, 99005, 99008, 99011, 99012, 99014) + remaining line items (~**27** total across all test estimates, split 05/07) |
| 08 | Clients / properties / subs | clients **2**, properties **2**, estimate_requests **9**, subcontractors **3** |

## Scope anchors

| Entity | IDs |
|--------|-----|
| ZZTEST client | `7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c` |
| Test Client | `79738377-b314-49bc-b273-eb550c49d682` |
| JOB-108 | `760c1458-3d76-48b9-8258-0d48fe611a1b` |
| Subs | `d930ec5f-…` (test), `9a020765-…` (Sub A), `89010754-…` (Sub B) |

## Safety notes

- Each DELETE is anchored to explicit UUIDs and/or `job_number` / `estimate_number` guards where parents are deleted.
- File 08 refuses to delete a client if jobs/estimates still reference it.
- No R2/`wrangler r2` / Drive API calls in any file.
