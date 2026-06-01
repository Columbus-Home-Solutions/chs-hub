/**
 * Mileage tracking (Sprint 10) — manual entry only (GPS/auto-capture is backlog).
 *
 *   GET  /api/mileage?job_id=&from=&to=   list (read; surfaced O-only in the UI)
 *   POST /api/mileage                     create (O/PM)
 *   PUT  /api/mileage/:id                 update (O/PM)
 *
 * deduction_amount = distance_miles × irs_rate, where irs_rate is SNAPSHOTTED
 * from the `irs_mileage_rate` system setting at create time (0.70 for 2026,
 * §11 rule 9). Editing miles recomputes the deduction against the retained
 * snapshot; the snapshot itself is not re-pulled (keep it simple — manual entry).
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { getNumericSetting } from "../lib/rates.js";
import { round2 } from "../lib/job-costing.js";

const MILEAGE_WRITE_ROLES = ["owner", "project_manager"] as const;

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

interface MileageRow {
  id: string;
  job_id: string | null;
  trip_purpose: string;
  start_location: string | null;
  end_location: string | null;
  distance_miles: number;
  trip_date: string;
  irs_rate: number | null;
  deduction_amount: number | null;
  notes: string | null;
  created_at: string;
}

// ─── GET /api/mileage ────────────────────────────────────────────────────────

export async function handleMileageList(env: Env, url: URL): Promise<Response> {
  const jobId = (url.searchParams.get("job_id") ?? "").trim();
  const from = (url.searchParams.get("from") ?? "").trim();
  const to = (url.searchParams.get("to") ?? "").trim();

  const where: string[] = [];
  const binds: unknown[] = [];
  if (jobId === "general") {
    where.push("job_id IS NULL");
  } else if (jobId) {
    where.push("job_id = ?");
    binds.push(jobId);
  }
  if (from) {
    where.push("trip_date >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("trip_date <= ?");
    binds.push(to);
  }
  const sql =
    "SELECT * FROM mileage" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY trip_date DESC, created_at DESC LIMIT 500";
  const rows = (await env.DB.prepare(sql).bind(...binds).all<MileageRow>()).results ?? [];
  const total_deduction = round2(rows.reduce((a, r) => a + (r.deduction_amount ?? 0), 0));
  const total_miles = round2(rows.reduce((a, r) => a + (r.distance_miles ?? 0), 0));
  return json({ total: rows.length, total_miles, total_deduction, mileage: rows });
}

// ─── POST /api/mileage ─────────────────────────────────────────────────────────

export async function handleMileageCreate(env: Env, request: Request): Promise<Response> {
  const guarded = await guard(request, env, [...MILEAGE_WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");

  const tripPurpose = str(body.trip_purpose);
  if (!tripPurpose) return err(400, "trip_purpose_required");
  const miles = Number(body.distance_miles);
  if (!Number.isFinite(miles) || miles <= 0) return err(400, "distance_required", "distance_miles must be positive");
  const tripDate = str(body.trip_date) ?? new Date().toISOString().slice(0, 10);
  const jobId = str(body.job_id);
  if (jobId) {
    const ok = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
    if (!ok) return err(400, "unknown_job");
  }

  const irsRate = await getNumericSetting(env, "irs_mileage_rate");
  const deduction = round2(miles * irsRate);
  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO mileage
       (id, job_id, trip_purpose, start_location, end_location, distance_miles, trip_date, irs_rate, deduction_amount, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      id,
      jobId,
      tripPurpose,
      str(body.start_location),
      str(body.end_location),
      miles,
      tripDate,
      irsRate,
      deduction,
      str(body.notes),
    )
    .run();

  const row = await env.DB.prepare("SELECT * FROM mileage WHERE id = ?").bind(id).first<MileageRow>();
  return json({ mileage: row }, { status: 201 });
}

// ─── PUT /api/mileage/:id ────────────────────────────────────────────────────

export async function handleMileageUpdate(env: Env, request: Request, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...MILEAGE_WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");
  const row = await env.DB.prepare("SELECT * FROM mileage WHERE id = ?").bind(id).first<MileageRow>();
  if (!row) return err(404, "not_found");

  const sets: string[] = [];
  const binds: unknown[] = [];
  let miles = row.distance_miles;
  if ("distance_miles" in body) {
    const m = Number(body.distance_miles);
    if (!Number.isFinite(m) || m <= 0) return err(400, "distance_required");
    miles = m;
    sets.push("distance_miles = ?");
    binds.push(m);
    // Recompute deduction against the retained irs_rate snapshot.
    const rate = row.irs_rate ?? (await getNumericSetting(env, "irs_mileage_rate"));
    sets.push("deduction_amount = ?");
    binds.push(round2(miles * rate));
  }
  for (const [k, col] of [
    ["trip_purpose", "trip_purpose"],
    ["start_location", "start_location"],
    ["end_location", "end_location"],
    ["trip_date", "trip_date"],
    ["notes", "notes"],
  ] as const) {
    if (k in body) {
      sets.push(`${col} = ?`);
      binds.push(str(body[k]));
    }
  }
  if (sets.length === 0) return err(400, "no_updatable_fields");
  binds.push(id);
  await env.DB.prepare(`UPDATE mileage SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  const updated = await env.DB.prepare("SELECT * FROM mileage WHERE id = ?").bind(id).first<MileageRow>();
  return json({ mileage: updated });
}
