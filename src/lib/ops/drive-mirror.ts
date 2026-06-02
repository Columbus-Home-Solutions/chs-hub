/**
 * One-way D1 + R2 → Google Shared Drive mirror (insurance + human access).
 * Runs on the hourly cron; bounded batch size. Never blocks PWA uploads.
 *
 * Config (all optional; missing = skip with log):
 *   DRIVE_SHARED_DRIVE_ID, DRIVE_MIRROR_ROOT_FOLDER_ID
 *
 * Job-scoped paths (Hub Files–aligned):
 *   Jobs/<year>/<client>/<#N title>/
 *     SITE PHOTOS/Before|Progress|Final
 *     PROJECT FILES/Drawings & plans|Field notes|Contracts|…
 *   Job-linked expense receipts → PROJECT FILES/Project receipts.
 *   Example: `#99 Deck Railing`. Unassigned → …/Unassigned clients/…
 * Year from job start_at → created_at → synced_at (ISO).
 */

import type { Env } from "../../env.js";
import {
  getDriveAccessToken,
  getOrCreateFolder,
  guessMimeFromKey,
  uploadFileMultipart,
} from "../google/drive.js";

const BATCH_PHOTOS = 5;
const BATCH_EXPENSES = 5;
const BATCH_JOB_FILES = 5;
const BATCH_COMPANY = 5;
/** Sprint 15: documents (the unified Document Management table) mirror batch. */
const BATCH_DOCUMENTS = 5;
/** Max jobs per mirror run to pre-create SITE PHOTOS + PROJECT FILES trees. Keep low:
 * each stub triggers many Drive `fetch` calls; the cron also runs photo/expense/file/company batches. */
const BATCH_JOB_FOLDER_STUBS = 4;

const SITE_PHOTOS_ROOT = "SITE PHOTOS";
const PROJECT_FILES_ROOT = "PROJECT FILES";

const MIRROR_PHOTO_FOLDER: Record<string, string> = {
  before: "Before",
  progress: "Progress",
  final: "Final",
};

const MIRROR_JOB_FILE_FOLDER: Record<string, string> = {
  drawings: "Drawings & plans",
  notes: "Field notes",
  contracts: "Contracts",
  receipts: "Project receipts",
  pay_stub: "Sub / pay records",
  design: "Design & finishes",
  other: "Design & finishes",
};

/** Sprint 15: map a `documents.document_category` to the job PROJECT FILES
 * subfolder docType the mirror already knows (reuses ensureProjectFileLeafFolder). */
const DOC_CATEGORY_TO_DOCTYPE: Record<string, string> = {
  contract: "contracts",
  change_order: "contracts",
  lien_waiver: "contracts",
  permit: "design",
  plan_drawing: "drawings",
  invoice: "design",
  photo_report: "design",
  completion_package: "design",
  other: "other",
};

function mirrorPhotoCategoryKey(dbCategory: string | null | undefined): string {
  const c = (dbCategory || "progress").toLowerCase();
  if (c === "before" || c === "progress" || c === "final") return c;
  return "progress";
}

function mirrorJobFileSubfolderLabel(docType: string): string {
  return MIRROR_JOB_FILE_FOLDER[docType] ?? MIRROR_JOB_FILE_FOLDER.design;
}

/** Stable cache key under `j_<jobId>_pf_*` (legacy `other` → design). */
function mirrorJobFileCacheDocKey(docType: string): string {
  if (docType === "other") return "design";
  return MIRROR_JOB_FILE_FOLDER[docType] ? docType : "design";
}

export interface DriveMirrorResult {
  skipped: boolean;
  reason?: string;
  /** Newly ensured per-job folder trees: SITE PHOTOS + PROJECT FILES. */
  job_folder_stubs: number;
  photos: number;
  expenses: number;
  job_files: number;
  company: number;
  /** Sprint 15: rows mirrored from the unified `documents` table this cycle. */
  documents: number;
  errors: string[];
  duration_ms: number;
}

/** Same secret as other ops. Shows config + pending counts; does not upload. */
export interface DriveMirrorStatus {
  configured: boolean;
  reason?: string;
  has_service_account: boolean;
  drive_shared_drive_id: boolean;
  mirror_root_folder_id: boolean;
  /** Rows that match the mirror’s filters and are not yet marked mirrored */
  pending: {
    photos: number;
    expenses_with_receipt: number;
    job_files: number;
    company_documents: number;
    documents: number;
  };
  /** When all Drive vars are set, whether a Drive-scoped token can be minted */
  drive_token_ok: boolean | null;
  drive_token_error?: string;
  /** What this job copies (for operator expectations) */
  mirrors: readonly ["photos", "expense_receipts", "job_files", "company_documents", "documents"];
  /** `jobs` rows with no `stub_<id>` in `drive_mirror_folders` yet (folder tree not created in Drive). */
  jobs_without_drive_stub: number;
}

export async function getDriveMirrorStatus(env: Env): Promise<DriveMirrorStatus> {
  const hasServiceAccount = !!env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const driveId = env.DRIVE_SHARED_DRIVE_ID;
  const rootId = env.DRIVE_MIRROR_ROOT_FOLDER_ID;
  const configured = !!(hasServiceAccount && driveId && rootId);

  let reason: string | undefined;
  if (!hasServiceAccount) reason = "no GOOGLE_SERVICE_ACCOUNT_JSON";
  else if (!driveId || !rootId) {
    reason = "DRIVE_SHARED_DRIVE_ID or DRIVE_MIRROR_ROOT_FOLDER_ID unset";
  }

  const [ph, ex, jf, co, doc, stub] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as n FROM photos WHERE drive_mirrored_at IS NULL")
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) as n FROM expenses
       WHERE receipt_r2_key IS NOT NULL AND drive_mirrored_at IS NULL`,
    ).first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM job_files WHERE drive_mirrored_at IS NULL").first<{
      n: number;
    }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM company_documents WHERE drive_mirrored_at IS NULL").first<{
      n: number;
    }>(),
    env.DB.prepare(
      `SELECT COUNT(*) as n FROM documents
       WHERE COALESCE(is_active,1)=1 AND COALESCE(mirror_status,'pending') IN ('pending','failed')`,
    ).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) as n FROM jobs j
       WHERE NOT EXISTS (
         SELECT 1 FROM drive_mirror_folders f WHERE f.path_key = ('stub_' || j.id)
       )`,
    ).first<{ n: number }>(),
  ]);

  const pending = {
    photos: ph?.n ?? 0,
    expenses_with_receipt: ex?.n ?? 0,
    job_files: jf?.n ?? 0,
    company_documents: co?.n ?? 0,
    documents: doc?.n ?? 0,
  };

  const jobs_without_drive_stub = stub?.n ?? 0;

  let drive_token_ok: boolean | null = null;
  let drive_token_error: string | undefined;
  if (configured) {
    try {
      await getDriveAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON!);
      drive_token_ok = true;
    } catch (e) {
      drive_token_ok = false;
      drive_token_error = (e as Error).message;
    }
  }

  return {
    configured,
    reason: configured ? undefined : reason,
    has_service_account: hasServiceAccount,
    drive_shared_drive_id: !!driveId,
    mirror_root_folder_id: !!rootId,
    pending,
    drive_token_ok,
    drive_token_error,
    mirrors: ["photos", "expense_receipts", "job_files", "company_documents", "documents"] as const,
    jobs_without_drive_stub,
  };
}

export async function runDriveMirror(env: Env): Promise<DriveMirrorResult> {
  const t0 = Date.now();
  const out: DriveMirrorResult = {
    skipped: true,
    job_folder_stubs: 0,
    photos: 0,
    expenses: 0,
    job_files: 0,
    company: 0,
    documents: 0,
    errors: [],
    duration_ms: 0,
  };

  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    out.reason = "no GOOGLE_SERVICE_ACCOUNT_JSON";
    out.duration_ms = Date.now() - t0;
    return out;
  }
  const driveId = (env as Env & { DRIVE_SHARED_DRIVE_ID?: string }).DRIVE_SHARED_DRIVE_ID;
  const rootId = (env as Env & { DRIVE_MIRROR_ROOT_FOLDER_ID?: string })
    .DRIVE_MIRROR_ROOT_FOLDER_ID;
  if (!driveId || !rootId) {
    out.reason = "DRIVE_SHARED_DRIVE_ID or DRIVE_MIRROR_ROOT_FOLDER_ID unset";
    out.duration_ms = Date.now() - t0;
    return out;
  }

  out.skipped = false;
  let token: string;
  try {
    token = await getDriveAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    out.errors.push(`token: ${(e as Error).message}`);
    out.duration_ms = Date.now() - t0;
    return out;
  }

  try {
    const jobsRootId = await ensureFolderCached(env, token, driveId, rootId, "Jobs", "seg_Jobs");
    const photosId = await segmentFolderId(env, token, driveId, rootId, "Photos");
    const expensesId = await segmentFolderId(env, token, driveId, rootId, "Expenses");
    const companyRootId = await segmentFolderId(env, token, driveId, rootId, "Company");

    await mirrorJobFolderStubsBatch(env, token, driveId, jobsRootId, out);
    await mirrorPhotosBatch(env, token, driveId, photosId, jobsRootId, out);
    await mirrorExpensesBatch(env, token, driveId, expensesId, jobsRootId, out);
    await mirrorJobFilesBatch(env, token, driveId, jobsRootId, out);
    await mirrorCompanyBatch(env, token, driveId, companyRootId, out);
    await mirrorDocumentsBatch(env, token, driveId, jobsRootId, companyRootId, out);
  } catch (e) {
    out.errors.push((e as Error).message);
  }

  out.duration_ms = Date.now() - t0;
  return out;
}

async function ensureJobMirrorTreeStub(
  env: Env,
  token: string,
  driveId: string,
  jobsRootId: string,
  jobId: string,
  jobNumber: number | null,
  jobTitle: string | null,
  clientId: string | null,
  clientName: string | null,
  jobStartAt: string | null,
  jobCreatedAt: string | null,
  jobSyncedAt: string | null,
): Promise<void> {
  const stubKey = `stub_${jobId}`;
  const done = await env.DB.prepare("SELECT drive_folder_id FROM drive_mirror_folders WHERE path_key = ?")
    .bind(stubKey)
    .first<{ drive_folder_id: string }>();
  if (done?.drive_folder_id) return;

  const ctx = {
    jobStartAt,
    jobCreatedAt,
    jobSyncedAt,
  };
  const jobRootId = await ensureJobFolderId(
    env,
    token,
    driveId,
    jobsRootId,
    jobId,
    jobNumber,
    jobTitle,
    clientId,
    clientName,
    ctx,
  );

  const spRoot = await ensureFolderCached(
    env,
    token,
    driveId,
    jobRootId,
    SITE_PHOTOS_ROOT,
    `j_${jobId}_hub_sproot`,
  );
  for (const key of ["before", "progress", "final"] as const) {
    await ensureFolderCached(
      env,
      token,
      driveId,
      spRoot,
      MIRROR_PHOTO_FOLDER[key],
      `j_${jobId}_sp_${key}`,
    );
  }

  const pfRoot = await ensureFolderCached(
    env,
    token,
    driveId,
    jobRootId,
    PROJECT_FILES_ROOT,
    `j_${jobId}_hub_pfroot`,
  );
  for (const dt of ["drawings", "notes", "contracts", "receipts", "pay_stub", "design"] as const) {
    await ensureFolderCached(
      env,
      token,
      driveId,
      pfRoot,
      MIRROR_JOB_FILE_FOLDER[dt],
      `j_${jobId}_pf_${dt}`,
    );
  }

  await env.DB.prepare(
    "INSERT OR REPLACE INTO drive_mirror_folders (path_key, drive_folder_id) VALUES (?, ?)",
  )
    .bind(stubKey, jobRootId)
    .run();
}

async function mirrorJobFolderStubsBatch(
  env: Env,
  token: string,
  driveId: string,
  jobsRootId: string,
  out: DriveMirrorResult,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT j.id, j.job_number AS job_number, j.title AS job_title, j.client_id AS client_id,
            c.name AS client_name, j.start_at AS job_start_at, j.created_at AS job_created_at, j.synced_at AS job_synced_at
     FROM jobs j
     LEFT JOIN clients c ON c.id = j.client_id
     WHERE NOT EXISTS (
       SELECT 1 FROM drive_mirror_folders f WHERE f.path_key = ('stub_' || j.id)
     )
     ORDER BY datetime(COALESCE(j.created_at, j.synced_at)) DESC
     LIMIT ?`,
  )
    .bind(BATCH_JOB_FOLDER_STUBS)
    .all<{
      id: string;
      job_number: number | null;
      job_title: string | null;
      client_id: string | null;
      client_name: string | null;
      job_start_at: string | null;
      job_created_at: string | null;
      job_synced_at: string | null;
    }>();
  for (const r of rows.results ?? []) {
    try {
      await ensureJobMirrorTreeStub(
        env,
        token,
        driveId,
        jobsRootId,
        r.id,
        r.job_number,
        r.job_title,
        r.client_id,
        r.client_name,
        r.job_start_at,
        r.job_created_at,
        r.job_synced_at,
      );
      out.job_folder_stubs++;
    } catch (e) {
      out.errors.push(`job_stub ${r.id}: ${(e as Error).message}`);
    }
  }
}

async function ensureFolderCached(
  env: Env,
  token: string,
  driveId: string,
  parentId: string,
  folderName: string,
  pathKey: string,
): Promise<string> {
  const row = await env.DB.prepare("SELECT drive_folder_id FROM drive_mirror_folders WHERE path_key = ?")
    .bind(pathKey)
    .first<{ drive_folder_id: string }>();
  if (row?.drive_folder_id) return row.drive_folder_id;
  const id = await getOrCreateFolder({ token, driveId, parentId, name: folderName });
  await env.DB.prepare(
    "INSERT OR REPLACE INTO drive_mirror_folders (path_key, drive_folder_id) VALUES (?, ?)",
  )
    .bind(pathKey, id)
    .run();
  return id;
}

function jobCalendarYear(
  startAt: string | null | undefined,
  createdAt: string | null | undefined,
  syncedAt: string | null | undefined,
): string {
  const raw =
    (startAt && startAt.length >= 4 ? startAt : null)
    || (createdAt && createdAt.length >= 4 ? createdAt : null)
    || (syncedAt && syncedAt.length >= 4 ? syncedAt : null)
    || "";
  const y = raw.slice(0, 4);
  if (/^\d{4}$/.test(y)) return y;
  return String(new Date().getUTCFullYear());
}

/** Last alphanumeric run of an id — short disambiguator (not a full Jobber gid in the label). */
function shortTailId(rawId: string, len: number): string {
  const alnum = rawId.replace(/[^a-zA-Z0-9]/g, "");
  if (alnum.length >= len) return alnum.slice(-len);
  const stripped = rawId.replace(/[^a-zA-Z0-9]/g, "");
  if (stripped.length >= 1) return stripped.slice(-Math.min(len, stripped.length));
  return "id";
}

function clientFolderCacheKey(clientId: string | null | undefined): string {
  return clientId ? `client_${clientId}` : "client__none";
}

/** Remove ` (abcdef)` when it matches our short id tail (legacy folder labels / copy-paste). */
function stripTrailingClientTailSuffix(display: string, clientId: string): string {
  const t = shortTailId(clientId, 6);
  if (!t || t === "id") return display;
  const suf = ` (${t})`;
  if (display.endsWith(suf)) return display.slice(0, -suf.length).trimEnd();
  return display;
}

/** Folder under `<year>/` — Jobber client name only (same idea as Hub Files tree). */
function clientFolderDisplayName(
  clientId: string | null | undefined,
  clientName: string | null | undefined,
): string {
  if (!clientId) return "Unassigned clients";
  let human = (clientName ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s.'&-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 88);
  human = stripTrailingClientTailSuffix(human, clientId);
  if (!human) return "Unknown client";
  return human;
}

/**
 * Folder under `<client>/` — `#99 Deck Railing` when number + title exist; else `#99`, else title + tail.
 * Cached under `job_<jobId>`.
 */
function jobSubfolderLabel(jobNumber: number | null, jobId: string, title: string | null | undefined): string {
  const rawTitle = (title ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s.'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 82);
  const hasNum = jobNumber != null && Number.isFinite(jobNumber);
  const tail = shortTailId(jobId, 6);
  if (hasNum && rawTitle) return `#${Math.trunc(jobNumber)} ${rawTitle}`.slice(0, 100);
  if (hasNum) return `#${Math.trunc(jobNumber)}`.slice(0, 100);
  if (rawTitle) return `${rawTitle} (${tail})`.slice(0, 100);
  return `Job ${tail}`.slice(0, 100);
}

type JobFolderDates = {
  jobStartAt: string | null | undefined;
  jobCreatedAt: string | null | undefined;
  jobSyncedAt: string | null | undefined;
};

async function ensureJobFolderId(
  env: Env,
  token: string,
  driveId: string,
  jobsRootId: string,
  jobId: string,
  jobNumber: number | null,
  jobTitle: string | null | undefined,
  clientId: string | null | undefined,
  clientName: string | null | undefined,
  dates: JobFolderDates,
): Promise<string> {
  const jobYear = jobCalendarYear(dates.jobStartAt, dates.jobCreatedAt, dates.jobSyncedAt);
  const yearKey = `yr_${jobYear}`;
  const yearFolderId = await ensureFolderCached(env, token, driveId, jobsRootId, jobYear, yearKey);

  const cKey = clientFolderCacheKey(clientId);
  const clientLabel = clientFolderDisplayName(clientId, clientName);
  const underYearKey = `yc_${jobYear}_${cKey}`;
  const clientFolderId = await ensureFolderCached(env, token, driveId, yearFolderId, clientLabel, underYearKey);

  const jobLabel = jobSubfolderLabel(jobNumber, jobId, jobTitle);
  const jobKey = `job_${jobId}`;
  return ensureFolderCached(env, token, driveId, clientFolderId, jobLabel, jobKey);
}

async function ensureSitePhotoLeafFolder(
  env: Env,
  token: string,
  driveId: string,
  jobRootId: string,
  jobId: string,
  categoryKey: string,
): Promise<string> {
  const spRoot = await ensureFolderCached(
    env,
    token,
    driveId,
    jobRootId,
    SITE_PHOTOS_ROOT,
    `j_${jobId}_hub_sproot`,
  );
  const ck = mirrorPhotoCategoryKey(categoryKey);
  const label = MIRROR_PHOTO_FOLDER[ck] ?? "Progress";
  return ensureFolderCached(env, token, driveId, spRoot, label, `j_${jobId}_sp_${ck}`);
}

async function ensureProjectFileLeafFolder(
  env: Env,
  token: string,
  driveId: string,
  jobRootId: string,
  jobId: string,
  docType: string,
): Promise<string> {
  const pfRoot = await ensureFolderCached(
    env,
    token,
    driveId,
    jobRootId,
    PROJECT_FILES_ROOT,
    `j_${jobId}_hub_pfroot`,
  );
  const cacheK = mirrorJobFileCacheDocKey(docType);
  const label = mirrorJobFileSubfolderLabel(docType);
  return ensureFolderCached(env, token, driveId, pfRoot, label, `j_${jobId}_pf_${cacheK}`);
}

async function segmentFolderId(
  env: Env,
  token: string,
  driveId: string,
  rootId: string,
  segment: "Photos" | "Expenses" | "Company",
): Promise<string> {
  return ensureFolderCached(env, token, driveId, rootId, segment, `seg_${segment}`);
}

async function docTypeFolderId(
  env: Env,
  token: string,
  driveId: string,
  companyRootId: string,
  docType: string,
): Promise<string> {
  const pathKey = `co_${docType}`;
  const row = await env.DB.prepare("SELECT drive_folder_id FROM drive_mirror_folders WHERE path_key = ?")
    .bind(pathKey)
    .first<{ drive_folder_id: string }>();
  if (row?.drive_folder_id) return row.drive_folder_id;
  const id = await getOrCreateFolder({ token, driveId, parentId: companyRootId, name: docType });
  await env.DB.prepare(
    "INSERT OR REPLACE INTO drive_mirror_folders (path_key, drive_folder_id) VALUES (?, ?)",
  )
    .bind(pathKey, id)
    .run();
  return id;
}

async function mirrorPhotosBatch(
  env: Env,
  token: string,
  driveId: string,
  flatPhotosParentId: string,
  jobsRootId: string,
  out: DriveMirrorResult,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.r2_key, p.job_id, p.category, p.created_at, j.job_number AS job_number, j.title AS job_title,
            j.client_id AS client_id, c.name AS client_name,
            j.start_at AS job_start_at, j.created_at AS job_created_at, j.synced_at AS job_synced_at
     FROM photos p
     LEFT JOIN jobs j ON j.id = p.job_id
     LEFT JOIN clients c ON c.id = j.client_id
     WHERE p.drive_mirrored_at IS NULL
     ORDER BY datetime(p.created_at) ASC
     LIMIT ?`,
  )
    .bind(BATCH_PHOTOS)
    .all<{
      id: string;
      r2_key: string;
      job_id: string | null;
      category: string;
      created_at: string;
      job_number: number | null;
      job_title: string | null;
      client_id: string | null;
      client_name: string | null;
      job_start_at: string | null;
      job_created_at: string | null;
      job_synced_at: string | null;
    }>();
  for (const r of rows.results ?? []) {
    try {
      const obj = await env.FILES.get(r.r2_key);
      if (!obj) {
        out.errors.push(`photo ${r.id}: missing R2 ${r.r2_key}`);
        continue;
      }
      const buf = await obj.arrayBuffer();
      const jobSeg = (r.job_id ?? "general").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64);
      const day = (r.created_at || "").slice(0, 10) || "unknown";
      const name = `photo_${jobSeg}_${day}_${r.id}.jpg`;
      const mime = obj.httpMetadata?.contentType || guessMimeFromKey(r.r2_key);
      const dates = {
        jobStartAt: r.job_start_at,
        jobCreatedAt: r.job_created_at,
        jobSyncedAt: r.job_synced_at,
      };
      let parentId: string;
      if (r.job_id) {
        const jobRootId = await ensureJobFolderId(
          env,
          token,
          driveId,
          jobsRootId,
          r.job_id,
          r.job_number,
          r.job_title,
          r.client_id,
          r.client_name,
          dates,
        );
        parentId = await ensureSitePhotoLeafFolder(env, token, driveId, jobRootId, r.job_id, r.category);
      } else {
        parentId = flatPhotosParentId;
      }
      await uploadFileMultipart({
        token,
        name,
        parents: [parentId],
        body: buf,
        mimeType: mime || "image/jpeg",
      });
      const now = new Date().toISOString();
      await env.DB.prepare("UPDATE photos SET drive_mirrored_at = ? WHERE id = ?")
        .bind(now, r.id)
        .run();
      out.photos++;
    } catch (e) {
      out.errors.push(`photo ${r.id}: ${(e as Error).message}`);
    }
  }
}

async function mirrorExpensesBatch(
  env: Env,
  token: string,
  driveId: string,
  flatExpensesParentId: string,
  jobsRootId: string,
  out: DriveMirrorResult,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT e.id, e.receipt_r2_key, e.job_id, j.job_number AS job_number, j.title AS job_title,
            j.client_id AS client_id, c.name AS client_name,
            j.start_at AS job_start_at, j.created_at AS job_created_at, j.synced_at AS job_synced_at
     FROM expenses e
     LEFT JOIN jobs j ON j.id = e.job_id
     LEFT JOIN clients c ON c.id = j.client_id
     WHERE e.receipt_r2_key IS NOT NULL
       AND e.drive_mirrored_at IS NULL
     ORDER BY COALESCE(e.incurred_at, e.synced_at) ASC, e.id ASC
     LIMIT ?`,
  )
    .bind(BATCH_EXPENSES)
    .all<{
      id: string;
      receipt_r2_key: string;
      job_id: string | null;
      job_number: number | null;
      job_title: string | null;
      client_id: string | null;
      client_name: string | null;
      job_start_at: string | null;
      job_created_at: string | null;
      job_synced_at: string | null;
    }>();
  for (const r of rows.results ?? []) {
    try {
      const obj = await env.FILES.get(r.receipt_r2_key);
      if (!obj) {
        out.errors.push(`expense ${r.id}: missing R2 ${r.receipt_r2_key}`);
        continue;
      }
      const buf = await obj.arrayBuffer();
      const ext = r.receipt_r2_key.split(".").pop() || "jpg";
      const name = `receipt_${r.id}.${ext}`;
      const mime = obj.httpMetadata?.contentType || guessMimeFromKey(r.receipt_r2_key);
      const dates = {
        jobStartAt: r.job_start_at,
        jobCreatedAt: r.job_created_at,
        jobSyncedAt: r.job_synced_at,
      };
      let parentId: string;
      if (r.job_id) {
        const jobRootId = await ensureJobFolderId(
          env,
          token,
          driveId,
          jobsRootId,
          r.job_id,
          r.job_number,
          r.job_title,
          r.client_id,
          r.client_name,
          dates,
        );
        parentId = await ensureProjectFileLeafFolder(env, token, driveId, jobRootId, r.job_id, "receipts");
      } else {
        parentId = flatExpensesParentId;
      }
      await uploadFileMultipart({
        token,
        name,
        parents: [parentId],
        body: buf,
        mimeType: mime || "image/jpeg",
      });
      const now = new Date().toISOString();
      await env.DB.prepare("UPDATE expenses SET drive_mirrored_at = ? WHERE id = ?")
        .bind(now, r.id)
        .run();
      out.expenses++;
    } catch (e) {
      out.errors.push(`expense ${r.id}: ${(e as Error).message}`);
    }
  }
}

async function mirrorJobFilesBatch(
  env: Env,
  token: string,
  driveId: string,
  jobsRootId: string,
  out: DriveMirrorResult,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT jf.id, jf.r2_key, jf.filename, jf.doc_type, jf.mime_type, jf.job_id,
            j.job_number AS job_number, j.title AS job_title,
            j.client_id AS client_id, c.name AS client_name,
            j.start_at AS job_start_at, j.created_at AS job_created_at, j.synced_at AS job_synced_at
     FROM job_files jf
     INNER JOIN jobs j ON j.id = jf.job_id
     LEFT JOIN clients c ON c.id = j.client_id
     WHERE jf.drive_mirrored_at IS NULL
     ORDER BY datetime(jf.created_at) ASC
     LIMIT ?`,
  )
    .bind(BATCH_JOB_FILES)
    .all<{
      id: string;
      r2_key: string;
      filename: string;
      doc_type: string;
      mime_type: string;
      job_id: string;
      job_number: number | null;
      job_title: string | null;
      client_id: string | null;
      client_name: string | null;
      job_start_at: string | null;
      job_created_at: string | null;
      job_synced_at: string | null;
    }>();
  for (const r of rows.results ?? []) {
    try {
      const obj = await env.FILES.get(r.r2_key);
      if (!obj) {
        out.errors.push(`job_file ${r.id}: missing R2 ${r.r2_key}`);
        continue;
      }
      const buf = await obj.arrayBuffer();
      const jobRootId = await ensureJobFolderId(
        env,
        token,
        driveId,
        jobsRootId,
        r.job_id,
        r.job_number,
        r.job_title,
        r.client_id,
        r.client_name,
        {
          jobStartAt: r.job_start_at,
          jobCreatedAt: r.job_created_at,
          jobSyncedAt: r.job_synced_at,
        },
      );
      const parentId = await ensureProjectFileLeafFolder(
        env,
        token,
        driveId,
        jobRootId,
        r.job_id,
        r.doc_type,
      );
      const safe = r.filename.replace(/[\\/]/g, "_").slice(0, 200);
      const name = `${r.doc_type}_${r.id}__${safe || "file"}`;
      const mime = obj.httpMetadata?.contentType || r.mime_type || guessMimeFromKey(r.r2_key);
      await uploadFileMultipart({
        token,
        name,
        parents: [parentId],
        body: buf,
        mimeType: mime || "application/octet-stream",
      });
      const now = new Date().toISOString();
      await env.DB.prepare("UPDATE job_files SET drive_mirrored_at = ? WHERE id = ?")
        .bind(now, r.id)
        .run();
      out.job_files++;
    } catch (e) {
      out.errors.push(`job_file ${r.id}: ${(e as Error).message}`);
    }
  }
}

async function mirrorCompanyBatch(
  env: Env,
  token: string,
  driveId: string,
  companyRootId: string,
  out: DriveMirrorResult,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, title, filename, r2_key, doc_type
     FROM company_documents
     WHERE drive_mirrored_at IS NULL
     ORDER BY datetime(created_at) ASC
     LIMIT ?`,
  )
    .bind(BATCH_COMPANY)
    .all<{
      id: string;
      title: string;
      filename: string;
      r2_key: string;
      doc_type: string;
    }>();
  for (const r of rows.results ?? []) {
    try {
      const obj = await env.FILES.get(r.r2_key);
      if (!obj) {
        out.errors.push(`company ${r.id}: missing R2 ${r.r2_key}`);
        continue;
      }
      const buf = await obj.arrayBuffer();
      const typeFolder = await docTypeFolderId(env, token, driveId, companyRootId, r.doc_type);
      const safe = r.filename.replace(/[\\/]/g, "_").slice(0, 200);
      const name = `company_${r.id}__${safe || "file"}`;
      const mime = obj.httpMetadata?.contentType || guessMimeFromKey(r.r2_key);
      await uploadFileMultipart({
        token,
        name,
        parents: [typeFolder],
        body: buf,
        mimeType: mime || "application/octet-stream",
      });
      const now = new Date().toISOString();
      await env.DB.prepare("UPDATE company_documents SET drive_mirrored_at = ? WHERE id = ?")
        .bind(now, r.id)
        .run();
      out.company++;
    } catch (e) {
      out.errors.push(`company ${r.id}: ${(e as Error).message}`);
    }
  }
}

/**
 * Sprint 15 — mirror the unified `documents` table. Picks up rows whose
 * mirror_status is pending OR failed (best-effort retry next cycle, business
 * rule 2), copies R2 → Drive, stamps google_drive_id/url + mirror_date and
 * flips mirror_status to 'synced'. On error → 'failed' (re-tried next run).
 * Job-context docs land in the job's PROJECT FILES tree (reusing the existing
 * folder cache); company docs go under the flat Company segment. R2 + D1 stay
 * canonical. Runs inside the SAME hourly 15 * * * handler — NO new cron.
 */
async function mirrorDocumentsBatch(
  env: Env,
  token: string,
  driveId: string,
  jobsRootId: string,
  companyRootId: string,
  out: DriveMirrorResult,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT d.id, d.r2_key, d.file_type, d.title, d.context_type, d.document_category, d.job_id,
            j.job_number AS job_number, j.title AS job_title, j.client_id AS client_id,
            c.name AS client_name, j.start_at AS job_start_at, j.created_at AS job_created_at,
            j.synced_at AS job_synced_at
       FROM documents d
       LEFT JOIN jobs j ON j.id = d.job_id
       LEFT JOIN clients c ON c.id = j.client_id
      WHERE COALESCE(d.is_active,1)=1
        AND COALESCE(d.mirror_status,'pending') IN ('pending','failed')
      ORDER BY datetime(d.created_at) ASC
      LIMIT ?`,
  )
    .bind(BATCH_DOCUMENTS)
    .all<{
      id: string;
      r2_key: string;
      file_type: string | null;
      title: string;
      context_type: string;
      document_category: string;
      job_id: string | null;
      job_number: number | null;
      job_title: string | null;
      client_id: string | null;
      client_name: string | null;
      job_start_at: string | null;
      job_created_at: string | null;
      job_synced_at: string | null;
    }>();
  for (const r of rows.results ?? []) {
    try {
      const obj = await env.FILES.get(r.r2_key);
      if (!obj) {
        // No bytes to mirror — mark failed so it isn't retried forever-fast.
        await env.DB.prepare("UPDATE documents SET mirror_status='failed' WHERE id = ?").bind(r.id).run();
        out.errors.push(`document ${r.id}: missing R2 ${r.r2_key}`);
        continue;
      }
      const buf = await obj.arrayBuffer();
      let parentId: string;
      if (r.job_id) {
        const jobRootId = await ensureJobFolderId(
          env,
          token,
          driveId,
          jobsRootId,
          r.job_id,
          r.job_number,
          r.job_title,
          r.client_id,
          r.client_name,
          { jobStartAt: r.job_start_at, jobCreatedAt: r.job_created_at, jobSyncedAt: r.job_synced_at },
        );
        const docType = DOC_CATEGORY_TO_DOCTYPE[r.document_category] ?? "other";
        parentId = await ensureProjectFileLeafFolder(env, token, driveId, jobRootId, r.job_id, docType);
      } else {
        parentId = await docTypeFolderId(env, token, driveId, companyRootId, r.document_category || "other");
      }
      const safe = r.title.replace(/[\\/]/g, "_").slice(0, 200);
      const name = `doc_${r.id}__${safe || "document"}`;
      const mime = obj.httpMetadata?.contentType || r.file_type || guessMimeFromKey(r.r2_key);
      const driveFileId = await uploadFileMultipart({
        token,
        name,
        parents: [parentId],
        body: buf,
        mimeType: mime || "application/octet-stream",
      });
      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE documents
            SET mirror_status='synced', mirror_date=?, google_drive_id=?,
                google_drive_url=?
          WHERE id = ?`,
      )
        .bind(now, driveFileId, `https://drive.google.com/file/d/${driveFileId}/view`, r.id)
        .run();
      out.documents++;
    } catch (e) {
      await env.DB.prepare("UPDATE documents SET mirror_status='failed' WHERE id = ?")
        .bind(r.id)
        .run()
        .catch(() => undefined);
      out.errors.push(`document ${r.id}: ${(e as Error).message}`);
    }
  }
}
