/**
 * Photo capture endpoints — backs the PWA "/capture" flow.
 *
 *   POST /api/photos              — multipart upload (original + thumb + metadata JSON)
 *   GET  /api/photos              — list (?job_id=, ?since=, ?limit=)
 *   GET  /api/photos/:id          — stream original from R2
 *   GET  /api/photos/:id/thumb    — stream thumb from R2
 *   GET  /api/jobs/active         — minimal in-progress jobs list (PWA job switcher)
 *
 * Auth model:
 *   Every dashboard.homesolutionsar.com request lands behind Cloudflare
 *   Access. We read `Cf-Access-Authenticated-User-Email` off the incoming
 *   request to attribute uploads to the crew member who made them. CF Access
 *   guarantees the header is present for any request that passed through
 *   their gate. The raw *.workers.dev URL bypasses Access (intentional, for
 *   curl testing) — in that case we record uploaded_by as NULL.
 *
 * Storage layout in R2:
 *   photos/{job_id|"general"}/{YYYY-MM-DD}/{uuid}.jpg          (original)
 *   photos-thumbs/{job_id|"general"}/{YYYY-MM-DD}/{uuid}.jpg   (~800px thumb)
 *
 * The thumb is generated client-side via a <canvas> resize before upload so
 * we don't pay Cloudflare Images fees and the dashboard browser can render
 * a grid of dozens of photos without pulling multiple MB each.
 */

import type { Env } from "../env.js";

const VALID_CATEGORIES = new Set([
  "before",
  "progress",
  "final",
  "issue",
  "marketing",
  "safety",
  "incident",
]);

// Keep in sync with OPEN_JOB_STATUSES in src/routes/jobs.ts. Duplicated
// here (and not imported) because that file's list lives next to a much
// wider rollup query and we don't want this file pulling in that bag.
const OPEN_JOB_STATUSES = [
  "late",
  "action_required",
  "requires_invoicing",
  "upcoming",
  "on_the_way",
  "active",
  "in_progress",
];

interface PhotoRow {
  id: string;
  created_at: string;
  taken_at: string | null;
  job_id: string | null;
  category: string;
  r2_key: string;
  thumb_key: string;
  uploaded_by: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  tags: string | null;
  caption: string | null;
  before_after_pair_id: string | null;
}

interface PhotoOut {
  id: string;
  created_at: string;
  taken_at: string | null;
  job_id: string | null;
  category: string;
  uploaded_by: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  tags: string[];
  caption: string | null;
  before_after_pair_id: string | null;
  thumb_url: string;
  original_url: string;
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

function hydratePhoto(row: PhotoRow): PhotoOut {
  return {
    id: row.id,
    created_at: row.created_at,
    taken_at: row.taken_at,
    job_id: row.job_id,
    category: row.category,
    uploaded_by: row.uploaded_by,
    gps_lat: row.gps_lat,
    gps_lng: row.gps_lng,
    tags: safeJsonArray(row.tags),
    caption: row.caption,
    before_after_pair_id: row.before_after_pair_id,
    thumb_url: `/api/photos/${row.id}/thumb`,
    original_url: `/api/photos/${row.id}`,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dateBucket(takenAt: string | null): string {
  // YYYY-MM-DD bucket used in the R2 key. Falls back to today if no
  // taken_at supplied (e.g. PWA didn't capture EXIF) or it's unparseable.
  const d = takenAt ? new Date(takenAt) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

function jsonErr(status: number, code: string, message?: string): Response {
  return jsonResponse({ error: code, message: message ?? code }, { status });
}

// workers-types under-narrows FormData.get() to `string | null` even
// though the Workers runtime can return a Blob/File for file uploads.
// Cast through unknown so we can branch on the actual runtime type.
function getEntry(form: FormData, name: string): Blob | string | null {
  return form.get(name) as unknown as Blob | string | null;
}

// ────────────────────────────────────────────────────────────────────────
// POST /api/photos
// ────────────────────────────────────────────────────────────────────────

export async function handlePhotoCreate(
  env: Env,
  request: Request,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonErr(400, "invalid_form_data");
  }

  const original = getEntry(form, "original");
  const thumb = getEntry(form, "thumb");
  const metadataRaw = getEntry(form, "metadata");

  // `instanceof Blob` covers both Blob and File since File extends Blob in
  // the Web Platform spec.
  if (!(original instanceof Blob)) return jsonErr(400, "original_required");
  if (!(thumb instanceof Blob)) return jsonErr(400, "thumb_required");
  if (typeof metadataRaw !== "string") return jsonErr(400, "metadata_required");

  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "metadata_not_json");
  }

  const jobId =
    typeof metadata.job_id === "string" && metadata.job_id.trim()
      ? metadata.job_id.trim()
      : null;
  const category =
    typeof metadata.category === "string" && VALID_CATEGORIES.has(metadata.category)
      ? metadata.category
      : "progress";
  const takenAt =
    typeof metadata.taken_at === "string" && metadata.taken_at
      ? metadata.taken_at
      : null;
  const gpsLat =
    typeof metadata.gps_lat === "number" && Number.isFinite(metadata.gps_lat)
      ? metadata.gps_lat
      : null;
  const gpsLng =
    typeof metadata.gps_lng === "number" && Number.isFinite(metadata.gps_lng)
      ? metadata.gps_lng
      : null;
  const tags = Array.isArray(metadata.tags)
    ? JSON.stringify(metadata.tags.map(String))
    : null;
  const caption =
    typeof metadata.caption === "string" ? metadata.caption.trim() || null : null;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const bucket = dateBucket(takenAt);
  const slug = jobId ?? "general";
  const r2Key = `photos/${slug}/${bucket}/${id}.jpg`;
  const thumbKey = `photos-thumbs/${slug}/${bucket}/${id}.jpg`;

  const uploadedBy =
    request.headers.get("cf-access-authenticated-user-email") ?? null;

  // Read the file bodies once before any writes so a partial failure can't
  // leave R2 dirty without a corresponding D1 row.
  const [originalBytes, thumbBytes] = await Promise.all([
    original.arrayBuffer(),
    thumb.arrayBuffer(),
  ]);

  // R2 first, D1 second — failure to insert into D1 leaves orphan R2
  // objects, which is acceptable: a periodic sweep can list R2 and
  // reconcile against D1 later. The reverse (D1 row pointing at no R2
  // object) is worse because the dashboard would show a broken thumb.
  await Promise.all([
    env.FILES.put(r2Key, originalBytes, {
      httpMetadata: { contentType: original.type || "image/jpeg" },
    }),
    env.FILES.put(thumbKey, thumbBytes, {
      httpMetadata: { contentType: thumb.type || "image/jpeg" },
    }),
  ]);

  await env.DB.prepare(
    `INSERT INTO photos
       (id, created_at, taken_at, job_id, category, r2_key, thumb_key,
        uploaded_by, gps_lat, gps_lng, tags, caption, before_after_pair_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      id,
      now,
      takenAt,
      jobId,
      category,
      r2Key,
      thumbKey,
      uploadedBy,
      gpsLat,
      gpsLng,
      tags,
      caption,
    )
    .run();

  return jsonResponse(
    {
      photo: {
        id,
        thumb_url: `/api/photos/${id}/thumb`,
        original_url: `/api/photos/${id}`,
      },
    },
    { status: 201 },
  );
}

// ────────────────────────────────────────────────────────────────────────
// GET /api/photos
// ────────────────────────────────────────────────────────────────────────

export async function handlePhotoList(env: Env, url: URL): Promise<Response> {
  const jobId = url.searchParams.get("job_id");
  const since = url.searchParams.get("since"); // ISO date
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "200", 10) || 200,
    500,
  );

  const where: string[] = [];
  const binds: unknown[] = [];

  if (jobId === "general") {
    where.push("job_id IS NULL");
  } else if (jobId) {
    where.push("job_id = ?");
    binds.push(jobId);
  }

  if (since) {
    where.push("COALESCE(taken_at, created_at) >= ?");
    binds.push(since);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await env.DB.prepare(
    `SELECT * FROM photos
     ${whereSql}
     ORDER BY COALESCE(taken_at, created_at) DESC
     LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<PhotoRow>();

  const photos = (rows.results ?? []).map(hydratePhoto);

  return jsonResponse({
    as_of: new Date().toISOString(),
    total: photos.length,
    photos,
  });
}

// ────────────────────────────────────────────────────────────────────────
// GET /api/photos/:id  +  /api/photos/:id/thumb
// ────────────────────────────────────────────────────────────────────────

export async function handlePhotoStream(
  env: Env,
  id: string,
  variant: "original" | "thumb",
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT r2_key, thumb_key FROM photos WHERE id = ?`,
  )
    .bind(id)
    .first<{ r2_key: string; thumb_key: string }>();

  if (!row) return jsonErr(404, "not_found");

  const key = variant === "thumb" ? row.thumb_key : row.r2_key;
  const obj = await env.FILES.get(key);
  if (!obj) return jsonErr(404, "object_missing");

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.get("content-type")) headers.set("content-type", "image/jpeg");
  // Short cache: gives the browser a chance to coalesce duplicate fetches
  // (e.g. rapid scroll past a thumb grid) without pinning stale content
  // in case we ever overwrite a key.
  headers.set("cache-control", "private, max-age=300");

  return new Response(obj.body, { headers });
}

// ────────────────────────────────────────────────────────────────────────
// GET /api/jobs/active  — used by the PWA job switcher
// ────────────────────────────────────────────────────────────────────────

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

  return jsonResponse({
    as_of: new Date().toISOString(),
    total: jobs.length,
    jobs,
  });
}
