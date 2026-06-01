/**
 * Time tracking (Sprint 10).
 *
 *   POST /api/time-entries              clock in   (O/PM/FC)
 *   PUT  /api/time-entries/:id          clock out / edit (O/PM/FC)
 *   GET  /api/jobs/:id/time-entries     per-job history (open + host-gated read)
 *   GET  /api/time-entries/active       currently clocked-in entries (read)
 *
 * Business rules:
 *   - hourly_rate is SNAPSHOTTED from the role's system setting at clock-in and
 *     RETAINED — a later settings change never rewrites a historical row
 *     (§11 rule 5). Editing a closed entry re-snapshots ONLY if the role itself
 *     is explicitly changed.
 *   - hours round to the nearest 0.25; labor_cost = hours × hourly_rate (§5.6).
 *   - One open clock-in per worker at a time (you can't be on two jobs at once);
 *     a second clock-in while open returns 409 with the open entry.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { laborRateForRole } from "../lib/rates.js";
import { round2 } from "../lib/job-costing.js";

const TIME_ROLES = ["owner", "project_manager", "field_crew"] as const;
const VALID_ROLES = new Set(["general", "pm_skilled"]);

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
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Round elapsed hours to the nearest quarter hour (§5.6). */
export function roundQuarterHours(hours: number): number {
  return Math.round(hours / 0.25) * 0.25;
}

interface TimeEntryRow {
  id: string;
  job_id: string;
  worker: string;
  role: string;
  clock_in: string;
  clock_out: string | null;
  hours: number | null;
  hourly_rate: number | null;
  labor_cost: number | null;
  notes: string | null;
  entered_via: string;
  created_at: string;
}

function shape(r: TimeEntryRow) {
  return {
    id: r.id,
    job_id: r.job_id,
    worker: r.worker,
    role: r.role,
    clock_in: r.clock_in,
    clock_out: r.clock_out,
    hours: r.hours,
    hourly_rate: r.hourly_rate,
    labor_cost: r.labor_cost,
    notes: r.notes,
    entered_via: r.entered_via,
    is_active: r.clock_out == null,
    created_at: r.created_at,
  };
}

// ─── POST /api/time-entries (clock in) ───────────────────────────────────────

export async function handleTimeEntryClockIn(env: Env, request: Request): Promise<Response> {
  const guarded = await guard(request, env, [...TIME_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");

  const jobId = str(body.job_id);
  if (!jobId) return err(400, "job_required");
  const jobOk = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
  if (!jobOk) return err(400, "unknown_job");

  const worker =
    str(body.worker) ??
    [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ??
    user.email;
  if (!worker) return err(400, "worker_required");

  const role = str(body.role) ?? "general";
  if (!VALID_ROLES.has(role)) return err(400, "invalid_role", "role must be general|pm_skilled");

  // One open clock-in per worker at a time.
  const open = await env.DB.prepare(
    "SELECT id, job_id FROM time_entries WHERE worker = ? AND clock_out IS NULL LIMIT 1",
  )
    .bind(worker)
    .first<{ id: string; job_id: string }>();
  if (open) {
    return json(
      {
        error: "already_clocked_in",
        message: `${worker} is already clocked in. Clock out first.`,
        open_entry_id: open.id,
        open_job_id: open.job_id,
      },
      { status: 409 },
    );
  }

  const id = crypto.randomUUID();
  const clockIn = str(body.clock_in) ?? new Date().toISOString();
  const hourlyRate = await laborRateForRole(env, role);
  const enteredVia = str(body.entered_via) ?? "web";
  const notes = str(body.notes);

  await env.DB.prepare(
    `INSERT INTO time_entries
       (id, job_id, worker, role, clock_in, clock_out, hours, hourly_rate, labor_cost, notes, entered_via, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, datetime('now'))`,
  )
    .bind(id, jobId, worker, role, clockIn, hourlyRate, notes, enteredVia)
    .run();

  const row = await env.DB.prepare("SELECT * FROM time_entries WHERE id = ?").bind(id).first<TimeEntryRow>();
  return json({ time_entry: row ? shape(row) : null }, { status: 201 });
}

// ─── PUT /api/time-entries/:id (clock out / edit) ────────────────────────────

export async function handleTimeEntryUpdate(env: Env, request: Request, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...TIME_ROLES]);
  if (guarded instanceof Response) return guarded;

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");

  const row = await env.DB.prepare("SELECT * FROM time_entries WHERE id = ?").bind(id).first<TimeEntryRow>();
  if (!row) return err(404, "not_found");

  const sets: string[] = [];
  const binds: unknown[] = [];

  // Role change re-snapshots the rate (the only path that does — rule #5).
  let hourlyRate = row.hourly_rate ?? 0;
  let role = row.role;
  if ("role" in body) {
    const newRole = str(body.role);
    if (!newRole || !VALID_ROLES.has(newRole)) return err(400, "invalid_role");
    if (newRole !== row.role) {
      role = newRole;
      hourlyRate = await laborRateForRole(env, newRole);
      sets.push("role = ?", "hourly_rate = ?");
      binds.push(role, hourlyRate);
    }
  }

  if ("notes" in body) {
    sets.push("notes = ?");
    binds.push(str(body.notes));
  }

  // clock_in edit (rare) — recompute downstream if already closed.
  let clockIn = row.clock_in;
  if ("clock_in" in body) {
    const ci = str(body.clock_in);
    if (!ci) return err(400, "invalid_clock_in");
    clockIn = ci;
    sets.push("clock_in = ?");
    binds.push(ci);
  }

  // Clock-out (or explicit clock_out edit) → compute hours + labor_cost.
  const closing =
    "clock_out" in body || (row.clock_out == null && body.action === "clock_out");
  let clockOut = row.clock_out;
  if (closing) {
    clockOut = str(body.clock_out) ?? new Date().toISOString();
    const inMs = Date.parse(clockIn);
    const outMs = Date.parse(clockOut);
    if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs <= inMs) {
      return err(400, "invalid_clock_out", "clock_out must be after clock_in");
    }
    const rawHours = (outMs - inMs) / 3_600_000;
    const hours = roundQuarterHours(rawHours);
    const laborCost = round2(hours * hourlyRate);
    sets.push("clock_out = ?", "hours = ?", "labor_cost = ?");
    binds.push(clockOut, hours, laborCost);
  } else if (sets.some((s) => s.startsWith("role")) && row.clock_out != null) {
    // Role/rate changed on an already-closed entry → recompute labor_cost from
    // the retained hours with the new rate.
    const laborCost = round2((row.hours ?? 0) * hourlyRate);
    sets.push("labor_cost = ?");
    binds.push(laborCost);
  }

  if (sets.length === 0) return err(400, "no_updatable_fields");

  binds.push(id);
  await env.DB.prepare(`UPDATE time_entries SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  const updated = await env.DB.prepare("SELECT * FROM time_entries WHERE id = ?").bind(id).first<TimeEntryRow>();
  return json({ time_entry: updated ? shape(updated) : null });
}

// ─── GET /api/jobs/:id/time-entries ──────────────────────────────────────────

export async function handleJobTimeEntries(env: Env, jobId: string): Promise<Response> {
  const rows = (
    await env.DB.prepare(
      "SELECT * FROM time_entries WHERE job_id = ? ORDER BY clock_in DESC",
    )
      .bind(jobId)
      .all<TimeEntryRow>()
  ).results ?? [];
  const entries = rows.map(shape);
  const total_labor = round2(entries.reduce((a, e) => a + (e.labor_cost ?? 0), 0));
  const total_hours = round2(entries.reduce((a, e) => a + (e.hours ?? 0), 0));
  return json({ job_id: jobId, total: entries.length, total_hours, total_labor, time_entries: entries });
}

// ─── GET /api/time-entries/active ────────────────────────────────────────────

export async function handleActiveTimeEntries(env: Env, url: URL): Promise<Response> {
  const jobId = (url.searchParams.get("job_id") ?? "").trim();
  const where = ["clock_out IS NULL"];
  const binds: unknown[] = [];
  if (jobId) {
    where.push("job_id = ?");
    binds.push(jobId);
  }
  const rows = (
    await env.DB.prepare(
      `SELECT * FROM time_entries WHERE ${where.join(" AND ")} ORDER BY clock_in ASC`,
    )
      .bind(...binds)
      .all<TimeEntryRow>()
  ).results ?? [];
  return json({ total: rows.length, active: rows.map(shape) });
}
