/**
 * Daily Logs (Sprint 8).
 *
 *   GET  /api/jobs/:id/daily-logs
 *   POST /api/jobs/:id/daily-logs
 *   PUT  /api/daily-logs/:id
 *
 * Photo linking — source of truth is `photos.daily_log_id` (a photo points at
 * its log). `daily_logs.photo_ids` (JSON) is kept as a denormalised mirror for
 * convenience, rewritten from the body's `photo_ids` on each write. The GET
 * resolves linked photos from photos.daily_log_id so the field can't drift.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";

const LOG_ROLES = ["owner", "project_manager", "field_crew", "office_admin"] as const;

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}
function err(status: number, code: string, message?: string): Response {
  return json({ error: code, message: message ?? code }, { status });
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface LogRow {
  id: string;
  job_id: string;
  log_date: string;
  weather: string | null;
  work_performed: string;
  issues: string | null;
  materials_used: string | null;
  crew_on_site: string | null;
  hours_worked: number | null;
  photo_ids: string | null;
  entered_via: string;
  created_at: string;
  created_by: string | null;
}

function parseIds(s: string | null): string[] {
  if (!s) return [];
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
}

async function hydrate(env: Env, row: LogRow) {
  // Source of truth: photos.daily_log_id.
  const linked = await env.DB.prepare(
    `SELECT id, photo_type, caption, taken_at FROM photos
     WHERE daily_log_id = ? AND COALESCE(is_active, 1) = 1
     ORDER BY COALESCE(taken_at, created_at) ASC`,
  )
    .bind(row.id)
    .all<{ id: string; photo_type: string | null; caption: string | null; taken_at: string | null }>();
  const photos = (linked.results ?? []).map((p) => ({
    id: p.id,
    photo_type: p.photo_type,
    caption: p.caption,
    taken_at: p.taken_at,
    thumb_url: `/api/photos/${p.id}/thumb`,
    original_url: `/api/photos/${p.id}`,
  }));
  return {
    id: row.id,
    job_id: row.job_id,
    log_date: row.log_date,
    weather: row.weather,
    work_performed: row.work_performed,
    issues: row.issues,
    materials_used: row.materials_used,
    crew_on_site: row.crew_on_site,
    hours_worked: row.hours_worked,
    photo_ids: parseIds(row.photo_ids),
    entered_via: row.entered_via,
    created_at: row.created_at,
    created_by: row.created_by,
    photos,
  };
}

/** Point the given photos at this log (source of truth) and detach the rest. */
async function relinkPhotos(env: Env, logId: string, jobId: string, ids: string[]): Promise<void> {
  // Detach photos previously linked to this log that aren't in the new set.
  await env.DB.prepare(
    `UPDATE photos SET daily_log_id = NULL WHERE daily_log_id = ?${ids.length ? ` AND id NOT IN (${ids.map(() => "?").join(",")})` : ""}`,
  )
    .bind(logId, ...ids)
    .run();
  // Attach the new set (only photos that belong to the same job).
  for (const pid of ids) {
    await env.DB.prepare(
      "UPDATE photos SET daily_log_id = ? WHERE id = ? AND (job_id = ? OR job_id IS NULL)",
    )
      .bind(logId, pid, jobId)
      .run();
  }
}

// ─── GET /api/jobs/:id/daily-logs ─────────────────────────────────────────────

export async function handleDailyLogList(env: Env, jobId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT * FROM daily_logs WHERE job_id = ? ORDER BY log_date DESC, created_at DESC LIMIT 500",
  )
    .bind(jobId)
    .all<LogRow>();
  const logs = await Promise.all((rows.results ?? []).map((r) => hydrate(env, r)));
  return json({ total: logs.length, daily_logs: logs });
}

// ─── POST /api/jobs/:id/daily-logs ────────────────────────────────────────────

export async function handleDailyLogCreate(env: Env, request: Request, jobId: string): Promise<Response> {
  const guarded = await guard(request, env, [...LOG_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const jobOk = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
  if (!jobOk) return err(404, "job_not_found");

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");
  const logDate = str(body.log_date) ?? new Date().toISOString().slice(0, 10);
  const workPerformed = str(body.work_performed);
  if (!workPerformed) return err(400, "work_performed_required");
  const photoIds = Array.isArray(body.photo_ids) ? body.photo_ids.map(String) : [];

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO daily_logs
       (id, job_id, log_date, weather, work_performed, issues, materials_used,
        crew_on_site, hours_worked, photo_ids, entered_via, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
  )
    .bind(
      id,
      jobId,
      logDate,
      str(body.weather),
      workPerformed,
      str(body.issues),
      str(body.materials_used),
      str(body.crew_on_site),
      numOrNull(body.hours_worked),
      JSON.stringify(photoIds),
      str(body.entered_via) ?? "web",
      user.email,
    )
    .run();

  if (photoIds.length) await relinkPhotos(env, id, jobId, photoIds);

  const row = await env.DB.prepare("SELECT * FROM daily_logs WHERE id = ?").bind(id).first<LogRow>();
  return json({ daily_log: row ? await hydrate(env, row) : null }, { status: 201 });
}

// ─── PUT /api/daily-logs/:id ──────────────────────────────────────────────────

export async function handleDailyLogUpdate(env: Env, request: Request, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...LOG_ROLES]);
  if (guarded instanceof Response) return guarded;

  const existing = await env.DB.prepare("SELECT * FROM daily_logs WHERE id = ?").bind(id).first<LogRow>();
  if (!existing) return err(404, "not_found");

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");

  const sets: string[] = [];
  const binds: unknown[] = [];
  const setField = (key: string, value: unknown) => {
    sets.push(`${key} = ?`);
    binds.push(value);
  };
  if ("log_date" in body) setField("log_date", str(body.log_date) ?? existing.log_date);
  if ("weather" in body) setField("weather", str(body.weather));
  if ("work_performed" in body) {
    const wp = str(body.work_performed);
    if (!wp) return err(400, "work_performed_required");
    setField("work_performed", wp);
  }
  if ("issues" in body) setField("issues", str(body.issues));
  if ("materials_used" in body) setField("materials_used", str(body.materials_used));
  if ("crew_on_site" in body) setField("crew_on_site", str(body.crew_on_site));
  if ("hours_worked" in body) setField("hours_worked", numOrNull(body.hours_worked));

  let photoIds: string[] | null = null;
  if ("photo_ids" in body) {
    photoIds = Array.isArray(body.photo_ids) ? body.photo_ids.map(String) : [];
    setField("photo_ids", JSON.stringify(photoIds));
  }

  if (sets.length === 0) return json({ ok: true, unchanged: true });
  binds.push(id);
  await env.DB.prepare(`UPDATE daily_logs SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  if (photoIds) await relinkPhotos(env, id, existing.job_id, photoIds);

  const row = await env.DB.prepare("SELECT * FROM daily_logs WHERE id = ?").bind(id).first<LogRow>();
  return json({ daily_log: row ? await hydrate(env, row) : null });
}
