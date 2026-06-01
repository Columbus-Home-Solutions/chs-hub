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
import { guard } from "../middleware/guard.js";
import { insertFullExpense } from "./expenses.js";

// O/PM/FC may capture; expense creation on confirm is gated O/PM/FC (FC allowed
// for expense per the route map note).
const CAPTURE_ROLES = ["owner", "project_manager", "field_crew", "office_admin"] as const;
const EXPENSE_ROLES = ["owner", "project_manager", "field_crew"] as const;

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
  p.tags, p.entered_via,
  rp.id AS rp_id, rp.processing_status AS rp_status, rp.ai_vendor AS rp_vendor,
  rp.ai_amount AS rp_amount, rp.ai_date AS rp_date, rp.ai_category AS rp_category,
  rp.ai_confidence AS rp_confidence, rp.expense_id AS rp_expense_id
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

export async function handleReceiptCreate(env: Env, request: Request): Promise<Response> {
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

export async function handlePhotoPut(env: Env, request: Request, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...CAPTURE_ROLES]);
  if (guarded instanceof Response) return guarded;

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

  const sets: string[] = [];
  const binds: unknown[] = [];
  if ("caption" in body) {
    sets.push("caption = ?");
    binds.push(str(body.caption));
  }
  if ("photo_type" in body) {
    const t = str(body.photo_type) ?? "job_progress";
    const photo_type = PHOTO_TYPES.has(t) ? t : "job_progress";
    sets.push("photo_type = ?", "category = ?");
    binds.push(photo_type, LEGACY_CATEGORY[photo_type] ?? "progress");
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

// ─── DEFERRED SEAM: PUT /api/photos/:id/annotate (Sprint 18+) ───────────────
// The annotation_data column + is_annotated flag exist. The drawing UI and the
// real endpoint are out of scope for Sprint 8. This stub records intent only.
// TODO(Sprint 18): implement markup persistence to annotation_data.
export async function handlePhotoAnnotate(_env: Env, _id: string): Promise<Response> {
  return jsonErr(501, "not_implemented", "Photo annotation lands in a later sprint (Sprint 18).");
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
