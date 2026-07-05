/**
 * Warranties (Sprint 38 Part B) — owner-facing read path.
 *
 *   GET  /api/jobs/:id/warranties   list warranty claims for a job
 *   POST /api/jobs/:id/warranties   log a new warranty claim (owner-logged path)
 *
 * The client-submission path lives in portal.ts, NOT here.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";

const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;
const VALID_STATUSES = new Set(["reported", "in_progress", "resolved", "closed"]);

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

interface WarrantyRow {
  id: string;
  job_id: string;
  claim_date: string;
  description: string;
  status: string;
  resolution: string | null;
  resolved_date: string | null;
  cost: number | null;
  photo_ids: string | null;
  submitted_by: string;
  viewed_by_owner: number;
  created_at: string;
}

function shape(r: WarrantyRow) {
  return {
    id: r.id,
    job_id: r.job_id,
    claim_date: r.claim_date,
    description: r.description,
    status: r.status,
    resolution: r.resolution,
    resolved_date: r.resolved_date,
    cost: r.cost,
    photo_ids: r.photo_ids ? (JSON.parse(r.photo_ids) as string[]) : [],
    submitted_by: r.submitted_by ?? "owner",
    viewed_by_owner: (r.viewed_by_owner ?? 1) === 1,
    created_at: r.created_at,
  };
}

export async function handleJobWarrantiesList(
  request: Request,
  env: Env,
  jobId: string,
): Promise<Response> {
  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ id: string }>();
  if (!job) return err(404, "not_found", "Job not found.");

  const { results } = await env.DB.prepare(
    `SELECT id, job_id, claim_date, description, status, resolution, resolved_date,
            cost, photo_ids, COALESCE(submitted_by, 'owner') AS submitted_by,
            COALESCE(viewed_by_owner, 1) AS viewed_by_owner, created_at
       FROM warranties WHERE job_id = ? ORDER BY created_at DESC`,
  )
    .bind(jobId)
    .all<WarrantyRow>();

  const warranties = (results ?? []).map(shape);

  // Mark unread client-submitted claims as viewed once owner fetches them.
  const unread = warranties.filter((w) => w.submitted_by === "client" && !w.viewed_by_owner);
  if (unread.length > 0) {
    const ids = unread.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE warranties SET viewed_by_owner = 1 WHERE id IN (${ids})`,
    )
      .bind(...unread.map((w) => w.id))
      .run();
    for (const w of warranties) {
      if (w.submitted_by === "client") w.viewed_by_owner = true;
    }
  }

  return json({ job_id: jobId, warranties, total: warranties.length });
}

export async function handleJobWarrantyCreate(
  request: Request,
  env: Env,
  jobId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ id: string }>();
  if (!job) return err(404, "not_found", "Job not found.");

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return err(400, "bad_request", "Body must be JSON.");
  }

  const description = str(body.description);
  if (!description) return err(400, "bad_request", "description is required.");

  const claimDate = str(body.claim_date) ?? new Date().toISOString().slice(0, 10);
  const status = str(body.status) ?? "reported";
  if (!VALID_STATUSES.has(status)) {
    return err(400, "bad_request", `status must be one of: ${[...VALID_STATUSES].join(", ")}`);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO warranties (id, job_id, claim_date, description, status, submitted_by, viewed_by_owner, created_at)
     VALUES (?, ?, ?, ?, ?, 'owner', 1, datetime('now'))`,
  )
    .bind(id, jobId, claimDate, description, status)
    .run();

  const row = await env.DB.prepare(
    `SELECT id, job_id, claim_date, description, status, resolution, resolved_date,
            cost, photo_ids, COALESCE(submitted_by, 'owner') AS submitted_by,
            COALESCE(viewed_by_owner, 1) AS viewed_by_owner, created_at
       FROM warranties WHERE id = ?`,
  )
    .bind(id)
    .first<WarrantyRow>();

  return json({ warranty: shape(row!) }, { status: 201 });
}

export async function handleWarrantyUpdate(
  request: Request,
  env: Env,
  warrantyId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const existing = await env.DB.prepare(
    "SELECT id FROM warranties WHERE id = ?",
  )
    .bind(warrantyId)
    .first<{ id: string }>();
  if (!existing) return err(404, "not_found", "Warranty claim not found.");

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return err(400, "bad_request", "Body must be JSON.");
  }

  const sets: string[] = [];
  const binds: unknown[] = [];

  if ("description" in body) { sets.push("description = ?"); binds.push(str(body.description)); }
  if ("status" in body) {
    const s = str(body.status);
    if (!s || !VALID_STATUSES.has(s)) return err(400, "bad_request", "Invalid status.");
    sets.push("status = ?"); binds.push(s);
    if (s === "resolved") { sets.push("resolved_date = date('now')"); }
  }
  if ("resolution" in body) { sets.push("resolution = ?"); binds.push(str(body.resolution)); }
  if ("cost" in body) {
    const c = Number(body.cost);
    sets.push("cost = ?"); binds.push(Number.isFinite(c) ? c : null);
  }

  if (sets.length === 0) return err(400, "bad_request", "No editable fields supplied.");

  binds.push(warrantyId);
  await env.DB.prepare(`UPDATE warranties SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  const row = await env.DB.prepare(
    `SELECT id, job_id, claim_date, description, status, resolution, resolved_date,
            cost, photo_ids, COALESCE(submitted_by, 'owner') AS submitted_by,
            COALESCE(viewed_by_owner, 1) AS viewed_by_owner, created_at
       FROM warranties WHERE id = ?`,
  )
    .bind(warrantyId)
    .first<WarrantyRow>();

  return json({ warranty: shape(row!) });
}
