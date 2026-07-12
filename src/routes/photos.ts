/**
 * Photo capture endpoints (Sprint 8 — Photo Capture & Smart Notes).
 *
 * Carries forward the original chs-hub CHS Capture PWA backend and rewires it
 * to the unified CHS `photos` schema + job pipeline, then adds the net-new
 * batch/offline, receipt, timeline and metadata surfaces.
 *
 *   POST   /api/photos                  upload (new: `image` + flat fields; also
 *                                       accepts legacy original/thumb/metadata)
 *   POST   /api/photos/batch            offline-sync batch upload (idempotent)
 *   POST   /api/photos/receipt          receipt upload + Claude extraction
 *   GET    /api/jobs/:id/photos         per-job timeline (?type=&from=&to=)
 *   GET    /api/photos                  legacy list (?job_id=&since=&limit=)
 *   GET    /api/photos/:id              stream original from R2 (dashboard)
 *   GET    /api/photos/:id/thumb        stream thumb from R2
 *   GET    /api/photos/:id/meta         photo record as JSON
 *   PUT    /api/photos/:id              update caption/type/task+log link/flags
 *   PATCH  /api/photos/:id              legacy move (job_id/category)
 *   DELETE /api/photos/:id              SOFT delete (is_active=0; R2 retained)
 *   GET    /api/receipt-photos/:id      receipt extraction result
 *   POST   /api/receipt-photos/:id/confirm  confirm → create expense + link
 *   GET    /api/jobs/active             minimal in-progress jobs (PWA switcher)
 *
 * Business rules enforced here: timestamp always set, GPS optional (#1);
 * soft-delete only, R2 permanent (#2); receipt AI is a suggestion (#3); batch
 * idempotent (#5); thumbnail non-fatal (#6); AI-key-absent degrades (#7);
 * annotate / before-after / social stay seams (#8).
 */

import type { Env } from "../env.js";
import { dateBucket, photoOriginalKey, photoThumbKey, putImage, streamObject } from "../lib/r2.js";
import { extractReceipt } from "../lib/receipt-ai.js";
import {
  applyVendorMaterialPriceUpdate,
  hasUnresolvedMatches,
  parseStoredExtractedItems,
  parseStoredMatchResults,
  processReceiptMatching,
  type ExtractedItem,
  type MatchResult,
} from "../lib/receipt-matching.js";
import { guard } from "../middleware/guard.js";
import { insertFullExpense } from "./expenses.js";
import { validateAnnotationData, hasMarkup } from "../lib/annotation.js";
import { writeAudit } from "../lib/audit.js";

// O/PM/FC may capture; expense creation on confirm is gated O/PM/FC (FC allowed
// for expense per the route map note).
const CAPTURE_ROLES = ["owner", "project_manager", "field_crew", "office_admin"] as const;
const EXPENSE_ROLES = ["owner", "project_manager", "field_crew"] as const;
const MATCH_READ_ROLES = ["owner", "project_manager", "office_admin", "field_crew"] as const;
const MATCH_WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;

// Photo types the capture bar offers. Legacy `category` (before|progress|final)
// is kept populated alongside so the old dashboard viewer still renders.
const PHOTO_TYPES = new Set([
  "job_progress",
  "before",
  "after",
  "receipt",
  "punch_list",
  "issue",
  "completion",
  "general",
]);
const LEGACY_CATEGORY: Record<string, string> = {
  job_progress: "progress",
  before: "before",
  after: "final",
  receipt: "progress",
  punch_list: "progress",
  issue: "progress",
  completion: "final",
  general: "progress",
};

const OPEN_JOB_STATUSES = [
  "late",
  "action_required",
  "requires_invoicing",
  "upcoming",
  "on_the_way",
  "active",
  "in_progress",
  "deposit_paid",
  "scheduled",
  "punch_list",
];

// ─── helpers ─────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}
function jsonErr(status: number, code: string, message?: string): Response {
  return jsonResponse({ error: code, message: message ?? code }, { status });
}
function getEntry(form: FormData, name: string): Blob | string | null {
  return form.get(name) as unknown as Blob | string | null;
}
function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function safeJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

interface PhotoMetaInput {
  job_id: string | null;
  photo_type: string;
  caption: string | null;
  taken_at: string;
  latitude: number | null;
  longitude: number | null;
  location_accuracy: number | null;
  task_id: string | null;
  daily_log_id: string | null;
  entered_via: string;
  tags: string[] | null;
  synced_from_offline: boolean;
  capture_uuid: string | null;
}

function readMeta(source: Record<string, unknown>): PhotoMetaInput {
  const rawType = str(source.photo_type) ?? str(source.category) ?? "job_progress";
  const photo_type = PHOTO_TYPES.has(rawType) ? rawType : "job_progress";
  return {
    job_id: str(source.job_id),
    photo_type,
    caption: str(source.caption),
    taken_at: str(source.taken_at) ?? new Date().toISOString(), // rule #1: always timestamped
    latitude: num(source.latitude) ?? num(source.gps_lat),
    longitude: num(source.longitude) ?? num(source.gps_lng),
    location_accuracy: num(source.location_accuracy),
    task_id: str(source.task_id),
    daily_log_id: str(source.daily_log_id),
    entered_via: str(source.entered_via) ?? "web",
    tags: Array.isArray(source.tags) ? source.tags.map(String) : null,
    synced_from_offline:
      source.synced_from_offline === true ||
      source.synced_from_offline === 1 ||
      source.synced_from_offline === "1",
    capture_uuid: str(source.capture_uuid) ?? str(source.client_uuid) ?? str(source.id),
  };
}

/** Insert one photo row from already-read metadata + R2 keys. */
async function insertPhotoRow(
  env: Env,
  id: string,
  meta: PhotoMetaInput,
  keys: { r2Key: string; thumbKey: string },
  uploadedBy: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const category = LEGACY_CATEGORY[meta.photo_type] ?? "progress";
  await env.DB.prepare(
    `INSERT INTO photos
       (id, created_at, taken_at, job_id, category, r2_key, thumb_key,
        uploaded_by, gps_lat, gps_lng, tags, caption, before_after_pair_id,
        photo_type, latitude, longitude, location_accuracy, r2_thumbnail_key,
        r2_url, uploaded_at, synced_from_offline, task_id, daily_log_id,
        entered_via, is_active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      id,
      now,
      meta.taken_at,
      meta.job_id,
      category,
      keys.r2Key,
      keys.thumbKey,
      uploadedBy,
      meta.latitude,
      meta.longitude,
      meta.tags ? JSON.stringify(meta.tags) : null,
      meta.caption,
      meta.photo_type,
      meta.latitude,
      meta.longitude,
      meta.location_accuracy,
      keys.thumbKey,
      `/api/photos/${id}`,
      now,
      meta.synced_from_offline ? 1 : 0,
      meta.task_id,
      meta.daily_log_id,
      meta.entered_via,
      uploadedBy,
    )
    .run();
}

interface PhotoRow {
  id: string;
  created_at: string;
  taken_at: string | null;
  job_id: string | null;
  photo_type: string | null;
  category: string;
  caption: string | null;
  latitude: number | null;
  longitude: number | null;
  location_accuracy: number | null;
  gps_lat: number | null;
  gps_lng: number | null;
  uploaded_by: string | null;
  synced_from_offline: number | null;
  task_id: string | null;
  daily_log_id: string | null;
  is_active: number | null;
  is_social_ready: number | null;
  is_before_photo: number | null;
  is_after_photo: number | null;
  is_annotated: number | null;
  annotation_data: string | null;
  before_after_pair_id: string | null;
  tags: string | null;
  entered_via: string | null;
  rp_id?: string | null;
  rp_status?: string | null;
  rp_vendor?: string | null;
  rp_amount?: number | null;
  rp_date?: string | null;
  rp_category?: string | null;
  rp_confidence?: number | null;
  rp_expense_id?: string | null;
  rp_extracted_items?: string | null;
}

function hydratePhoto(row: PhotoRow) {
  const receipt = row.rp_id
    ? {
        id: row.rp_id,
        processing_status: row.rp_status,
        ai_vendor: row.rp_vendor ?? null,
        ai_amount: row.rp_amount ?? null,
        ai_date: row.rp_date ?? null,
        ai_category: row.rp_category ?? null,
        ai_confidence: row.rp_confidence ?? null,
        expense_id: row.rp_expense_id ?? null,
        extracted_items: row.rp_extracted_items ?? null,
      }
    : null;
  return {
    id: row.id,
    created_at: row.created_at,
    taken_at: row.taken_at,
    job_id: row.job_id,
    photo_type: row.photo_type ?? row.category,
    caption: row.caption,
    latitude: row.latitude ?? row.gps_lat,
    longitude: row.longitude ?? row.gps_lng,
    location_accuracy: row.location_accuracy,
    uploaded_by: row.uploaded_by,
    synced_from_offline: Boolean(row.synced_from_offline),
    task_id: row.task_id,
    daily_log_id: row.daily_log_id,
    is_active: row.is_active == null ? true : Boolean(row.is_active),
    is_social_ready: Boolean(row.is_social_ready),
    is_before_photo: Boolean(row.is_before_photo),
    is_after_photo: Boolean(row.is_after_photo),
    is_annotated: Boolean(row.is_annotated),
    annotation_data: row.annotation_data ?? null,
    before_after_pair_id: row.before_after_pair_id ?? null,
    tags: safeJsonArray(row.tags),
    entered_via: row.entered_via,
    thumb_url: `/api/photos/${row.id}/thumb`,
    original_url: `/api/photos/${row.id}`,
    receipt,
  };
}

const PHOTO_SELECT = `
  p.id, p.created_at, p.taken_at, p.job_id, p.photo_type, p.category, p.caption,
  p.latitude, p.longitude, p.location_accuracy, p.gps_lat, p.gps_lng,
  p.uploaded_by, p.synced_from_offline, p.task_id, p.daily_log_id, p.is_active,
  p.is_social_ready, p.is_before_photo, p.is_after_photo, p.is_annotated,
  p.annotation_data, p.before_after_pair_id,
  p.tags, p.entered_via,
  rp.id AS rp_id, rp.processing_status AS rp_status, rp.ai_vendor AS rp_vendor,
  rp.ai_amount AS rp_amount, rp.ai_date AS rp_date, rp.ai_category AS rp_category,
  rp.ai_confidence AS rp_confidence, rp.expense_id AS rp_expense_id,
  rp.extracted_items AS rp_extracted_items
  FROM photos p
  LEFT JOIN receipt_photos rp ON rp.photo_id = p.id`;

// ─── POST /api/photos ──────────────────────────────────────────────────────

export async function handlePhotoCreate(env: Env, request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonErr(400, "invalid_form_data");
  }

  // New shape: `image` + flat fields. Legacy shape: `original` + `thumb` +
  // `metadata` JSON (the deployed capture PWA). Support both.
  const image = getEntry(form, "image");
  const original = getEntry(form, "original");
  const thumb = getEntry(form, "thumb");
  const metadataRaw = getEntry(form, "metadata");

  const full = image instanceof Blob ? image : original instanceof Blob ? original : null;
  if (!full) return jsonErr(400, "image_required", "provide `image` (or legacy `original`)");

  let metaSource: Record<string, unknown> = {};
  if (typeof metadataRaw === "string") {
    try {
      metaSource = JSON.parse(metadataRaw) as Record<string, unknown>;
    } catch {
      return jsonErr(400, "metadata_not_json");
    }
  } else {
    // Flat form fields.
    for (const k of [
      "job_id",
      "photo_type",
      "category",
      "caption",
      "taken_at",
      "latitude",
      "longitude",
      "location_accuracy",
      "task_id",
      "daily_log_id",
      "entered_via",
      "synced_from_offline",
      "capture_uuid",
    ]) {
      const v = form.get(k);
      if (v !== null) metaSource[k] = v;
    }
  }

  const meta = readMeta(metaSource);
  const uploadedBy = request.headers.get("cf-access-authenticated-user-email") ?? null;

  // Idempotency: if the client supplied a capture UUID and we already have it,
  // don't double-write (a retried single upload mustn't duplicate a photo).
  const id = meta.capture_uuid ?? crypto.randomUUID();
  if (meta.capture_uuid) {
    const exists = await env.DB.prepare("SELECT id FROM photos WHERE id = ?")
      .bind(id)
      .first<{ id: string }>();
    if (exists) {
      return jsonResponse(
        { photo: { id, duplicate: true, thumb_url: `/api/photos/${id}/thumb`, original_url: `/api/photos/${id}` } },
        { status: 200 },
      );
    }
  }

  const bucket = dateBucket(meta.taken_at);
  const r2Key = photoOriginalKey(meta.job_id, bucket, id);
  const thumbKey = photoThumbKey(meta.job_id, bucket, id);

  const fullBytes = await full.arrayBuffer();
  // Thumbnail is non-fatal (#6): if no client thumb, the thumb key points at
  // the full image so the grid still renders.
  let thumbBytes: ArrayBuffer | null = null;
  if (thumb instanceof Blob) {
    try {
      thumbBytes = await thumb.arrayBuffer();
    } catch {
      thumbBytes = null;
    }
  }

  // R2 first, D1 second (orphan R2 is recoverable; a D1 row pointing at no
  // object is worse). Carried forward from the original route.
  await putImage(env, r2Key, fullBytes, full.type);
  await putImage(env, thumbKey, thumbBytes ?? fullBytes, thumb instanceof Blob ? thumb.type : full.type);

  await insertPhotoRow(env, id, meta, { r2Key, thumbKey }, uploadedBy);

  return jsonResponse(
    { photo: { id, thumb_url: `/api/photos/${id}/thumb`, original_url: `/api/photos/${id}` } },
    { status: 201 },
  );
}

// ─── POST /api/photos/batch (offline sync) ──────────────────────────────────
//
// Body: multipart/form-data with repeated entries:
//   meta_<i>   (string JSON)  per-photo metadata incl. a stable `capture_uuid`
//   image_<i>  (Blob)         the full-size photo
//   thumb_<i>  (Blob, opt.)   client-generated thumbnail
// `count` (string int) tells us how many tuples to expect.
//
// Idempotent (#5): the capture_uuid becomes the photo row id; a re-fired sync
// of the same batch returns status='duplicate' for already-stored photos and
// performs no R2 write or insert.

export async function handlePhotoBatch(env: Env, request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonErr(400, "invalid_form_data");
  }

  const count = parseInt(String(form.get("count") ?? "0"), 10) || 0;
  if (count <= 0 || count > 100) return jsonErr(400, "invalid_count", "count must be 1..100");

  const uploadedBy = request.headers.get("cf-access-authenticated-user-email") ?? null;
  const results: { capture_uuid: string | null; id: string | null; status: string; error?: string }[] = [];

  for (let i = 0; i < count; i++) {
    const metaRaw = form.get(`meta_${i}`);
    const image = getEntry(form, `image_${i}`);
    const thumb = getEntry(form, `thumb_${i}`);
    if (typeof metaRaw !== "string" || !(image instanceof Blob)) {
      results.push({ capture_uuid: null, id: null, status: "skipped", error: "missing_meta_or_image" });
      continue;
    }
    let metaSource: Record<string, unknown>;
    try {
      metaSource = JSON.parse(metaRaw) as Record<string, unknown>;
    } catch {
      results.push({ capture_uuid: null, id: null, status: "failed", error: "meta_not_json" });
      continue;
    }
    const meta = readMeta(metaSource);
    meta.synced_from_offline = true; // rule #4: offline batch keeps device time + flag
    if (!meta.entered_via || meta.entered_via === "web") meta.entered_via = "pwa";
    const id = meta.capture_uuid ?? crypto.randomUUID();

    try {
      if (meta.capture_uuid) {
        const exists = await env.DB.prepare("SELECT id FROM photos WHERE id = ?")
          .bind(id)
          .first<{ id: string }>();
        if (exists) {
          results.push({ capture_uuid: meta.capture_uuid, id, status: "duplicate" });
          continue;
        }
      }
      const bucket = dateBucket(meta.taken_at);
      const r2Key = photoOriginalKey(meta.job_id, bucket, id);
      const thumbKey = photoThumbKey(meta.job_id, bucket, id);
      const fullBytes = await image.arrayBuffer();
      const thumbBytes = thumb instanceof Blob ? await thumb.arrayBuffer().catch(() => null) : null;
      await putImage(env, r2Key, fullBytes, image.type);
      await putImage(env, thumbKey, thumbBytes ?? fullBytes, thumb instanceof Blob ? thumb.type : image.type);
      await insertPhotoRow(env, id, meta, { r2Key, thumbKey }, uploadedBy);
      results.push({ capture_uuid: meta.capture_uuid, id, status: "created" });
    } catch (e) {
      results.push({ capture_uuid: meta.capture_uuid, id: null, status: "failed", error: (e as Error).message });
    }
  }

  const created = results.filter((r) => r.status === "created").length;
  const duplicate = results.filter((r) => r.status === "duplicate").length;
  const failed = results.filter((r) => r.status === "failed" || r.status === "skipped").length;
  return jsonResponse(
    { ok: failed === 0, created, duplicate, failed, results },
    { status: 207 },
  );
}

// ─── POST /api/photos/receipt ───────────────────────────────────────────────

export async function handleReceiptCreate(
  env: Env,
  request: Request,
  ctx: ExecutionContext,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonErr(400, "invalid_form_data");
  }
  const image = getEntry(form, "image") ?? getEntry(form, "original");
  if (!(image instanceof Blob)) return jsonErr(400, "image_required");

  const metaSource: Record<string, unknown> = {};
  for (const k of ["job_id", "taken_at", "latitude", "longitude", "entered_via", "caption", "capture_uuid"]) {
    const v = form.get(k);
    if (v !== null) metaSource[k] = v;
  }
  metaSource.photo_type = "receipt";
  const meta = readMeta(metaSource);
  const uploadedBy = request.headers.get("cf-access-authenticated-user-email") ?? null;

  const id = meta.capture_uuid ?? crypto.randomUUID();
  const bucket = dateBucket(meta.taken_at);
  const r2Key = photoOriginalKey(meta.job_id, bucket, id);
  const thumbKey = photoThumbKey(meta.job_id, bucket, id);

  const bytes = await image.arrayBuffer();
  await putImage(env, r2Key, bytes, image.type);
  await putImage(env, thumbKey, bytes, image.type); // receipts: thumb == full
  await insertPhotoRow(env, id, meta, { r2Key, thumbKey }, uploadedBy);

  // Fire Claude extraction. Failure is non-fatal — the photo persists and the
  // receipt row records 'failed' so the user can retry / enter manually (#3,#7).
  const extraction = await extractReceipt(env, bytes, image.type || "image/jpeg");
  const receiptId = crypto.randomUUID();
  const status = extraction.ok ? "processed" : "failed";
  await env.DB.prepare(
    `INSERT INTO receipt_photos
       (id, photo_id, ai_vendor, ai_amount, ai_date, ai_category, ai_confidence,
        expense_id, processing_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, datetime('now'))`,
  )
    .bind(
      receiptId,
      id,
      extraction.vendor,
      extraction.amount,
      extraction.date,
      extraction.category,
      extraction.confidence,
      status,
    )
    .run();

  if (extraction.ok) {
    ctx.waitUntil(
      processReceiptMatching(receiptId, r2Key, meta.job_id, env.DB, env).catch((e) =>
        console.error("[photos] receipt line-item matching failed:", (e as Error).message),
      ),
    );
  }

  return jsonResponse(
    {
      photo: { id, thumb_url: `/api/photos/${id}/thumb`, original_url: `/api/photos/${id}` },
      receipt: {
        id: receiptId,
        processing_status: status,
        ai_vendor: extraction.vendor,
        ai_amount: extraction.amount,
        ai_date: extraction.date,
        ai_category: extraction.category,
        ai_confidence: extraction.confidence,
        error: extraction.error,
      },
    },
    { status: 201 },
  );
}

// ─── GET /api/receipt-photos/:id ────────────────────────────────────────────

export async function handleReceiptGet(env: Env, receiptId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT rp.*, p.r2_url AS photo_url FROM receipt_photos rp
     JOIN photos p ON p.id = rp.photo_id WHERE rp.id = ?`,
  )
    .bind(receiptId)
    .first<Record<string, unknown>>();
  if (!row) return jsonErr(404, "not_found");
  return jsonResponse({ receipt: row });
}

// ─── POST /api/receipt-photos/:id/confirm ───────────────────────────────────
//
// Body: { vendor, amount, date, category, job_id?, description? }. Creates an
// expenses row from the CONFIRMED values (not the raw AI values — #3), links
// receipt_photos.expense_id, and marks processing_status='confirmed'.

export async function handleReceiptConfirm(
  env: Env,
  request: Request,
  receiptId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...EXPENSE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }

  const rp = await env.DB.prepare(
    `SELECT rp.id, rp.photo_id, rp.expense_id, p.job_id AS photo_job_id
     FROM receipt_photos rp JOIN photos p ON p.id = rp.photo_id WHERE rp.id = ?`,
  )
    .bind(receiptId)
    .first<{ id: string; photo_id: string; expense_id: string | null; photo_job_id: string | null }>();
  if (!rp) return jsonErr(404, "not_found");
  if (rp.expense_id) {
    return jsonResponse({ ok: true, already_confirmed: true, expense_id: rp.expense_id });
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return jsonErr(400, "amount_required", "amount must be a positive number");
  }
  const vendor = str(body.vendor);
  const category = str(body.category);
  const date = str(body.date) ?? new Date().toISOString().slice(0, 10);
  const jobId = str(body.job_id) ?? rp.photo_job_id;
  const description = str(body.description) ?? (vendor ? `Receipt — ${vendor}` : "Receipt");

  // Sprint 10: land the FULL expense shape (estimate-line-item alignment, tax
  // category, sub/1099) via the shared helper — extend, don't fork. The receipt
  // image stays linked via receipt_photo_id and is never deleted (rule #8).
  const expenseType = str(body.expense_type) ?? "material";
  const isSub = expenseType === "subcontractor";
  const expenseId = await insertFullExpense(env, {
    job_id: jobId,
    expense_type: expenseType,
    vendor,
    description,
    amount,
    incurred_date: date,
    estimate_line_item_id: str(body.estimate_line_item_id),
    tax_category: str(body.tax_category) ?? category,
    sub_id: isSub ? str(body.sub_id) : null,
    is_1099_reportable: isSub && Boolean(body.is_1099_reportable),
    receipt_photo_id: rp.photo_id,
    receipt_r2_key: null,
    entered_via: "receipt_capture",
    created_by: user.email,
    save_to_price_book: Boolean(body.save_to_price_book),
    material_name: str(body.material_name),
    material_unit: str(body.material_unit),
  });

  await env.DB.prepare(
    `UPDATE receipt_photos SET expense_id = ?, processing_status = 'confirmed',
       ai_vendor = COALESCE(?, ai_vendor), ai_amount = COALESCE(?, ai_amount),
       ai_date = COALESCE(?, ai_date), ai_category = COALESCE(?, ai_category)
     WHERE id = ?`,
  )
    .bind(expenseId, vendor, amount, date, category, receiptId)
    .run();

  return jsonResponse({ ok: true, expense_id: expenseId, receipt_id: receiptId }, { status: 201 });
}

// ─── GET /api/receipt-photos/:id/matches ────────────────────────────────────

export async function handleReceiptMatchesGet(
  env: Env,
  request: Request,
  receiptId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...MATCH_READ_ROLES]);
  if (guarded instanceof Response) return guarded;

  const row = await env.DB.prepare(
    `SELECT id, processing_status, extracted_items, match_results
     FROM receipt_photos WHERE id = ?`,
  )
    .bind(receiptId)
    .first<{
      id: string;
      processing_status: string;
      extracted_items: string | null;
      match_results: string | null;
    }>();
  if (!row) return jsonErr(404, "not_found");

  if (row.processing_status === "pending" || row.extracted_items == null) {
    return jsonResponse({ status: "pending" }, { status: 202 });
  }
  if (row.processing_status === "failed") {
    return jsonResponse({ status: "failed" });
  }

  const extractedItems = parseStoredExtractedItems(row.extracted_items) ?? [];
  const matchResults = parseStoredMatchResults(row.match_results) ?? [];

  // Include expense_line_items rows so the UI gets Match B (catalog) data
  // alongside Match A (estimate sub-item) data in one request.
  const { results: lineItemRows } = await env.DB.prepare(
    `SELECT eli.id, eli.description, eli.quantity, eli.unit, eli.unit_price, eli.amount,
            eli.matched_estimate_sub_item_id, eli.matched_vendor_material_id, eli.match_confidence,
            eli.expense_id,
            vm.vendor_name AS vm_vendor_name, vm.material_name AS vm_material_name,
            vm.unit AS vm_unit, vm.last_price AS vm_last_price
     FROM expense_line_items eli
     LEFT JOIN vendor_materials vm ON vm.id = eli.matched_vendor_material_id
     WHERE eli.receipt_photo_id = ?
     ORDER BY eli.created_at ASC`,
  )
    .bind(receiptId)
    .all<Record<string, unknown>>();

  const expenseLineItems = (lineItemRows ?? []).map((r) => ({
    id: r.id,
    description: r.description,
    quantity: r.quantity,
    unit: r.unit,
    unit_price: r.unit_price,
    amount: r.amount,
    matched_estimate_sub_item_id: r.matched_estimate_sub_item_id,
    matched_vendor_material_id: r.matched_vendor_material_id,
    match_confidence: r.match_confidence,
    expense_id: r.expense_id,
    vendor_material: r.matched_vendor_material_id
      ? {
          id: r.matched_vendor_material_id,
          vendor_name: r.vm_vendor_name,
          material_name: r.vm_material_name,
          unit: r.vm_unit,
          last_price: r.vm_last_price,
        }
      : null,
    is_new_material_candidate:
      !r.matched_vendor_material_id && r.unit_price !== null && (r.unit_price as number) > 0,
  }));

  return jsonResponse({
    status: "processed",
    extracted_items: extractedItems,
    match_results: matchResults,
    has_unresolved: hasUnresolvedMatches(extractedItems, matchResults),
    expense_line_items: expenseLineItems,
  });
}

// ─── POST /api/receipt-photos/:id/matches/:itemId/confirm ───────────────────

export async function handleReceiptMatchConfirm(
  env: Env,
  request: Request,
  receiptId: string,
  itemId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...MATCH_WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }

  const row = await env.DB.prepare(
    `SELECT id, match_results FROM receipt_photos WHERE id = ?`,
  )
    .bind(receiptId)
    .first<{ id: string; match_results: string | null }>();
  if (!row) return jsonErr(404, "not_found");

  const matchResults = parseStoredMatchResults(row.match_results);
  if (!matchResults) return jsonErr(404, "matches_not_ready");

  const idx = matchResults.findIndex((r) => r.item_id === itemId);
  if (idx === -1) return jsonErr(404, "item_not_found");

  const lineItemId =
    body.line_item_id === null || body.line_item_id === undefined
      ? null
      : str(body.line_item_id);
  if (lineItemId) {
    // Match A now targets estimate_sub_items — validate against that table.
    const valid = await env.DB.prepare("SELECT 1 AS ok FROM estimate_sub_items WHERE id = ?")
      .bind(lineItemId)
      .first<{ ok: number }>();
    if (!valid) return jsonErr(400, "invalid_line_item_id");
  }

  const now = new Date().toISOString();
  const updated: MatchResult = {
    ...matchResults[idx],
    confirmed_line_item_id: lineItemId,
    confirmed_by: user.email,
    confirmed_at: now,
  };
  matchResults[idx] = updated;

  await env.DB.prepare("UPDATE receipt_photos SET match_results = ? WHERE id = ?")
    .bind(JSON.stringify(matchResults), receiptId)
    .run();

  return jsonResponse({ success: true });
}

// ─── POST /api/receipt-photos/:id/matches/apply ─────────────────────────────

export async function handleReceiptMatchesApply(
  env: Env,
  request: Request,
  receiptId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...MATCH_WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await env.DB.prepare(
    `SELECT rp.id, rp.extracted_items, rp.match_results, rp.expense_id, rp.photo_id,
            e.job_id, e.incurred_date, e.vendor
     FROM receipt_photos rp
     LEFT JOIN expenses e ON e.id = rp.expense_id
     WHERE rp.id = ?`,
  )
    .bind(receiptId)
    .first<{
      id: string;
      extracted_items: string | null;
      match_results: string | null;
      expense_id: string | null;
      photo_id: string;
      job_id: string | null;
      incurred_date: string | null;
      vendor: string | null;
    }>();
  if (!row) return jsonErr(404, "not_found");
  if (!row.expense_id || !row.job_id) {
    return jsonResponse(
      { error: "Confirm the receipt before applying matches." },
      { status: 400 },
    );
  }

  const extractedItems = parseStoredExtractedItems(row.extracted_items) ?? [];
  const matchResults = parseStoredMatchResults(row.match_results) ?? [];
  const matchByItemId = new Map(matchResults.map((r) => [r.item_id, r]));

  let applied = 0;
  let skipped = 0;

  for (const item of extractedItems) {
    const match = matchByItemId.get(item.id);
    let lineItemId: string | null = null;
    if (match?.confirmed_line_item_id != null) {
      lineItemId = match.confirmed_line_item_id;
    } else if (match?.status === "matched" && match.suggested_line_item_id) {
      lineItemId = match.suggested_line_item_id;
    }

    if (!lineItemId) {
      skipped++;
      continue;
    }

    await insertFullExpense(env, {
      job_id: row.job_id,
      expense_type: "material",
      vendor: row.vendor,
      description: item.description,
      amount: item.amount,
      incurred_date: row.incurred_date ?? new Date().toISOString().slice(0, 10),
      estimate_line_item_id: lineItemId,
      tax_category: null,
      sub_id: null,
      is_1099_reportable: false,
      receipt_photo_id: row.photo_id,
      receipt_r2_key: null,
      entered_via: "auto",
      created_by: user.email,
    });
    applied++;
  }

  return jsonResponse({ applied, skipped });
}

// ─── GET /api/jobs/:id/photos (timeline) ────────────────────────────────────

export async function handleJobPhotos(env: Env, jobId: string, url: URL): Promise<Response> {
  const type = url.searchParams.get("type");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const includeInactive = url.searchParams.get("include_inactive") === "1";

  const where: string[] = ["p.job_id = ?"];
  const binds: unknown[] = [jobId];
  if (!includeInactive) where.push("COALESCE(p.is_active, 1) = 1");
  if (type) {
    where.push("p.photo_type = ?");
    binds.push(type);
  }
  if (from) {
    where.push("COALESCE(p.taken_at, p.created_at) >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("COALESCE(p.taken_at, p.created_at) <= ?");
    binds.push(to);
  }

  const rows = await env.DB.prepare(
    `SELECT ${PHOTO_SELECT}
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(p.taken_at, p.created_at) ASC
     LIMIT 1000`,
  )
    .bind(...binds)
    .all<PhotoRow>();

  const photos = (rows.results ?? []).map(hydratePhoto);
  return jsonResponse({ as_of: new Date().toISOString(), total: photos.length, photos });
}

// ─── GET /api/photos/:id/meta ───────────────────────────────────────────────

export async function handlePhotoMeta(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT ${PHOTO_SELECT} WHERE p.id = ?`)
    .bind(id)
    .first<PhotoRow>();
  if (!row) return jsonErr(404, "not_found");
  return jsonResponse({ photo: hydratePhoto(row) });
}

// ─── PUT /api/photos/:id ─────────────────────────────────────────────────────
//
// Update caption, photo_type, task/daily-log link. The is_social_ready /
// is_before_photo / is_after_photo flags MAY be set here, but no feature is
// wired around them this sprint (social = S16, before/after = S18). annotate is
// a deferred seam (see handlePhotoAnnotate).

export async function handlePhotoPut(
  env: Env,
  request: Request,
  id: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const guarded = await guard(request, env, [...CAPTURE_ROLES]);
  if (guarded instanceof Response) return guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }
  const existing = await env.DB.prepare(
    "SELECT id, r2_key, job_id FROM photos WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; r2_key: string; job_id: string }>();
  if (!existing) return jsonErr(404, "not_found");

  const sets: string[] = [];
  const binds: unknown[] = [];
  let taggingAsReceipt = false;
  if ("caption" in body) {
    sets.push("caption = ?");
    binds.push(str(body.caption));
  }
  if ("photo_type" in body) {
    const t = str(body.photo_type) ?? "job_progress";
    const photo_type = PHOTO_TYPES.has(t) ? t : "job_progress";
    sets.push("photo_type = ?", "category = ?");
    binds.push(photo_type, LEGACY_CATEGORY[photo_type] ?? "progress");
    if (photo_type === "receipt") taggingAsReceipt = true;
  }
  if ("task_id" in body) {
    sets.push("task_id = ?");
    binds.push(str(body.task_id));
  }
  if ("daily_log_id" in body) {
    sets.push("daily_log_id = ?");
    binds.push(str(body.daily_log_id));
  }
  // Flags may be set; no feature around them yet (seams).
  for (const flag of ["is_social_ready", "is_before_photo", "is_after_photo"]) {
    if (flag in body) {
      sets.push(`${flag} = ?`);
      binds.push(body[flag] ? 1 : 0);
    }
  }
  if (sets.length === 0) return jsonErr(400, "no_updatable_fields");

  binds.push(id);
  await env.DB.prepare(`UPDATE photos SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  // When an existing photo is tagged as a receipt, run the same pipeline that
  // POST /api/photos/receipt uses: extract via Claude, create/update receipt_photos
  // row, then fire matching. Idempotent for already-confirmed/processed rows;
  // re-runs for failed rows so retrying (re-save with Receipt type) works.
  if (taggingAsReceipt) {
    const existingReceipt = await env.DB.prepare(
      "SELECT id, processing_status FROM receipt_photos WHERE photo_id = ?",
    )
      .bind(id)
      .first<{ id: string; processing_status: string }>();

    const shouldProcess =
      !existingReceipt || existingReceipt.processing_status === "failed";

    if (shouldProcess) {
      const obj = await env.FILES.get(existing.r2_key);
      const bytes = obj ? await obj.arrayBuffer() : null;

      if (bytes) {
        const contentType = obj?.httpMetadata?.contentType ?? "image/jpeg";
        const extraction = await extractReceipt(env, bytes, contentType);
        const status = extraction.ok ? "processed" : "failed";

        if (existingReceipt) {
          // Re-run on a previously failed row — update in place.
          await env.DB.prepare(
            `UPDATE receipt_photos
               SET ai_vendor = ?, ai_amount = ?, ai_date = ?, ai_category = ?,
                   ai_confidence = ?, processing_status = ?
             WHERE id = ?`,
          )
            .bind(
              extraction.vendor,
              extraction.amount,
              extraction.date,
              extraction.category,
              extraction.confidence,
              status,
              existingReceipt.id,
            )
            .run();

          if (extraction.ok) {
            ctx.waitUntil(
              processReceiptMatching(
                existingReceipt.id,
                existing.r2_key,
                existing.job_id,
                env.DB,
                env,
              ).catch((e) =>
                console.error("[photos] tag-as-receipt matching failed:", (e as Error).message),
              ),
            );
          }
        } else {
          // First time — insert a new row.
          const receiptId = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO receipt_photos
               (id, photo_id, ai_vendor, ai_amount, ai_date, ai_category, ai_confidence,
                expense_id, processing_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, datetime('now'))`,
          )
            .bind(
              receiptId,
              id,
              extraction.vendor,
              extraction.amount,
              extraction.date,
              extraction.category,
              extraction.confidence,
              status,
            )
            .run();

          if (extraction.ok) {
            ctx.waitUntil(
              processReceiptMatching(receiptId, existing.r2_key, existing.job_id, env.DB, env).catch(
                (e) =>
                  console.error("[photos] tag-as-receipt matching failed:", (e as Error).message),
              ),
            );
          }
        }
      } else {
        console.error("[photos] tag-as-receipt: R2 object not found for key", existing.r2_key);
      }
    }
  }

  const row = await env.DB.prepare(`SELECT ${PHOTO_SELECT} WHERE p.id = ?`)
    .bind(id)
    .first<PhotoRow>();
  return jsonResponse({ photo: row ? hydratePhoto(row) : null });
}

// ─── DELETE /api/photos/:id  → SOFT delete (#2) ─────────────────────────────

export async function handlePhotoDelete(env: Env, request: Request, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...CAPTURE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const row = await env.DB.prepare("SELECT id FROM photos WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!row) return jsonErr(404, "not_found");
  // Soft delete only. R2 objects are retained permanently — never hard-delete a
  // photo row or an R2 object.
  await env.DB.prepare("UPDATE photos SET is_active = 0 WHERE id = ?").bind(id).run();
  return jsonResponse({ ok: true, soft_deleted: true });
}

// ─── PUT /api/photos/:id/annotate (Sprint 18 — non-destructive markup) ──────
//
// Body: { annotation_data: AnnotationData }  (see src/lib/annotation.ts for the
// JSON↔render contract). Persists the validated overlay to photos.annotation_data
// and sets is_annotated=1. The stored R2 ORIGINAL IS NEVER TOUCHED (business
// rule 1) — the annotated render is composited from original + this JSON at view
// and report time. Sending an empty/cleared overlay removes the annotation.
export async function handlePhotoAnnotate(env: Env, request: Request, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...CAPTURE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }
  const existing = await env.DB.prepare("SELECT id FROM photos WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return jsonErr(404, "not_found");

  const raw = body.annotation_data ?? body;
  const data = validateAnnotationData(raw);
  // A null parse OR an explicit empty overlay clears the annotation.
  const clearing = !data || !hasMarkup(data);

  if (clearing) {
    await env.DB.prepare("UPDATE photos SET annotation_data = NULL, is_annotated = 0 WHERE id = ?")
      .bind(id)
      .run();
    await writeAudit(env, {
      userEmail: user.email,
      action: "photo.annotate.clear",
      entityType: "photo",
      entityId: id,
    });
    return jsonResponse({ ok: true, id, is_annotated: false, annotation_data: null });
  }

  const serialized = JSON.stringify(data);
  await env.DB.prepare("UPDATE photos SET annotation_data = ?, is_annotated = 1 WHERE id = ?")
    .bind(serialized, id)
    .run();
  await writeAudit(env, {
    userEmail: user.email,
    action: "photo.annotate",
    entityType: "photo",
    entityId: id,
    details: { shapes: data.shapes.length },
  });
  return jsonResponse({ ok: true, id, is_annotated: true, annotation_data: data });
}

// ─── GET /api/photos/:id/annotation (load saved overlay) ────────────────────
export async function handlePhotoAnnotationGet(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT id, annotation_data, is_annotated FROM photos WHERE id = ?")
    .bind(id)
    .first<{ id: string; annotation_data: string | null; is_annotated: number | null }>();
  if (!row) return jsonErr(404, "not_found");
  const data = row.annotation_data ? validateAnnotationData(row.annotation_data) : null;
  return jsonResponse({
    id: row.id,
    is_annotated: Boolean(row.is_annotated),
    annotation_data: data,
  });
}

// ─── POST /api/photos/pair (Sprint 18 — before/after pairing) ───────────────
//
// Body: { before_id, after_id }. Links the two photos via before_after_pair_id.
// Direction (confirmed against the S8 seam + completion-package before/after
// query): the AFTER photo carries before_after_pair_id = the BEFORE photo's id
// (after → points back to its before), and both rows get their before/after type
// flags set so the existing portal Photos tab + completion package surface them.
// Idempotent: re-pairing the same two is a no-op. Audit-logged.
export async function handlePhotoPair(env: Env, request: Request): Promise<Response> {
  const guarded = await guard(request, env, [...CAPTURE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }
  const beforeId = str(body.before_id);
  const afterId = str(body.after_id);
  if (!beforeId || !afterId) return jsonErr(400, "before_and_after_required");
  if (beforeId === afterId) return jsonErr(400, "cannot_pair_with_self");

  const rows = await env.DB.prepare(
    `SELECT id, job_id FROM photos WHERE id IN (?, ?) AND COALESCE(is_active,1)=1`,
  )
    .bind(beforeId, afterId)
    .all<{ id: string; job_id: string | null }>();
  const found = new Map((rows.results ?? []).map((r) => [r.id, r]));
  if (!found.has(beforeId) || !found.has(afterId)) return jsonErr(404, "photo_not_found");

  // after → before linkage + before/after type flags (so existing seams pick up).
  await env.DB.prepare(
    "UPDATE photos SET before_after_pair_id = ?, is_after_photo = 1, photo_type = 'after', category = 'final' WHERE id = ?",
  )
    .bind(beforeId, afterId)
    .run();
  await env.DB.prepare(
    "UPDATE photos SET is_before_photo = 1, photo_type = 'before', category = 'before' WHERE id = ?",
  )
    .bind(beforeId)
    .run();

  await writeAudit(env, {
    userEmail: user.email,
    action: "photo.pair",
    entityType: "photo",
    entityId: afterId,
    details: { before_id: beforeId, after_id: afterId },
  });
  return jsonResponse({ ok: true, before_id: beforeId, after_id: afterId });
}

// ─── POST /api/photos/unpair ─────────────────────────────────────────────────
// Body: { after_id }. Clears the before_after_pair_id link on the after photo.
export async function handlePhotoUnpair(env: Env, request: Request): Promise<Response> {
  const guarded = await guard(request, env, [...CAPTURE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }
  const afterId = str(body.after_id);
  if (!afterId) return jsonErr(400, "after_id_required");
  const row = await env.DB.prepare(
    "SELECT id, before_after_pair_id FROM photos WHERE id = ?",
  )
    .bind(afterId)
    .first<{ id: string; before_after_pair_id: string | null }>();
  if (!row) return jsonErr(404, "not_found");
  await env.DB.prepare(
    "UPDATE photos SET before_after_pair_id = NULL, is_after_photo = 0 WHERE id = ?",
  )
    .bind(afterId)
    .run();
  await writeAudit(env, {
    userEmail: user.email,
    action: "photo.unpair",
    entityType: "photo",
    entityId: afterId,
    details: { was_paired_to: row.before_after_pair_id },
  });
  return jsonResponse({ ok: true, after_id: afterId, unpaired: true });
}

// ─── GET /api/receipt-photos/:id/line-items (Sprint 37) ─────────────────────
//
// Returns expense_line_items rows for this receipt, including vendor_material
// match info, so the ReceiptMatchReview UI can show catalog update prompts.

interface ExpenseLineItemRow {
  id: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  amount: number;
  matched_estimate_sub_item_id: string | null;
  matched_vendor_material_id: string | null;
  match_confidence: number | null;
  expense_id: string | null;
}

interface VendorMaterialStub {
  id: string;
  vendor_name: string;
  material_name: string;
  unit: string | null;
  last_price: number | null;
}

export async function handleReceiptLineItemsGet(
  env: Env,
  request: Request,
  receiptId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...MATCH_READ_ROLES]);
  if (guarded instanceof Response) return guarded;

  const { results: rows } = await env.DB.prepare(
    `SELECT id, description, quantity, unit, unit_price, amount,
            matched_estimate_sub_item_id, matched_vendor_material_id, match_confidence, expense_id
     FROM expense_line_items
     WHERE receipt_photo_id = ?
     ORDER BY created_at ASC`,
  )
    .bind(receiptId)
    .all<ExpenseLineItemRow>();

  // Hydrate vendor_material details for each matched item.
  const vmIds = [...new Set((rows ?? []).map((r) => r.matched_vendor_material_id).filter(Boolean))] as string[];
  const vmById = new Map<string, VendorMaterialStub>();
  if (vmIds.length > 0) {
    const placeholders = vmIds.map(() => "?").join(",");
    const { results: vmRows } = await env.DB.prepare(
      `SELECT id, vendor_name, material_name, unit, last_price FROM vendor_materials WHERE id IN (${placeholders})`,
    )
      .bind(...vmIds)
      .all<VendorMaterialStub>();
    for (const vm of vmRows ?? []) vmById.set(vm.id, vm);
  }

  const lineItems = (rows ?? []).map((r) => ({
    ...r,
    vendor_material: r.matched_vendor_material_id ? (vmById.get(r.matched_vendor_material_id) ?? null) : null,
    is_new_material_candidate:
      !r.matched_vendor_material_id && r.unit_price !== null && r.unit_price > 0,
  }));

  return jsonResponse({ line_items: lineItems });
}

// ─── POST /api/receipt-photos/:id/confirm-items (Sprint 37) ─────────────────
//
// Unified itemized confirm: creates one expense per line item, applies catalog
// updates, marks the receipt confirmed. Replaces the two-step confirm + apply
// flow for Sprint 37+ receipts.
//
// Body:
// {
//   job_id?: string,
//   date?: string,
//   items: [{
//     id: string,                            expense_line_items.id
//     matched_estimate_sub_item_id?: string | null,  user's final choice for Match A
//     catalog_update?: boolean,              update vendor_materials price (Match B)
//     add_to_catalog?: boolean,              create new vendor_materials entry
//     // For add_to_catalog, vendor_name + material_name + unit inferred from
//     // existing receipt/extraction data — can be overridden here.
//     new_vendor_name?: string,
//     new_material_name?: string,
//     new_unit?: string,
//   }]
// }

interface ConfirmItemInput {
  id: string;
  matched_estimate_sub_item_id: string | null;
  catalog_update: boolean;
  add_to_catalog: boolean;
  new_vendor_name: string | null;
  new_material_name: string | null;
  new_unit: string | null;
}

export async function handleReceiptConfirmItems(
  env: Env,
  request: Request,
  receiptId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...EXPENSE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }

  const rp = await env.DB.prepare(
    `SELECT rp.id, rp.photo_id, rp.expense_id, rp.ai_vendor, rp.ai_date,
            p.job_id AS photo_job_id
     FROM receipt_photos rp JOIN photos p ON p.id = rp.photo_id WHERE rp.id = ?`,
  )
    .bind(receiptId)
    .first<{ id: string; photo_id: string; expense_id: string | null; ai_vendor: string | null; ai_date: string | null; photo_job_id: string | null }>();
  if (!rp) return jsonErr(404, "not_found");
  if (rp.expense_id) {
    return jsonResponse({ ok: true, already_confirmed: true, expense_id: rp.expense_id });
  }

  const jobId = str(body.job_id) ?? rp.photo_job_id;
  const date = str(body.date) ?? rp.ai_date ?? new Date().toISOString().slice(0, 10);
  const vendorName = rp.ai_vendor;

  const rawItems = Array.isArray(body.items) ? (body.items as unknown[]) : [];
  if (rawItems.length === 0) return jsonErr(400, "items_required");

  // Load the expense_line_items rows so we have amount, description etc.
  const eliIds = rawItems.map((i) => str((i as Record<string, unknown>).id)).filter(Boolean) as string[];
  if (eliIds.length === 0) return jsonErr(400, "invalid_items");

  const placeholders = eliIds.map(() => "?").join(",");
  const { results: eliRows } = await env.DB.prepare(
    `SELECT id, description, quantity, unit, unit_price, amount, matched_vendor_material_id
     FROM expense_line_items WHERE receipt_photo_id = ? AND id IN (${placeholders})`,
  )
    .bind(receiptId, ...eliIds)
    .all<ExpenseLineItemRow>();

  const eliById = new Map((eliRows ?? []).map((r) => [r.id, r]));

  const createdExpenseIds: string[] = [];
  let firstExpenseId: string | null = null;

  for (const rawItem of rawItems) {
    const item = rawItem as Record<string, unknown>;
    const eliId = str(item.id);
    if (!eliId) continue;
    const eli = eliById.get(eliId);
    if (!eli) continue;

    const confirmed: ConfirmItemInput = {
      id: eliId,
      matched_estimate_sub_item_id: item.matched_estimate_sub_item_id != null
        ? str(item.matched_estimate_sub_item_id)
        : null,
      catalog_update: Boolean(item.catalog_update),
      add_to_catalog: Boolean(item.add_to_catalog),
      new_vendor_name: str(item.new_vendor_name),
      new_material_name: str(item.new_material_name),
      new_unit: str(item.new_unit),
    };

    const expenseId = await insertFullExpense(env, {
      job_id: jobId,
      expense_type: "material",
      vendor: vendorName,
      description: eli.description,
      amount: eli.amount,
      incurred_date: date,
      estimate_line_item_id: confirmed.matched_estimate_sub_item_id,
      tax_category: null,
      sub_id: null,
      is_1099_reportable: false,
      receipt_photo_id: rp.photo_id,
      receipt_r2_key: null,
      entered_via: "receipt_capture",
      created_by: user.email,
    });

    await env.DB.prepare(
      "UPDATE expense_line_items SET expense_id = ?, matched_estimate_sub_item_id = ? WHERE id = ?",
    )
      .bind(expenseId, confirmed.matched_estimate_sub_item_id, eliId)
      .run();

    createdExpenseIds.push(expenseId);
    if (!firstExpenseId) firstExpenseId = expenseId;

    // Catalog update (Match B): update existing vendor_material price.
    if (confirmed.catalog_update && eli.matched_vendor_material_id && eli.unit_price !== null) {
      await applyVendorMaterialPriceUpdate(env.DB, eli.matched_vendor_material_id, eli.unit_price, date);
    }

    // Add new catalog entry.
    if (confirmed.add_to_catalog && eli.unit_price !== null) {
      const newVendor = confirmed.new_vendor_name ?? vendorName ?? "Unknown Vendor";
      const newMaterial = confirmed.new_material_name ?? eli.description;
      const newUnit = confirmed.new_unit ?? eli.unit ?? null;
      const newId = crypto.randomUUID();
      const priceHistory = JSON.stringify([{ price: eli.unit_price, date }]);
      await env.DB.prepare(
        `INSERT INTO vendor_materials
           (id, vendor_name, material_name, category, unit, last_price, last_purchased_date,
            average_price, price_history, notes, created_at, updated_at)
         VALUES (?, ?, ?, 'materials', ?, ?, ?, ?, ?, NULL, datetime('now'), datetime('now'))`,
      )
        .bind(newId, newVendor, newMaterial, newUnit, eli.unit_price, date, eli.unit_price, priceHistory)
        .run();
      // Link the expense_line_items row back to the new material.
      await env.DB.prepare(
        "UPDATE expense_line_items SET matched_vendor_material_id = ? WHERE id = ?",
      )
        .bind(newId, eliId)
        .run();
    }
  }

  if (!firstExpenseId) return jsonErr(400, "no_items_processed");

  await env.DB.prepare(
    `UPDATE receipt_photos SET expense_id = ?, processing_status = 'confirmed' WHERE id = ?`,
  )
    .bind(firstExpenseId, receiptId)
    .run();

  return jsonResponse(
    { ok: true, expense_ids: createdExpenseIds, receipt_id: receiptId },
    { status: 201 },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Legacy carry-forward handlers (used by the deployed dashboard + PWA). The
// streaming + active-jobs + list endpoints below are unchanged in contract.
// ═══════════════════════════════════════════════════════════════════════════

export async function handlePhotoList(env: Env, url: URL): Promise<Response> {
  const jobId = url.searchParams.get("job_id");
  const since = url.searchParams.get("since");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 500);

  const where: string[] = ["COALESCE(p.is_active, 1) = 1"];
  const binds: unknown[] = [];
  if (jobId === "general") {
    where.push("p.job_id IS NULL");
  } else if (jobId) {
    where.push("p.job_id = ?");
    binds.push(jobId);
  }
  if (since) {
    where.push("COALESCE(p.taken_at, p.created_at) >= ?");
    binds.push(since);
  }
  const rows = await env.DB.prepare(
    `SELECT ${PHOTO_SELECT}
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(p.taken_at, p.created_at) DESC
     LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<PhotoRow>();
  const photos = (rows.results ?? []).map(hydratePhoto);
  return jsonResponse({ as_of: new Date().toISOString(), total: photos.length, photos });
}

export async function handlePhotoStream(
  env: Env,
  id: string,
  variant: "original" | "thumb",
): Promise<Response> {
  const row = await env.DB.prepare("SELECT r2_key, thumb_key FROM photos WHERE id = ?")
    .bind(id)
    .first<{ r2_key: string; thumb_key: string }>();
  if (!row) return jsonErr(404, "not_found");
  const key = variant === "thumb" ? row.thumb_key : row.r2_key;
  const res = await streamObject(env, key);
  if (!res) {
    // Thumb missing → fall back to full-size (#6).
    if (variant === "thumb") {
      const fallback = await streamObject(env, row.r2_key);
      if (fallback) return fallback;
    }
    return jsonErr(404, "object_missing");
  }
  return res;
}

export async function handleActiveJobs(env: Env): Promise<Response> {
  const placeholders = OPEN_JOB_STATUSES.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT j.id, j.job_number, j.title, j.status, j.start_at,
            c.name AS client_name, c.address_street, c.address_city
     FROM jobs j
     LEFT JOIN clients c ON c.id = j.client_id
     WHERE LOWER(COALESCE(j.status,'')) IN (${placeholders})
     ORDER BY COALESCE(j.start_at, j.created_at) DESC
     LIMIT 100`,
  )
    .bind(...OPEN_JOB_STATUSES)
    .all<{
      id: string;
      job_number: number | null;
      title: string | null;
      status: string | null;
      start_at: string | null;
      client_name: string | null;
      address_street: string | null;
      address_city: string | null;
    }>();
  const jobs = (rows.results ?? []).map((r) => ({
    id: r.id,
    job_number: r.job_number,
    title: r.title,
    status: r.status,
    start_at: r.start_at,
    client_name: r.client_name,
    address: [r.address_street, r.address_city].filter(Boolean).join(", ") || null,
  }));
  return jsonResponse({ as_of: new Date().toISOString(), total: jobs.length, jobs });
}

// Legacy PATCH (job_id/category move). Retained for the dashboard "General
// Photos" reassignment. Now respects soft-deleted rows transparently.
export async function handlePhotoPatch(env: Env, id: string, request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }
  const row = await env.DB.prepare("SELECT id, job_id, category FROM photos WHERE id = ?")
    .bind(id)
    .first<{ id: string; job_id: string | null; category: string }>();
  if (!row) return jsonErr(404, "not_found");

  const sets: string[] = [];
  const binds: unknown[] = [];
  if ("job_id" in body) {
    const j = str(body.job_id);
    if (j) {
      const jk = await env.DB.prepare("SELECT 1 AS o FROM jobs WHERE id = ?")
        .bind(j)
        .first<{ o: number }>();
      if (!jk) return jsonErr(400, "unknown_job");
    }
    sets.push("job_id = ?");
    binds.push(j);
  }
  if ("category" in body) {
    sets.push("category = ?");
    binds.push(str(body.category) ?? "progress");
  }
  if (sets.length === 0) return jsonResponse({ ok: true, unchanged: true });
  binds.push(id);
  await env.DB.prepare(`UPDATE photos SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return jsonResponse({ ok: true, id });
}

// ─── GET /api/receipt-photos/queue ──────────────────────────────────────────
//
// Returns all receipt_photos with processing_status='processed' (extracted but
// not yet confirmed), joined with photos + jobs + clients for context.
// Optional ?job_id= narrows to a single job. Ordered oldest-first so backlog
// is reviewed in arrival order.

export async function handleReceiptQueue(
  env: Env,
  request: Request,
  url: URL,
): Promise<Response> {
  const guarded = await guard(request, env, [...MATCH_READ_ROLES]);
  if (guarded instanceof Response) return guarded;

  const jobId = url.searchParams.get("job_id");

  const sql = jobId
    ? `SELECT
         rp.id AS receipt_id,
         rp.photo_id,
         rp.ai_vendor,
         rp.ai_amount,
         rp.ai_date,
         rp.ai_category,
         rp.ai_confidence,
         rp.expense_id,
         rp.processing_status,
         rp.extracted_items,
         rp.created_at,
         p.job_id,
         j.job_number,
         j.title AS job_title,
         c.name AS client_name
       FROM receipt_photos rp
       JOIN photos p ON p.id = rp.photo_id
       LEFT JOIN jobs j ON j.id = p.job_id
       LEFT JOIN clients c ON c.id = j.client_id
       WHERE rp.processing_status = 'processed' AND p.job_id = ?
       ORDER BY rp.created_at ASC`
    : `SELECT
         rp.id AS receipt_id,
         rp.photo_id,
         rp.ai_vendor,
         rp.ai_amount,
         rp.ai_date,
         rp.ai_category,
         rp.ai_confidence,
         rp.expense_id,
         rp.processing_status,
         rp.extracted_items,
         rp.created_at,
         p.job_id,
         j.job_number,
         j.title AS job_title,
         c.name AS client_name
       FROM receipt_photos rp
       JOIN photos p ON p.id = rp.photo_id
       LEFT JOIN jobs j ON j.id = p.job_id
       LEFT JOIN clients c ON c.id = j.client_id
       WHERE rp.processing_status = 'processed'
       ORDER BY rp.created_at ASC`;

  const rows = jobId
    ? await env.DB.prepare(sql).bind(jobId).all<Record<string, unknown>>()
    : await env.DB.prepare(sql).all<Record<string, unknown>>();

  const queue = (rows.results ?? []).map((row) => ({
    receipt_id: row.receipt_id as string,
    photo_id: row.photo_id as string,
    job_id: (row.job_id as string | null) ?? null,
    job_number: (row.job_number as number | null) ?? null,
    job_title: (row.job_title as string | null) ?? null,
    client_name: (row.client_name as string | null) ?? null,
    thumb_url: `/api/photos/${row.photo_id}/thumb`,
    original_url: `/api/photos/${row.photo_id}`,
    ai_vendor: (row.ai_vendor as string | null) ?? null,
    ai_amount: (row.ai_amount as number | null) ?? null,
    ai_date: (row.ai_date as string | null) ?? null,
    ai_category: (row.ai_category as string | null) ?? null,
    ai_confidence: (row.ai_confidence as number | null) ?? null,
    expense_id: (row.expense_id as string | null) ?? null,
    extracted_items: (row.extracted_items as string | null) ?? null,
    processing_status: row.processing_status as string,
    created_at: row.created_at as string,
  }));

  return jsonResponse({ queue, total: queue.length });
}
