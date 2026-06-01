/**
 * Scheduling — Sprint 13 (Job Management §4.6, §4.8, §5.5). Owner-write; the
 * portal Schedule tab is read-only for clients (rule #6).
 *
 *   GET    /api/jobs/:id/schedule     entries for a job, ordered by date
 *   GET    /api/schedule?from=&to=    cross-job calendar feed
 *   POST   /api/jobs/:id/schedule     create an entry
 *   PUT    /api/schedule/:id          edit / drag-to-reschedule / status
 *   DELETE /api/schedule/:id          remove an entry (hard — no is_active column)
 *
 * Sub-notify (Opus piece): when an entry is created (or first gains a sub_id on
 * edit), fire triggerSubScheduled ONCE and flip schedule_entries.notification_sent
 * to 1 so later edits never re-spam (rule #5). SIMULATE only. The schedule row is
 * the single source of truth feeding BOTH the portal read and the sub notify.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { triggerSubScheduled } from "../lib/notification-engine.js";

const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;

const ENTRY_STATUSES = new Set([
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
  "weather_delay",
]);

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

interface EntryRow {
  id: string;
  job_id: string;
  scheduled_date: string | null;
  trade_or_work: string | null;
  sub_id: string | null;
  start_time: string | null;
  end_time: string | null;
  notes: string | null;
  notification_sent: number | null;
  status: string | null;
  created_at: string | null;
}

const ENTRY_COLUMNS = `id, job_id, scheduled_date, trade_or_work, sub_id, start_time, end_time,
  notes, notification_sent, status, created_at`;

function shape(e: EntryRow & { sub_name?: string | null; job_title?: string | null; job_number?: number | null }) {
  return {
    id: e.id,
    job_id: e.job_id,
    job_title: e.job_title ?? null,
    job_number: e.job_number ?? null,
    scheduled_date: e.scheduled_date,
    trade_or_work: e.trade_or_work,
    sub_id: e.sub_id,
    sub_name: e.sub_name ?? null,
    start_time: e.start_time,
    end_time: e.end_time,
    notes: e.notes,
    status: e.status ?? "scheduled",
    sub_notified: (e.notification_sent ?? 0) === 1,
    created_at: e.created_at,
  };
}

async function loadEntry(env: Env, id: string): Promise<EntryRow | null> {
  return env.DB.prepare(`SELECT ${ENTRY_COLUMNS} FROM schedule_entries WHERE id = ?`)
    .bind(id)
    .first<EntryRow>();
}

// ─── GET /api/jobs/:id/schedule ──────────────────────────────────────────────

export async function handleJobSchedule(env: Env, jobId: string): Promise<Response> {
  const job = await env.DB.prepare(
    "SELECT id, status, start_date, target_end_date FROM jobs WHERE id = ?",
  )
    .bind(jobId)
    .first<{ id: string; status: string | null; start_date: string | null; target_end_date: string | null }>();
  if (!job) return err(404, "not_found", "Job not found.");

  const rows = (
    await env.DB.prepare(
      `SELECT e.*, COALESCE(s.company_name, s.company) AS sub_name
         FROM schedule_entries e
         LEFT JOIN subcontractors s ON s.id = e.sub_id
        WHERE e.job_id = ?
        ORDER BY e.scheduled_date ASC, e.start_time ASC`,
    )
      .bind(jobId)
      .all<EntryRow & { sub_name: string | null }>()
  ).results ?? [];

  // Surface (never force) the deposit_paid → scheduled lifecycle move (rule #7).
  const suggestScheduled =
    job.status === "deposit_paid" && !!job.start_date && rows.length > 0;

  return json({
    job_id: jobId,
    start_date: job.start_date,
    target_end_date: job.target_end_date,
    suggest_status_scheduled: suggestScheduled,
    entries: rows.map(shape),
  });
}

// ─── GET /api/schedule?from=&to= (cross-job calendar feed) ───────────────────

export async function handleScheduleFeed(env: Env, url: URL): Promise<Response> {
  const from = str(url.searchParams.get("from"));
  const to = str(url.searchParams.get("to"));
  const where: string[] = [];
  const binds: unknown[] = [];
  if (from) {
    where.push("e.scheduled_date >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("e.scheduled_date <= ?");
    binds.push(to);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = (
    await env.DB.prepare(
      `SELECT e.*, COALESCE(s.company_name, s.company) AS sub_name,
              j.title AS job_title, j.job_number AS job_number
         FROM schedule_entries e
         LEFT JOIN subcontractors s ON s.id = e.sub_id
         JOIN jobs j ON j.id = e.job_id
        ${whereSql}
        ORDER BY e.scheduled_date ASC, e.start_time ASC`,
    )
      .bind(...binds)
      .all<EntryRow & { sub_name: string | null; job_title: string | null; job_number: number | null }>()
  ).results ?? [];

  return json({ from, to, entries: rows.map(shape) });
}

// ─── POST /api/jobs/:id/schedule ─────────────────────────────────────────────

export async function handleScheduleCreate(request: Request, env: Env, jobId: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
  if (!job) return err(404, "not_found", "Job not found.");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON.");
  const scheduledDate = str(body.scheduled_date);
  if (!scheduledDate) return err(400, "bad_request", "scheduled_date is required.");
  const tradeOrWork = str(body.trade_or_work);
  if (!tradeOrWork) return err(400, "bad_request", "trade_or_work is required.");
  const subId = str(body.sub_id);
  const status = str(body.status) ?? "scheduled";
  if (!ENTRY_STATUSES.has(status)) return err(400, "bad_request", "Invalid schedule status.");

  if (subId) {
    const sub = await env.DB.prepare("SELECT id FROM subcontractors WHERE id = ?").bind(subId).first<{ id: string }>();
    if (!sub) return err(400, "unknown_sub", "Subcontractor not found.");
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO schedule_entries
       (id, job_id, scheduled_date, trade_or_work, sub_id, start_time, end_time, notes, notification_sent, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))`,
  )
    .bind(
      id,
      jobId,
      scheduledDate,
      tradeOrWork,
      subId,
      str(body.start_time),
      str(body.end_time),
      str(body.notes),
      status,
    )
    .run();

  // Sub-notify fires once, only when a sub is assigned at creation (rule #5).
  if (subId) await notifySubOnce(env, id);

  return json({ entry: shape((await loadEntry(env, id))!) }, { status: 201 });
}

// ─── PUT /api/schedule/:id (edit / reschedule / status) ──────────────────────

export async function handleScheduleUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const existing = await loadEntry(env, id);
  if (!existing) return err(404, "not_found", "Schedule entry not found.");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON.");

  const sets: string[] = [];
  const binds: unknown[] = [];
  const strFields = ["scheduled_date", "trade_or_work", "start_time", "end_time", "notes"];
  for (const f of strFields) {
    if (f in body) {
      sets.push(`${f} = ?`);
      binds.push(str(body[f]));
    }
  }
  if ("status" in body) {
    const s = str(body.status);
    if (!s || !ENTRY_STATUSES.has(s)) return err(400, "bad_request", "Invalid schedule status.");
    sets.push("status = ?");
    binds.push(s);
  }
  let subChangedToAssigned = false;
  if ("sub_id" in body) {
    const subId = str(body.sub_id);
    if (subId) {
      const sub = await env.DB.prepare("SELECT id FROM subcontractors WHERE id = ?").bind(subId).first<{ id: string }>();
      if (!sub) return err(400, "unknown_sub", "Subcontractor not found.");
    }
    sets.push("sub_id = ?");
    binds.push(subId);
    // Newly assigning a sub (where the prior entry had none) should notify once.
    subChangedToAssigned = !!subId && !existing.sub_id;
  }
  if (sets.length === 0) return err(400, "bad_request", "No editable fields supplied.");

  binds.push(id);
  await env.DB.prepare(`UPDATE schedule_entries SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();

  // Fire once: only when a sub was just assigned AND not already notified. Edits
  // to notes/time on an already-notified entry never re-enqueue (rule #5).
  if (subChangedToAssigned) await notifySubOnce(env, id);

  return json({ entry: shape((await loadEntry(env, id))!) });
}

// ─── DELETE /api/schedule/:id ────────────────────────────────────────────────

export async function handleScheduleDelete(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const existing = await loadEntry(env, id);
  if (!existing) return err(404, "not_found", "Schedule entry not found.");
  await env.DB.prepare("DELETE FROM schedule_entries WHERE id = ?").bind(id).run();
  return json({ ok: true, deleted: id });
}

/**
 * Enqueue the sub-scheduled notify EXACTLY ONCE for an entry, then mark
 * notification_sent. Guards on the flag so a double-call (or an edit after the
 * first notify) is a no-op. SIMULATE — dispatch mode unchanged.
 */
async function notifySubOnce(env: Env, entryId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT notification_sent, sub_id FROM schedule_entries WHERE id = ?",
  )
    .bind(entryId)
    .first<{ notification_sent: number | null; sub_id: string | null }>();
  if (!row || !row.sub_id || (row.notification_sent ?? 0) === 1) return;
  await triggerSubScheduled(env, entryId);
  await env.DB.prepare("UPDATE schedule_entries SET notification_sent = 1 WHERE id = ?").bind(entryId).run();
}
