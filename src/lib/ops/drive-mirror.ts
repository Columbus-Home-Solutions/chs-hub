/**
 * One-way D1 + R2 → Google Shared Drive mirror (insurance + human access).
 * Runs on the hourly cron; bounded batch size. Never blocks PWA uploads.
 *
 * Config (all optional; missing = skip with log):
 *   DRIVE_SHARED_DRIVE_ID, DRIVE_MIRROR_ROOT_FOLDER_ID
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
const BATCH_COMPANY = 5;

export interface DriveMirrorResult {
  skipped: boolean;
  reason?: string;
  photos: number;
  expenses: number;
  company: number;
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
    company_documents: number;
  };
  /** When all Drive vars are set, whether a Drive-scoped token can be minted */
  drive_token_ok: boolean | null;
  drive_token_error?: string;
  /** What this job copies (for operator expectations) */
  mirrors: readonly ["photos", "expense_receipts", "company_documents"];
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

  const [ph, ex, co] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as n FROM photos WHERE drive_mirrored_at IS NULL")
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) as n FROM expenses
       WHERE receipt_r2_key IS NOT NULL AND drive_mirrored_at IS NULL`,
    ).first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM company_documents WHERE drive_mirrored_at IS NULL").first<{
      n: number;
    }>(),
  ]);

  const pending = {
    photos: ph?.n ?? 0,
    expenses_with_receipt: ex?.n ?? 0,
    company_documents: co?.n ?? 0,
  };

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
    mirrors: ["photos", "expense_receipts", "company_documents"] as const,
  };
}

export async function runDriveMirror(env: Env): Promise<DriveMirrorResult> {
  const t0 = Date.now();
  const out: DriveMirrorResult = {
    skipped: true,
    photos: 0,
    expenses: 0,
    company: 0,
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
    const photosId = await segmentFolderId(env, token, driveId, rootId, "Photos");
    const expensesId = await segmentFolderId(env, token, driveId, rootId, "Expenses");
    const companyRootId = await segmentFolderId(env, token, driveId, rootId, "Company");

    await mirrorPhotosBatch(env, token, driveId, photosId, out);
    await mirrorExpensesBatch(env, token, driveId, expensesId, out);
    await mirrorCompanyBatch(env, token, driveId, companyRootId, out);
  } catch (e) {
    out.errors.push((e as Error).message);
  }

  out.duration_ms = Date.now() - t0;
  return out;
}

async function segmentFolderId(
  env: Env,
  token: string,
  driveId: string,
  rootId: string,
  segment: "Photos" | "Expenses" | "Company",
): Promise<string> {
  const pathKey = `seg_${segment}`;
  const row = await env.DB.prepare("SELECT drive_folder_id FROM drive_mirror_folders WHERE path_key = ?")
    .bind(pathKey)
    .first<{ drive_folder_id: string }>();
  if (row?.drive_folder_id) return row.drive_folder_id;
  const id = await getOrCreateFolder({ token, driveId, parentId: rootId, name: segment });
  await env.DB.prepare(
    "INSERT OR REPLACE INTO drive_mirror_folders (path_key, drive_folder_id) VALUES (?, ?)",
  )
    .bind(pathKey, id)
    .run();
  return id;
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
  parentId: string,
  out: DriveMirrorResult,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, r2_key, job_id, created_at
     FROM photos
     WHERE drive_mirrored_at IS NULL
     ORDER BY datetime(created_at) ASC
     LIMIT ?`,
  )
    .bind(BATCH_PHOTOS)
    .all<{ id: string; r2_key: string; job_id: string | null; created_at: string }>();
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
  parentId: string,
  out: DriveMirrorResult,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, receipt_r2_key
     FROM expenses
     WHERE receipt_r2_key IS NOT NULL
       AND drive_mirrored_at IS NULL
     ORDER BY COALESCE(incurred_at, synced_at) ASC, id ASC
     LIMIT ?`,
  )
    .bind(BATCH_EXPENSES)
    .all<{ id: string; receipt_r2_key: string }>();
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
