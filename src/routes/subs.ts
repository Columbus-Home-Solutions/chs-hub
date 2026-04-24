/**
 * Subcontractor reference list — D1-backed CRUD.
 *
 *   POST   /api/subs           — create
 *   GET    /api/subs           — list (?status=Active|Inactive|all, ?trade=, ?q=, ?rehire=yes|no)
 *   GET    /api/subs/:id       — read
 *   PATCH  /api/subs/:id       — partial update
 *   DELETE /api/subs/:id       — delete
 *
 * `completeness_pct` is computed server-side from 11 tracked fields so it
 * stays in sync without manual formulas.
 */

import type { Env } from "../env.js";

export interface SubRow {
  id: string;
  created_at: string;
  updated_at: string;
  company: string | null;
  trade: string | null;
  primary_contact: string | null;
  reference_type: string | null;
  phone: string | null;
  email: string | null;
  city_state: string | null;
  service_area: string | null;
  license_number: string | null;
  insurance_verified: boolean;
  years_worked: number | null;
  last_project: string | null;
  last_project_date: string | null;
  rating: number | null;
  would_rehire: boolean | null;
  notes: string | null;
  website: string | null;
  follow_up_date: string | null;
  active_status: "Active" | "Inactive";
  completeness_pct: number;
}

interface RawSubRow {
  id: string;
  created_at: string;
  updated_at: string;
  company: string | null;
  trade: string | null;
  primary_contact: string | null;
  reference_type: string | null;
  phone: string | null;
  email: string | null;
  city_state: string | null;
  service_area: string | null;
  license_number: string | null;
  insurance_verified: number;
  years_worked: number | null;
  last_project: string | null;
  last_project_date: string | null;
  rating: number | null;
  would_rehire: number | null;
  notes: string | null;
  website: string | null;
  follow_up_date: string | null;
  active_status: string;
}

// Fields that count toward completeness. Picked to match what matters
// operationally (contact info, license/insurance, rating, rehire signal, notes).
const COMPLETENESS_FIELDS: (keyof RawSubRow)[] = [
  "company",
  "trade",
  "primary_contact",
  "phone",
  "email",
  "city_state",
  "license_number",
  "insurance_verified",
  "rating",
  "would_rehire",
  "notes",
];

function computeCompleteness(row: RawSubRow): number {
  let filled = 0;
  for (const f of COMPLETENESS_FIELDS) {
    const v = row[f];
    if (f === "insurance_verified") {
      if (v === 1) filled += 1;
    } else if (f === "would_rehire") {
      if (v === 0 || v === 1) filled += 1;
    } else if (v !== null && v !== undefined && String(v).trim() !== "") {
      filled += 1;
    }
  }
  return Math.round((filled / COMPLETENESS_FIELDS.length) * 100);
}

function hydrate(row: RawSubRow): SubRow {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    company: row.company,
    trade: row.trade,
    primary_contact: row.primary_contact,
    reference_type: row.reference_type,
    phone: row.phone,
    email: row.email,
    city_state: row.city_state,
    service_area: row.service_area,
    license_number: row.license_number,
    insurance_verified: row.insurance_verified === 1,
    years_worked: row.years_worked,
    last_project: row.last_project,
    last_project_date: row.last_project_date,
    rating: row.rating,
    would_rehire: row.would_rehire === null ? null : row.would_rehire === 1,
    notes: row.notes,
    website: row.website,
    follow_up_date: row.follow_up_date,
    active_status: row.active_status === "Inactive" ? "Inactive" : "Active",
    completeness_pct: computeCompleteness(row),
  };
}

// All writable columns (excluding id/created_at/updated_at). Used by both
// create and patch; each uses a permissive shape that drops unknown keys.
const WRITABLE: string[] = [
  "company",
  "trade",
  "primary_contact",
  "reference_type",
  "phone",
  "email",
  "city_state",
  "service_area",
  "license_number",
  "insurance_verified",
  "years_worked",
  "last_project",
  "last_project_date",
  "rating",
  "would_rehire",
  "notes",
  "website",
  "follow_up_date",
  "active_status",
];

function coerce(col: string, v: unknown): unknown {
  if (v === "" || v === undefined) return null;
  if (col === "insurance_verified") {
    if (v === true || v === 1 || v === "1" || v === "Yes" || v === "yes") return 1;
    return 0;
  }
  if (col === "would_rehire") {
    if (v === null) return null;
    if (v === true || v === 1 || v === "1" || v === "Yes" || v === "yes") return 1;
    if (v === false || v === 0 || v === "0" || v === "No" || v === "no") return 0;
    return null;
  }
  if (col === "years_worked") {
    if (v === null) return null;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
  }
  if (col === "rating") {
    if (v === null) return null;
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (!Number.isFinite(n)) return null;
    return Math.max(1, Math.min(5, Math.round(n)));
  }
  if (col === "active_status") {
    return v === "Inactive" ? "Inactive" : "Active";
  }
  return typeof v === "string" ? v.trim() : v;
}

// ─── POST /api/subs ─────────────────────────────────────────────────────

export async function handleSubCreate(env: Env, request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const cols = ["id", "created_at", "updated_at", ...WRITABLE];
  const values: unknown[] = [id, now, now];
  for (const c of WRITABLE) {
    const coerced = coerce(c, body[c]);
    if (c === "insurance_verified") values.push(coerced ?? 0);
    else if (c === "active_status") values.push(coerced ?? "Active");
    else values.push(coerced);
  }

  const placeholders = cols.map(() => "?").join(", ");
  await env.DB.prepare(
    `INSERT INTO subcontractors (${cols.join(", ")}) VALUES (${placeholders})`,
  )
    .bind(...values)
    .run();

  const row = await env.DB.prepare(`SELECT * FROM subcontractors WHERE id = ?`)
    .bind(id)
    .first<RawSubRow>();
  return json(201, { sub: row ? hydrate(row) : null });
}

// ─── GET /api/subs ──────────────────────────────────────────────────────

export async function handleSubList(env: Env, url: URL): Promise<Response> {
  const status = url.searchParams.get("status") ?? "Active"; // Active|Inactive|all
  const trade = url.searchParams.get("trade") ?? "";
  const rehire = url.searchParams.get("rehire") ?? ""; // yes|no|unknown
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "500", 10) || 500,
    2000,
  );

  const where: string[] = [];
  const binds: unknown[] = [];
  if (status === "Active") where.push(`active_status = 'Active'`);
  else if (status === "Inactive") where.push(`active_status = 'Inactive'`);
  if (trade) {
    where.push(`LOWER(trade) = LOWER(?)`);
    binds.push(trade);
  }
  if (rehire === "yes") where.push(`would_rehire = 1`);
  else if (rehire === "no") where.push(`would_rehire = 0`);
  else if (rehire === "unknown") where.push(`would_rehire IS NULL`);

  const sql = `SELECT * FROM subcontractors
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY company COLLATE NOCASE ASC LIMIT ?`;
  const rows = await env.DB.prepare(sql).bind(...binds, limit).all<RawSubRow>();
  let subs = (rows.results ?? []).map(hydrate);

  if (q) {
    subs = subs.filter((s) => {
      const hay = [
        s.company,
        s.trade,
        s.primary_contact,
        s.phone,
        s.email,
        s.city_state,
        s.service_area,
        s.license_number,
        s.reference_type,
        s.last_project,
        s.notes,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  // Distinct trades (for filter dropdown seeding) — computed from the full
  // set regardless of filter, so the UI always has all options.
  const tradesAll = await env.DB.prepare(
    `SELECT DISTINCT trade FROM subcontractors WHERE trade IS NOT NULL AND trade != '' ORDER BY trade`,
  ).all<{ trade: string }>();
  const trades = (tradesAll.results ?? []).map((r) => r.trade).filter(Boolean);

  return json(200, {
    as_of: new Date().toISOString(),
    total: subs.length,
    trades,
    subs,
  });
}

// ─── GET /api/subs/:id ──────────────────────────────────────────────────

export async function handleSubGet(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT * FROM subcontractors WHERE id = ?`)
    .bind(id)
    .first<RawSubRow>();
  if (!row) return jsonErr(404, "not_found");
  return json(200, { sub: hydrate(row) });
}

// ─── PATCH /api/subs/:id ────────────────────────────────────────────────

export async function handleSubPatch(
  env: Env,
  id: string,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }

  const existing = await env.DB.prepare(`SELECT id FROM subcontractors WHERE id = ?`)
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return jsonErr(404, "not_found");

  const updates: string[] = [];
  const binds: unknown[] = [];
  for (const c of WRITABLE) {
    if (c in body) {
      updates.push(`${c} = ?`);
      binds.push(coerce(c, body[c]));
    }
  }
  if (updates.length === 0) return jsonErr(400, "no_updatable_fields");

  const now = new Date().toISOString();
  updates.push("updated_at = ?");
  binds.push(now);
  binds.push(id);

  await env.DB.prepare(
    `UPDATE subcontractors SET ${updates.join(", ")} WHERE id = ?`,
  )
    .bind(...binds)
    .run();

  const row = await env.DB.prepare(`SELECT * FROM subcontractors WHERE id = ?`)
    .bind(id)
    .first<RawSubRow>();
  return json(200, { sub: row ? hydrate(row) : null });
}

// ─── DELETE /api/subs/:id ───────────────────────────────────────────────

export async function handleSubDelete(env: Env, id: string): Promise<Response> {
  const existing = await env.DB.prepare(`SELECT id FROM subcontractors WHERE id = ?`)
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return jsonErr(404, "not_found");
  await env.DB.prepare(`DELETE FROM subcontractors WHERE id = ?`).bind(id).run();
  return json(200, { deleted: true });
}

// ─── helpers ────────────────────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function jsonErr(status: number, code: string, message?: string): Response {
  return json(status, { error: code, message: message ?? code });
}
