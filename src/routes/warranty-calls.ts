/**
 * Warranty calls — tracking + scheduling (no billing).
 *
 *   GET    /api/warranty-calls
 *   GET    /api/warranty-calls/:id
 *   POST   /api/warranty-calls
 *   PATCH  /api/warranty-calls/:id
 *   DELETE /api/warranty-calls/:id          (soft — status = cancelled)
 *   GET    /api/jobs/:id/warranty-calls
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";

const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;
const STATUSES = new Set(["open", "scheduled", "completed", "cancelled"]);

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

interface WarrantyRow {
  id: string;
  job_id: string;
  title: string;
  description: string | null;
  status: string;
  assigned_to: string | null;
  assigned_sub_id: string | null;
  scheduled_date: string | null;
  scheduled_end: string | null;
  completed_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

type WarrantyShape = ReturnType<typeof shape>;

function shape(
  r: WarrantyRow & {
    job_number?: number | null;
    job_title?: string | null;
    client_first_name?: string | null;
    client_last_name?: string | null;
    assignee_name?: string | null;
    sub_name?: string | null;
  },
) {
  const clientName = [r.client_first_name, r.client_last_name].filter(Boolean).join(" ") || null;
  return {
    id: r.id,
    job_id: r.job_id,
    job_number: r.job_number ?? null,
    job_title: r.job_title ?? null,
    client_name: clientName,
    title: r.title,
    description: r.description,
    status: r.status,
    assigned_to: r.assigned_to,
    assigned_sub_id: r.assigned_sub_id,
    assignee_name: r.assignee_name ?? r.sub_name ?? null,
    scheduled_date: r.scheduled_date,
    scheduled_end: r.scheduled_end,
    completed_date: r.completed_date,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const LIST_SQL = `
  SELECT w.*,
         j.job_number, j.title AS job_title,
         c.first_name AS client_first_name, c.last_name AS client_last_name,
         TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS assignee_name,
         COALESCE(s.company_name, s.company) AS sub_name
    FROM warranty_calls w
    JOIN jobs j ON j.id = w.job_id
    LEFT JOIN clients c ON c.id = j.client_id
    LEFT JOIN users u ON u.id = w.assigned_to
    LEFT JOIN subcontractors s ON s.id = w.assigned_sub_id`;

async function loadOne(env: Env, id: string): Promise<WarrantyShape | null> {
  const row = await env.DB.prepare(`${LIST_SQL} WHERE w.id = ?`).bind(id).first<
    WarrantyRow & {
      job_number: number | null;
      job_title: string | null;
      client_first_name: string | null;
      client_last_name: string | null;
      assignee_name: string | null;
      sub_name: string | null;
    }
  >();
  return row ? shape(row) : null;
}

function listWhere(status: string | null): { sql: string; binds: unknown[] } {
  if (!status || status === "all") return { sql: " WHERE w.status != 'cancelled'", binds: [] };
  return { sql: " WHERE w.status = ?", binds: [status] };
}

export async function handleWarrantyCallsList(env: Env, url: URL): Promise<Response> {
  const status = str(url.searchParams.get("status")) ?? "open";
  const { sql, binds } = listWhere(status);
  const rows =
    (
      await env.DB.prepare(`${LIST_SQL}${sql} ORDER BY w.created_at DESC`).bind(...binds).all<
        WarrantyRow & {
          job_number: number | null;
          job_title: string | null;
          client_first_name: string | null;
          client_last_name: string | null;
          assignee_name: string | null;
          sub_name: string | null;
        }
      >()
    ).results ?? [];
  return json({ warranty_calls: rows.map(shape), filter: status ?? "open" });
}

export async function handleJobWarrantyCalls(env: Env, jobId: string): Promise<Response> {
  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
  if (!job) return err(404, "not_found", "Job not found.");
  const rows =
    (
      await env.DB.prepare(`${LIST_SQL} WHERE w.job_id = ? ORDER BY w.created_at DESC`)
        .bind(jobId)
        .all<
          WarrantyRow & {
            job_number: number | null;
            job_title: string | null;
            client_first_name: string | null;
            client_last_name: string | null;
            assignee_name: string | null;
            sub_name: string | null;
          }
        >()
    ).results ?? [];
  return json({ job_id: jobId, warranty_calls: rows.map(shape) });
}

export async function handleWarrantyCallDetail(env: Env, id: string): Promise<Response> {
  const row = await loadOne(env, id);
  if (!row) return err(404, "not_found", "Warranty call not found.");
  return json({ warranty_call: row });
}

export async function handleWarrantyCallCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON.");
  const jobId = str(body.job_id);
  const title = str(body.title);
  if (!jobId) return err(400, "bad_request", "job_id is required.");
  if (!title) return err(400, "bad_request", "title is required.");

  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
  if (!job) return err(404, "not_found", "Job not found.");

  const assignedTo = str(body.assigned_to);
  const assignedSubId = str(body.assigned_sub_id);
  const scheduledDate = str(body.scheduled_date);
  let status = str(body.status) ?? (scheduledDate ? "scheduled" : "open");
  if (!STATUSES.has(status)) return err(400, "bad_request", "Invalid status.");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO warranty_calls
       (id, job_id, title, description, status, assigned_to, assigned_sub_id,
        scheduled_date, scheduled_end, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      jobId,
      title,
      str(body.description),
      status,
      assignedTo,
      assignedSubId,
      scheduledDate,
      str(body.scheduled_end),
      str(body.notes),
      now,
      now,
    )
    .run();

  return json({ warranty_call: (await loadOne(env, id))! }, { status: 201 });
}

export async function handleWarrantyCallUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const existing = await env.DB.prepare("SELECT id FROM warranty_calls WHERE id = ?").bind(id).first<{ id: string }>();
  if (!existing) return err(404, "not_found", "Warranty call not found.");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON.");

  const sets: string[] = [];
  const binds: unknown[] = [];
  const strFields = [
    "title",
    "description",
    "assigned_to",
    "assigned_sub_id",
    "scheduled_date",
    "scheduled_end",
    "notes",
  ] as const;
  for (const f of strFields) {
    if (f in body) {
      sets.push(`${f} = ?`);
      binds.push(str(body[f]));
    }
  }
  if ("status" in body) {
    const s = str(body.status);
    if (!s || !STATUSES.has(s)) return err(400, "bad_request", "Invalid status.");
    sets.push("status = ?");
    binds.push(s);
    if (s === "completed") {
      sets.push("completed_date = datetime('now')");
    }
  }
  if (sets.length === 0) return err(400, "bad_request", "No editable fields supplied.");

  sets.push("updated_at = datetime('now')");
  binds.push(id);
  await env.DB.prepare(`UPDATE warranty_calls SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();

  return json({ warranty_call: (await loadOne(env, id))! });
}

export async function handleWarrantyCallDelete(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const existing = await env.DB.prepare("SELECT id FROM warranty_calls WHERE id = ?").bind(id).first<{ id: string }>();
  if (!existing) return err(404, "not_found", "Warranty call not found.");

  await env.DB.prepare(
    `UPDATE warranty_calls SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(id)
    .run();
  return json({ ok: true, id, status: "cancelled" });
}
