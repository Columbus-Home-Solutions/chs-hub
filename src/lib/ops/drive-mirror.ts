/**
 * One-way D1 + R2 → Google Shared Drive mirror (insurance + human access).
 * Runs on the hourly cron; bounded batch size. Never blocks PWA uploads.
 *
 * Target drive: "CHS Hub Backup" (Shared Drive — DRIVE_SHARED_DRIVE_ID).
 * DRIVE_MIRROR_ROOT_FOLDER_ID is no longer used; year folders live directly
 * at the drive root (parentId = driveId itself).
 *
 * Folder structure:
 *   CHS Hub Backup/  (Shared Drive root, ID in DRIVE_SHARED_DRIVE_ID)
 *   ├── {year}/                                ← anchored to earliest estimate_request.created_at for client
 *   │   └── {Last, First} — {clientId[:8]}/   ← lazy per client
 *   │       ├── Estimates/                      ← pre-job docs (client_id, no job_id)
 *   │       └── {address or #N}/               ← lazy per job
 *   │           ├── Contracts & Signed Docs/
 *   │           ├── Change Orders/
 *   │           ├── Permits/
 *   │           ├── Photos/
 *   │           ├── Invoices & Payments/
 *   │           ├── Completion Package/
 *   │           └── Other/                     ← lazy, only when needed
 *   └── Company Documents/                     ← hardcoded IDs, already exists
 *       ├── Licenses & Insurance/
 *       ├── SOPs/
 *       └── Templates/
 *
 * Year anchor:   MIN(estimate_requests.created_at) WHERE client_id = ?
 * Folder cache:  drive_mirror_folders (path_key → drive_folder_id), v2_ prefix.
 * On failure:    mirror_status='failed' on documents; retried next cycle.
 *                photos/expenses/job_files retain NULL drive_mirrored_at; retried.
 * Canonical:     R2 + D1 stay canonical regardless of mirror state.
 */

import type { Env } from "../../env.js";
import {
  getDriveAccessToken,
  getOrCreateFolder,
  guessMimeFromKey,
  uploadFileMultipart,
  verifyDriveAccess,
} from "../google/drive.js";

// ─── CHS Hub Backup — fixed folder IDs (hardcoded; created manually by Tony) ─
const COMPANY_DOCS_ROOT = "1rzUnoOSMLVlWQClOmZJ5gG1ZngrpIDSV";
const COMPANY_LICENSES_AND_INSURANCE = "1kstPZhRtv89wcHR_0pVgkNeEv3RKGg5x";
const COMPANY_SOPS = "10pclierBe9c96iI2Mg41noqX8X0OiD2A";
const COMPANY_TEMPLATES = "1gPB3IYv-MK0sZ7ILYOYj7tdZdUCPh1Ta";

// ─── document_category → job subfolder label ──────────────────────────────
const JOB_CATEGORY_SUBFOLDER: Record<string, string> = {
  contract: "Contracts & Signed Docs",
  change_order: "Change Orders",
  permit: "Permits",
  photo_report: "Photos",
  invoice: "Invoices & Payments",
  completion_package: "Completion Package",
};

// job_files.doc_type → document_category equivalent for subfolder routing
const JOB_FILE_CATEGORY: Record<string, string> = {
  contracts: "contract",
  pay_stub: "contract",
  receipts: "invoice",
  drawings: "other",
  notes: "other",
  design: "other",
  other: "other",
};

const BATCH = 5;

// ─── Public types ─────────────────────────────────────────────────────────

export interface DriveMirrorResult {
  skipped: boolean;
  reason?: string;
  /** Kept for API compat — unused in v2 structure (no pre-created job stubs). */
  job_folder_stubs: number;
  photos: number;
  expenses: number;
  job_files: number;
  company: number;
  documents: number;
  errors: string[];
  duration_ms: number;
}

export interface DriveMirrorStatus {
  configured: boolean;
  reason?: string;
  has_service_account: boolean;
  drive_shared_drive_id: boolean;
  /** Always false in v2 — year folders live at drive root; no separate root folder. */
  mirror_root_folder_id: boolean;
  pending: {
    photos: number;
    expenses_with_receipt: number;
    job_files: number;
    company_documents: number;
    documents: number;
  };
  drive_token_ok: boolean | null;
  drive_token_error?: string;
  mirrors: readonly ["photos", "expense_receipts", "job_files", "company_documents", "documents"];
  /** Always 0 in v2 — no pre-created job stubs. */
  jobs_without_drive_stub: number;
}

// ─── Status endpoint ──────────────────────────────────────────────────────

export async function getDriveMirrorStatus(env: Env): Promise<DriveMirrorStatus> {
  const hasServiceAccount = !!env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const driveId = env.DRIVE_SHARED_DRIVE_ID;
  const configured = !!(hasServiceAccount && driveId);

  let reason: string | undefined;
  if (!hasServiceAccount) reason = "no GOOGLE_SERVICE_ACCOUNT_JSON";
  else if (!driveId) reason = "DRIVE_SHARED_DRIVE_ID unset";

  const [ph, ex, jf, co, doc] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as n FROM photos WHERE drive_mirrored_at IS NULL")
      .first<{ n: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) as n FROM expenses WHERE receipt_r2_key IS NOT NULL AND drive_mirrored_at IS NULL",
    ).first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM job_files WHERE drive_mirrored_at IS NULL")
      .first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM company_documents WHERE drive_mirrored_at IS NULL")
      .first<{ n: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) as n FROM documents WHERE COALESCE(is_active,1)=1 AND COALESCE(mirror_status,'pending') IN ('pending','failed')",
    ).first<{ n: number }>(),
  ]);

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
    mirror_root_folder_id: false,
    pending: {
      photos: ph?.n ?? 0,
      expenses_with_receipt: ex?.n ?? 0,
      job_files: jf?.n ?? 0,
      company_documents: co?.n ?? 0,
      documents: doc?.n ?? 0,
    },
    drive_token_ok,
    drive_token_error,
    mirrors: ["photos", "expense_receipts", "job_files", "company_documents", "documents"] as const,
    jobs_without_drive_stub: 0,
  };
}

// ─── Main run ─────────────────────────────────────────────────────────────

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
  const driveId = env.DRIVE_SHARED_DRIVE_ID;
  if (!driveId) {
    out.reason = "DRIVE_SHARED_DRIVE_ID unset";
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

  // Preflight: verify the service account can actually access the Shared Drive.
  // This surfaces a clear error (e.g. service account not yet added to the drive)
  // instead of silently failing per item with cryptic 403s.
  try {
    await verifyDriveAccess(token, driveId);
  } catch (e) {
    out.errors.push(`preflight: ${(e as Error).message}`);
    out.skipped = true;
    out.reason = `Drive access check failed — ${(e as Error).message.slice(0, 120)}`;
    out.duration_ms = Date.now() - t0;
    return out;
  }

  try {
    await mirrorDocumentsBatch(env, token, driveId, out);
    await mirrorPhotosBatch(env, token, driveId, out);
    await mirrorJobFilesBatch(env, token, driveId, out);
    await mirrorExpensesBatch(env, token, driveId, out);
    await mirrorCompanyBatch(env, token, driveId, out);
  } catch (e) {
    out.errors.push((e as Error).message);
  }

  out.duration_ms = Date.now() - t0;
  return out;
}

// ─── Folder cache ─────────────────────────────────────────────────────────

async function ensureFolderCached(
  env: Env,
  token: string,
  driveId: string,
  parentId: string,
  folderName: string,
  pathKey: string,
): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT drive_folder_id FROM drive_mirror_folders WHERE path_key = ?",
  )
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

// ─── Label helpers ────────────────────────────────────────────────────────

function sanitizeName(raw: string, maxLen: number): string {
  return (raw || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s.,'\-#&]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** "{Last, First} — {first 8 alphanum chars of clientId}" */
function clientFolderLabel(
  lastName: string | null | undefined,
  firstName: string | null | undefined,
  fullName: string | null | undefined,
  clientId: string,
): string {
  const id8 = clientId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || clientId.slice(0, 8);
  const last = sanitizeName(lastName || "", 60);
  const first = sanitizeName(firstName || "", 40);
  let name: string;
  if (last || first) {
    name = last && first ? `${last}, ${first}` : last || first;
  } else {
    const full = sanitizeName(fullName || "", 80);
    if (full) {
      // Best-effort "First Last" → "Last, First" split
      const parts = full.split(/\s+/);
      name =
        parts.length >= 2
          ? `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(" ")}`
          : full;
    } else {
      name = "Unknown";
    }
  }
  return `${name.slice(0, 80)} — ${id8}`;
}

/** Address street (no city/state), or "#N", or "Job {tail}". */
function jobFolderLabel(
  jobId: string,
  address: string | null | undefined,
  jobNumber: number | null | undefined,
): string {
  if (address?.trim()) {
    const street = sanitizeName(address.split(",")[0], 80);
    if (street) return street;
  }
  if (jobNumber != null && Number.isFinite(jobNumber)) return `#${Math.trunc(jobNumber)}`;
  const tail = jobId.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "unknown";
  return `Job ${tail}`;
}

/** Parse year from ISO date string; fall back to current UTC year. */
function parseYear(
  anchor: string | null | undefined,
  fallback: string | null | undefined,
): string {
  for (const raw of [anchor, fallback]) {
    if (raw && raw.length >= 4) {
      const y = raw.slice(0, 4);
      if (/^\d{4}$/.test(y)) return y;
    }
  }
  return String(new Date().getUTCFullYear());
}

/** Map document_category (or doc_type) to the Company Documents child folder ID. */
function companyFolderId(category: string): string {
  const c = (category || "").toLowerCase();
  if (c === "license" || c === "insurance") return COMPANY_LICENSES_AND_INSURANCE;
  if (c === "sop") return COMPANY_SOPS;
  if (c === "template") return COMPANY_TEMPLATES;
  return COMPANY_DOCS_ROOT;
}

// ─── Folder resolution ────────────────────────────────────────────────────

/** Year folder — lives directly at the Shared Drive root (parentId = driveId). */
async function ensureYearFolder(
  env: Env,
  token: string,
  driveId: string,
  year: string,
): Promise<string> {
  return ensureFolderCached(env, token, driveId, driveId, year, `v2_yr_${year}`);
}

/** Client folder — "{Last, First} — {id8}" under the year folder. */
async function ensureClientFolder(
  env: Env,
  token: string,
  driveId: string,
  clientId: string,
  year: string,
  lastName: string | null,
  firstName: string | null,
  fullName: string | null,
): Promise<string> {
  const yearFolderId = await ensureYearFolder(env, token, driveId, year);
  const label = clientFolderLabel(lastName, firstName, fullName, clientId);
  return ensureFolderCached(env, token, driveId, yearFolderId, label, `v2_cl_${year}_${clientId}`);
}

/** "Estimates" subfolder under a client folder — for pre-job documents. */
async function ensureEstimatesFolder(
  env: Env,
  token: string,
  driveId: string,
  clientFolderId: string,
  clientId: string,
  year: string,
): Promise<string> {
  return ensureFolderCached(
    env,
    token,
    driveId,
    clientFolderId,
    "Estimates",
    `v2_est_${year}_${clientId}`,
  );
}

/** Job folder — "{address or #N}" — under the client folder. */
async function ensureJobFolder(
  env: Env,
  token: string,
  driveId: string,
  clientFolderId: string,
  jobId: string,
  jobNumber: number | null,
  address: string | null,
): Promise<string> {
  const label = jobFolderLabel(jobId, address, jobNumber);
  return ensureFolderCached(env, token, driveId, clientFolderId, label, `v2_job_${jobId}`);
}

/** Category subfolder under a job folder — lazy, created on first use. */
async function ensureJobCategoryFolder(
  env: Env,
  token: string,
  driveId: string,
  jobFolderId: string,
  jobId: string,
  category: string,
): Promise<string> {
  const label = JOB_CATEGORY_SUBFOLDER[category] ?? "Other";
  const cacheKey = JOB_CATEGORY_SUBFOLDER[category] ? category : "other";
  return ensureFolderCached(
    env,
    token,
    driveId,
    jobFolderId,
    label,
    `v2_jcat_${jobId}_${cacheKey}`,
  );
}

// ─── Shared parent resolver ───────────────────────────────────────────────

type FileContext = {
  clientId: string | null;
  lastName: string | null;
  firstName: string | null;
  fullName: string | null;
  jobId: string | null;
  jobNumber: number | null;
  address: string | null;
  yearAnchor: string | null;
  fallbackDate: string | null;
};

/**
 * Resolve the Drive parent folder for a job- or client-scoped file.
 * - company context → handled separately (hardcoded IDs, don't call this)
 * - job_id present → year/client/job/category subfolder
 * - client_id only (no job) → year/client/Estimates
 * - neither → Company Documents root (safety valve for orphans)
 */
async function resolveParentFolder(
  env: Env,
  token: string,
  driveId: string,
  ctx: FileContext,
  category: string,
): Promise<string> {
  if (!ctx.clientId) return COMPANY_DOCS_ROOT;

  const year = parseYear(ctx.yearAnchor, ctx.fallbackDate);
  const clientFolderId = await ensureClientFolder(
    env,
    token,
    driveId,
    ctx.clientId,
    year,
    ctx.lastName,
    ctx.firstName,
    ctx.fullName,
  );

  if (!ctx.jobId) {
    return ensureEstimatesFolder(env, token, driveId, clientFolderId, ctx.clientId, year);
  }

  const jobFolderId = await ensureJobFolder(
    env,
    token,
    driveId,
    clientFolderId,
    ctx.jobId,
    ctx.jobNumber,
    ctx.address,
  );
  return ensureJobCategoryFolder(env, token, driveId, jobFolderId, ctx.jobId, category);
}

// ─── Mirror batches ───────────────────────────────────────────────────────

async function mirrorDocumentsBatch(
  env: Env,
  token: string,
  driveId: string,
  out: DriveMirrorResult,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT d.id, d.r2_key, d.file_type, d.title, d.context_type, d.document_category,
            d.job_id, COALESCE(d.client_id, j.client_id) AS client_id,
            j.job_number,
            (SELECT property_address FROM estimate_requests WHERE converted_job_id = j.id LIMIT 1) AS address,
            c.last_name, c.first_name, c.name AS client_name,
            (SELECT MIN(er.created_at) FROM estimate_requests er
             WHERE er.client_id = COALESCE(d.client_id, j.client_id)) AS year_anchor,
            d.created_at AS fallback_date
       FROM documents d
       LEFT JOIN jobs j ON j.id = d.job_id
       LEFT JOIN clients c ON c.id = COALESCE(d.client_id, j.client_id)
      WHERE COALESCE(d.is_active,1) = 1
        AND COALESCE(d.mirror_status,'pending') IN ('pending','failed')
      ORDER BY datetime(d.created_at) ASC
      LIMIT ?`,
  )
    .bind(BATCH)
    .all<{
      id: string;
      r2_key: string;
      file_type: string | null;
      title: string;
      context_type: string;
      document_category: string;
      job_id: string | null;
      client_id: string | null;
      job_number: number | null;
      address: string | null;
      last_name: string | null;
      first_name: string | null;
      client_name: string | null;
      year_anchor: string | null;
      fallback_date: string;
    }>();

  for (const r of rows.results ?? []) {
    try {
      const obj = await env.FILES.get(r.r2_key);
      if (!obj) {
        await env.DB.prepare("UPDATE documents SET mirror_status='failed' WHERE id = ?")
          .bind(r.id)
          .run();
        out.errors.push(`document ${r.id}: missing R2 ${r.r2_key}`);
        continue;
      }
      const buf = await obj.arrayBuffer();

      let parentId: string;
      if (r.context_type === "company") {
        parentId = companyFolderId(r.document_category);
      } else {
        parentId = await resolveParentFolder(
          env,
          token,
          driveId,
          {
            clientId: r.client_id,
            lastName: r.last_name,
            firstName: r.first_name,
            fullName: r.client_name,
            jobId: r.job_id,
            jobNumber: r.job_number,
            address: r.address,
            yearAnchor: r.year_anchor,
            fallbackDate: r.fallback_date,
          },
          r.document_category,
        );
      }

      const safe = r.title.replace(/[\\/]/g, "_").slice(0, 200);
      const name = `doc_${r.id}__${safe || "document"}`;
      const mime =
        obj.httpMetadata?.contentType || r.file_type || guessMimeFromKey(r.r2_key);
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
            SET mirror_status='synced', mirror_date=?, google_drive_id=?, google_drive_url=?
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

async function mirrorPhotosBatch(
  env: Env,
  token: string,
  driveId: string,
  out: DriveMirrorResult,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.r2_key, p.job_id, p.created_at AS fallback_date,
            j.job_number, j.client_id,
            (SELECT property_address FROM estimate_requests WHERE converted_job_id = j.id LIMIT 1) AS address,
            c.last_name, c.first_name, c.name AS client_name,
            (SELECT MIN(er.created_at) FROM estimate_requests er
             WHERE er.client_id = j.client_id) AS year_anchor
       FROM photos p
       LEFT JOIN jobs j ON j.id = p.job_id
       LEFT JOIN clients c ON c.id = j.client_id
      WHERE p.drive_mirrored_at IS NULL
      ORDER BY datetime(p.created_at) ASC
      LIMIT ?`,
  )
    .bind(BATCH)
    .all<{
      id: string;
      r2_key: string;
      job_id: string | null;
      fallback_date: string;
      job_number: number | null;
      client_id: string | null;
      address: string | null;
      last_name: string | null;
      first_name: string | null;
      client_name: string | null;
      year_anchor: string | null;
    }>();

  for (const r of rows.results ?? []) {
    try {
      const obj = await env.FILES.get(r.r2_key);
      if (!obj) {
        out.errors.push(`photo ${r.id}: missing R2 ${r.r2_key}`);
        continue;
      }
      const buf = await obj.arrayBuffer();
      const parentId = await resolveParentFolder(
        env,
        token,
        driveId,
        {
          clientId: r.client_id,
          lastName: r.last_name,
          firstName: r.first_name,
          fullName: r.client_name,
          jobId: r.job_id,
          jobNumber: r.job_number,
          address: r.address,
          yearAnchor: r.year_anchor,
          fallbackDate: r.fallback_date,
        },
        "photo_report",
      );
      const day = (r.fallback_date || "").slice(0, 10) || "unknown";
      const name = `photo_${r.id}_${day}.jpg`;
      const mime = obj.httpMetadata?.contentType || guessMimeFromKey(r.r2_key);
      await uploadFileMultipart({
        token,
        name,
        parents: [parentId],
        body: buf,
        mimeType: mime || "image/jpeg",
      });
      await env.DB.prepare("UPDATE photos SET drive_mirrored_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), r.id)
        .run();
      out.photos++;
    } catch (e) {
      out.errors.push(`photo ${r.id}: ${(e as Error).message}`);
    }
  }
}

async function mirrorJobFilesBatch(
  env: Env,
  token: string,
  driveId: string,
  out: DriveMirrorResult,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT jf.id, jf.r2_key, jf.filename, jf.doc_type, jf.mime_type,
            jf.job_id, jf.created_at AS fallback_date,
            j.job_number, j.client_id,
            (SELECT property_address FROM estimate_requests WHERE converted_job_id = j.id LIMIT 1) AS address,
            c.last_name, c.first_name, c.name AS client_name,
            (SELECT MIN(er.created_at) FROM estimate_requests er
             WHERE er.client_id = j.client_id) AS year_anchor
       FROM job_files jf
      INNER JOIN jobs j ON j.id = jf.job_id
       LEFT JOIN clients c ON c.id = j.client_id
      WHERE jf.drive_mirrored_at IS NULL
      ORDER BY datetime(jf.created_at) ASC
      LIMIT ?`,
  )
    .bind(BATCH)
    .all<{
      id: string;
      r2_key: string;
      filename: string;
      doc_type: string;
      mime_type: string;
      job_id: string;
      fallback_date: string;
      job_number: number | null;
      client_id: string | null;
      address: string | null;
      last_name: string | null;
      first_name: string | null;
      client_name: string | null;
      year_anchor: string | null;
    }>();

  for (const r of rows.results ?? []) {
    try {
      const obj = await env.FILES.get(r.r2_key);
      if (!obj) {
        out.errors.push(`job_file ${r.id}: missing R2 ${r.r2_key}`);
        continue;
      }
      const buf = await obj.arrayBuffer();
      const category = JOB_FILE_CATEGORY[r.doc_type] ?? "other";
      const parentId = await resolveParentFolder(
        env,
        token,
        driveId,
        {
          clientId: r.client_id,
          lastName: r.last_name,
          firstName: r.first_name,
          fullName: r.client_name,
          jobId: r.job_id,
          jobNumber: r.job_number,
          address: r.address,
          yearAnchor: r.year_anchor,
          fallbackDate: r.fallback_date,
        },
        category,
      );
      const safe = r.filename.replace(/[\\/]/g, "_").slice(0, 200);
      const name = `${r.doc_type}_${r.id}__${safe || "file"}`;
      const mime =
        obj.httpMetadata?.contentType || r.mime_type || guessMimeFromKey(r.r2_key);
      await uploadFileMultipart({
        token,
        name,
        parents: [parentId],
        body: buf,
        mimeType: mime || "application/octet-stream",
      });
      await env.DB.prepare("UPDATE job_files SET drive_mirrored_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), r.id)
        .run();
      out.job_files++;
    } catch (e) {
      out.errors.push(`job_file ${r.id}: ${(e as Error).message}`);
    }
  }
}

async function mirrorExpensesBatch(
  env: Env,
  token: string,
  driveId: string,
  out: DriveMirrorResult,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT e.id, e.receipt_r2_key, e.job_id,
            COALESCE(e.incurred_at, e.created_at) AS fallback_date,
            j.job_number, j.client_id,
            (SELECT property_address FROM estimate_requests WHERE converted_job_id = j.id LIMIT 1) AS address,
            c.last_name, c.first_name, c.name AS client_name,
            (SELECT MIN(er.created_at) FROM estimate_requests er
             WHERE er.client_id = j.client_id) AS year_anchor
       FROM expenses e
       LEFT JOIN jobs j ON j.id = e.job_id
       LEFT JOIN clients c ON c.id = j.client_id
      WHERE e.receipt_r2_key IS NOT NULL
        AND e.drive_mirrored_at IS NULL
      ORDER BY COALESCE(e.incurred_at, e.created_at) ASC, e.id ASC
      LIMIT ?`,
  )
    .bind(BATCH)
    .all<{
      id: string;
      receipt_r2_key: string;
      job_id: string | null;
      fallback_date: string | null;
      job_number: number | null;
      client_id: string | null;
      address: string | null;
      last_name: string | null;
      first_name: string | null;
      client_name: string | null;
      year_anchor: string | null;
    }>();

  for (const r of rows.results ?? []) {
    try {
      const obj = await env.FILES.get(r.receipt_r2_key);
      if (!obj) {
        out.errors.push(`expense ${r.id}: missing R2 ${r.receipt_r2_key}`);
        continue;
      }
      const buf = await obj.arrayBuffer();
      // Expense receipts → Invoices & Payments subfolder
      const parentId = await resolveParentFolder(
        env,
        token,
        driveId,
        {
          clientId: r.client_id,
          lastName: r.last_name,
          firstName: r.first_name,
          fullName: r.client_name,
          jobId: r.job_id,
          jobNumber: r.job_number,
          address: r.address,
          yearAnchor: r.year_anchor,
          fallbackDate: r.fallback_date,
        },
        "invoice",
      );
      const ext = r.receipt_r2_key.split(".").pop() || "jpg";
      const name = `receipt_${r.id}.${ext}`;
      const mime = obj.httpMetadata?.contentType || guessMimeFromKey(r.receipt_r2_key);
      await uploadFileMultipart({
        token,
        name,
        parents: [parentId],
        body: buf,
        mimeType: mime || "image/jpeg",
      });
      await env.DB.prepare("UPDATE expenses SET drive_mirrored_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), r.id)
        .run();
      out.expenses++;
    } catch (e) {
      out.errors.push(`expense ${r.id}: ${(e as Error).message}`);
    }
  }
}

async function mirrorCompanyBatch(
  env: Env,
  token: string,
  driveId: string,
  out: DriveMirrorResult,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, title, filename, r2_key, doc_type
       FROM company_documents
      WHERE drive_mirrored_at IS NULL
      ORDER BY datetime(created_at) ASC
      LIMIT ?`,
  )
    .bind(BATCH)
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
      // company_documents always go to fixed Company Documents folders — no Drive API call for the folder
      const parentId = companyFolderId(r.doc_type);
      const safe = r.filename.replace(/[\\/]/g, "_").slice(0, 200);
      const name = `company_${r.id}__${safe || "file"}`;
      const mime = obj.httpMetadata?.contentType || guessMimeFromKey(r.r2_key);
      await uploadFileMultipart({
        token,
        name,
        parents: [parentId],
        body: buf,
        mimeType: mime || "application/octet-stream",
      });
      await env.DB.prepare("UPDATE company_documents SET drive_mirrored_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), r.id)
        .run();
      out.company++;
    } catch (e) {
      out.errors.push(`company ${r.id}: ${(e as Error).message}`);
    }
  }
}
