/**
 * Persistent Sub Access API (Sprint 34).
 *
 * Public token-auth routes — no Cloudflare Access, same pattern as
 * /api/punch/:token.
 *
 *   GET  /api/sub/:token                     rolled-up view across all jobs
 *   PUT  /api/sub/:token/items/:itemId/done  mark item done (photo required)
 */

import type { Env } from "../env.js";
import { streamObject, putImage } from "../lib/r2.js";
import { triggerNotification } from "../lib/notification-engine.js";

const MAX_COMPLETION_PHOTO_BYTES = 10 * 1024 * 1024;

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

function err(status: number, code: string, message?: string): Response {
  return json({ error: code, message: message ?? code }, { status });
}

interface SubTokenRow {
  id: string;
  sub_id: string;
  token: string;
  last_viewed_at: string | null;
}

interface SubRow {
  id: string;
  company_name: string | null;
  contact_name: string | null;
}

interface PunchItemRow {
  id: string;
  punch_list_id: string;
  job_id: string;
  description: string;
  sub_id: string | null;
  photo_ids: string | null;
  status: string;
  scheduled_date: string | null;
  completed_at: string | null;
  completed_note: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

async function resolveSubToken(env: Env, token: string): Promise<(SubTokenRow & SubRow) | null> {
  return env.DB.prepare(
    `SELECT sat.id, sat.sub_id, sat.token, sat.last_viewed_at,
            COALESCE(s.company_name, s.company) AS company_name,
            COALESCE(s.contact_name, s.primary_contact) AS contact_name
       FROM sub_access_tokens sat
       JOIN subcontractors s ON s.id = sat.sub_id
      WHERE sat.token = ?`,
  )
    .bind(token)
    .first<SubTokenRow & SubRow>();
}

function hydrateItem(row: PunchItemRow) {
  const photoIds = row.photo_ids
    ? row.photo_ids.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  return {
    id: row.id,
    punch_list_id: row.punch_list_id,
    job_id: row.job_id,
    description: row.description,
    sub_id: row.sub_id,
    photo_ids: photoIds,
    status: row.status,
    scheduled_date: row.scheduled_date,
    completed_at: row.completed_at,
    completed_note: row.completed_note,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function handleSubPublicGet(env: Env, token: string): Promise<Response> {
  const tokenRow = await resolveSubToken(env, token);
  if (!tokenRow) return err(404, "invalid_token");

  // Fetch all open items assigned to this sub across all sent punch lists.
  const { results: rawItems } = await env.DB.prepare(
    `SELECT pli.*
       FROM punch_list_items pli
       JOIN punch_lists pl ON pl.id = pli.punch_list_id
      WHERE pli.sub_id = ?
        AND pli.status = 'open'
        AND pl.status = 'sent'
      ORDER BY pli.sort_order ASC, pli.created_at ASC`,
  )
    .bind(tokenRow.sub_id)
    .all<PunchItemRow>();

  const items = (rawItems ?? []).map(hydrateItem);

  // Group by job.
  const jobIds = [...new Set(items.map((i) => i.job_id))];
  const jobGroups: {
    job_id: string;
    job_title: string;
    property_address: string | null;
    items: ReturnType<typeof hydrateItem>[];
  }[] = [];

  for (const jobId of jobIds) {
    const job = await env.DB.prepare(
      `SELECT id, title, property_address FROM jobs WHERE id = ?`,
    )
      .bind(jobId)
      .first<{ id: string; title: string; property_address: string | null }>();
    if (!job) continue;
    jobGroups.push({
      job_id: jobId,
      job_title: job.title,
      property_address: job.property_address,
      items: items.filter((i) => i.job_id === jobId),
    });
  }

  // Best-effort: update last_viewed_at non-blocking.
  env.DB.prepare(
    `UPDATE sub_access_tokens SET last_viewed_at = datetime('now') WHERE token = ?`,
  )
    .bind(token)
    .run()
    .catch(() => {});

  return json({
    sub: {
      company_name: tokenRow.company_name ?? null,
      contact_name: tokenRow.contact_name ?? null,
    },
    jobs: jobGroups,
  });
}

export async function handleSubItemDone(
  env: Env,
  request: Request,
  token: string,
  itemId: string,
): Promise<Response> {
  const tokenRow = await resolveSubToken(env, token);
  if (!tokenRow) return err(404, "invalid_token");

  const contentType = request.headers.get("content-type") ?? "";
  let note: string | null = null;
  let photoFile: Blob | null = null;

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return err(400, "invalid_form_data");
    }
    const noteEntry = form.get("note");
    note = typeof noteEntry === "string" && noteEntry.trim() ? noteEntry.trim() : null;
    const photo = form.get("photo") as Blob | string | null;
    photoFile = photo != null && typeof photo !== "string" && photo.size > 0 ? photo : null;
  } else {
    return err(400, "photo_required", "A completion photo is required");
  }

  if (!photoFile) return err(400, "photo_required", "A completion photo is required");
  if (photoFile.size > MAX_COMPLETION_PHOTO_BYTES) {
    return err(400, "photo_too_large", "Photo too large — please use a smaller image");
  }

  // Fetch item and verify it belongs to this sub (authorization check).
  const item = await env.DB.prepare(
    `SELECT pli.*
       FROM punch_list_items pli
       JOIN punch_lists pl ON pl.id = pli.punch_list_id
      WHERE pli.id = ?
        AND pli.sub_id = ?
        AND pl.status = 'sent'`,
  )
    .bind(itemId, tokenRow.sub_id)
    .first<PunchItemRow>();

  if (!item) return err(404, "item_not_found");
  if (item.status === "done") return json({ ok: true, already_done: true });

  // Store completion photo.
  const photoId = crypto.randomUUID();
  const r2Key = `punch-lists/${item.punch_list_id}/completion-photos/${itemId}.jpg`;

  try {
    const bytes = await photoFile.arrayBuffer();
    await putImage(env, r2Key, bytes, photoFile.type || "image/jpeg");

    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO photos
         (id, created_at, taken_at, job_id, category, r2_key, thumb_key,
          uploaded_by, gps_lat, gps_lng, tags, caption, before_after_pair_id,
          photo_type, latitude, longitude, location_accuracy, r2_thumbnail_key,
          r2_url, uploaded_at, synced_from_offline, task_id, daily_log_id,
          entered_via, is_active, created_by)
       VALUES (?, ?, ?, ?, 'progress', ?, ?, NULL, NULL, NULL, NULL, ?, NULL,
               'punch_list', NULL, NULL, NULL, ?,
               ?, ?, 0, NULL, NULL,
               'sub_link', 1, NULL)`,
    )
      .bind(
        photoId,
        now,
        now,
        item.job_id,
        r2Key,
        r2Key,
        `Punch list completion — ${item.description}`,
        r2Key,
        `/api/photos/${photoId}`,
        now,
      )
      .run();
  } catch (e) {
    console.warn("[sub-access] completion photo upload failed:", e);
    return err(500, "upload_failed", "Upload failed — please try again");
  }

  const existingIds = item.photo_ids
    ? item.photo_ids.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const photoIds = [...existingIds, photoId].join(",");

  await env.DB.prepare(
    `UPDATE punch_list_items SET status = 'done', completed_at = datetime('now'),
       completed_note = ?, photo_ids = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(note, photoIds, itemId)
    .run();

  // Check if all items on this punch list are now done.
  const open = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM punch_list_items WHERE punch_list_id = ? AND status = 'open'`,
  )
    .bind(item.punch_list_id)
    .first<{ n: number }>();

  const job = await env.DB.prepare(`SELECT title FROM jobs WHERE id = ?`)
    .bind(item.job_id)
    .first<{ title: string }>();
  const jobTitle = job?.title ?? "Project";
  const subName = tokenRow.contact_name || tokenRow.company_name || "Sub";

  if (open && open.n === 0) {
    await triggerNotification(env, "punch_list_complete", {
      jobId: item.job_id,
      merge: { job_title: jobTitle },
      linkPath: `/app/jobs/${item.job_id}`,
    });
  } else {
    await triggerNotification(env, "punch_list_item_done", {
      jobId: item.job_id,
      merge: { sub_name: subName, item_count: "1", job_title: jobTitle },
      linkPath: `/app/jobs/${item.job_id}`,
    });
  }

  return json({ ok: true, all_complete: open?.n === 0 });
}
