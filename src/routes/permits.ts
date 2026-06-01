/**
 * Permits — Sprint 13 (Job Management §3, §4). Tracking only — permits do NOT
 * gate job status this sprint (rule #8). Full CRUD on the shipped `permits`
 * table (0014_jobs_schema.sql).
 *
 *   GET    /api/jobs/:id/permits   permits for a job
 *   POST   /api/jobs/:id/permits   create
 *   PUT    /api/permits/:id        update (status, dates, inspection result, cost)
 *   DELETE /api/permits/:id        remove (hard — no is_active column)
 *
 * Permit DOCUMENT attachment is left as a labeled seam to Sprint 15 (Document
 * Management): the table has a document_id column, but documents are an S15
 * concern, so this sprint tracks document_id passively and does not build upload.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";

const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;

// Lifecycle (tracking only): applied → approved → inspection_scheduled →
// passed / failed → closed. Permissive so an owner can correct out of order.
const PERMIT_STATUSES = new Set([
  "applied",
  "approved",
  "inspection_scheduled",
  "passed",
  "failed",
  "closed",
]);
const INSPECTION_RESULTS = new Set(["pending", "passed", "failed", "partial"]);

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
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface PermitRow {
  id: string;
  job_id: string;
  permit_type: string | null;
  permit_number: string | null;
  status: string | null;
  applied_date: string | null;
  approved_date: string | null;
  inspection_date: string | null;
  inspection_result: string | null;
  cost: number | null;
  document_id: string | null;
  notes: string | null;
  created_at: string | null;
}

const PERMIT_COLUMNS = `id, job_id, permit_type, permit_number, status, applied_date, approved_date,
  inspection_date, inspection_result, cost, document_id, notes, created_at`;

function shape(p: PermitRow) {
  return {
    id: p.id,
    job_id: p.job_id,
    permit_type: p.permit_type,
    permit_number: p.permit_number,
    status: p.status ?? "applied",
    applied_date: p.applied_date,
    approved_date: p.approved_date,
    inspection_date: p.inspection_date,
    inspection_result: p.inspection_result,
    cost: p.cost != null ? Math.round(p.cost * 100) / 100 : null,
    document_id: p.document_id, // S15 seam — no upload UI this sprint
    notes: p.notes,
    created_at: p.created_at,
  };
}

async function loadPermit(env: Env, id: string): Promise<PermitRow | null> {
  return env.DB.prepare(`SELECT ${PERMIT_COLUMNS} FROM permits WHERE id = ?`).bind(id).first<PermitRow>();
}

// ─── GET /api/jobs/:id/permits ───────────────────────────────────────────────

export async function handleJobPermits(env: Env, jobId: string): Promise<Response> {
  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
  if (!job) return err(404, "not_found", "Job not found.");
  const rows = (
    await env.DB.prepare(
      `SELECT ${PERMIT_COLUMNS} FROM permits WHERE job_id = ?
        ORDER BY COALESCE(applied_date, created_at) ASC`,
    )
      .bind(jobId)
      .all<PermitRow>()
  ).results ?? [];
  return json({ job_id: jobId, permits: rows.map(shape) });
}

// ─── POST /api/jobs/:id/permits ──────────────────────────────────────────────

export async function handlePermitCreate(request: Request, env: Env, jobId: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
  if (!job) return err(404, "not_found", "Job not found.");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON.");
  const permitType = str(body.permit_type);
  if (!permitType) return err(400, "bad_request", "permit_type is required.");
  const status = str(body.status) ?? "applied";
  if (!PERMIT_STATUSES.has(status)) return err(400, "bad_request", "Invalid permit status.");
  const inspectionResult = str(body.inspection_result);
  if (inspectionResult && !INSPECTION_RESULTS.has(inspectionResult)) {
    return err(400, "bad_request", "Invalid inspection_result.");
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO permits
       (id, job_id, permit_type, permit_number, status, applied_date, approved_date,
        inspection_date, inspection_result, cost, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      id,
      jobId,
      permitType,
      str(body.permit_number),
      status,
      str(body.applied_date),
      str(body.approved_date),
      str(body.inspection_date),
      inspectionResult,
      num(body.cost),
      str(body.notes),
    )
    .run();

  return json({ permit: shape((await loadPermit(env, id))!) }, { status: 201 });
}

// ─── PUT /api/permits/:id ────────────────────────────────────────────────────

export async function handlePermitUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const existing = await loadPermit(env, id);
  if (!existing) return err(404, "not_found", "Permit not found.");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON.");

  const sets: string[] = [];
  const binds: unknown[] = [];
  const strFields = [
    "permit_type",
    "permit_number",
    "applied_date",
    "approved_date",
    "inspection_date",
    "notes",
  ];
  for (const f of strFields) {
    if (f in body) {
      sets.push(`${f} = ?`);
      binds.push(str(body[f]));
    }
  }
  if ("status" in body) {
    const s = str(body.status);
    if (!s || !PERMIT_STATUSES.has(s)) return err(400, "bad_request", "Invalid permit status.");
    sets.push("status = ?");
    binds.push(s);
  }
  if ("inspection_result" in body) {
    const r = str(body.inspection_result);
    if (r && !INSPECTION_RESULTS.has(r)) return err(400, "bad_request", "Invalid inspection_result.");
    sets.push("inspection_result = ?");
    binds.push(r);
  }
  if ("cost" in body) {
    sets.push("cost = ?");
    binds.push(num(body.cost));
  }
  if (sets.length === 0) return err(400, "bad_request", "No editable fields supplied.");

  binds.push(id);
  await env.DB.prepare(`UPDATE permits SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return json({ permit: shape((await loadPermit(env, id))!) });
}

// ─── DELETE /api/permits/:id ─────────────────────────────────────────────────

export async function handlePermitDelete(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const existing = await loadPermit(env, id);
  if (!existing) return err(404, "not_found", "Permit not found.");
  await env.DB.prepare("DELETE FROM permits WHERE id = ?").bind(id).run();
  return json({ ok: true, deleted: id });
}
