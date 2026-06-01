/**
 * Vendor / Material price book (Sprint 10).
 *
 *   GET  /api/vendor-materials?search=&category=&vendor=   search (read)
 *   POST /api/vendor-materials                              manual create (O/PM)
 *   PUT  /api/vendor-materials/:id                          update (O/PM)
 *
 * Auto-populate from expense history is GATED behind an explicit affordance on
 * the expense form (Open Question 3): only an expense_type='material' carrying a
 * vendor + an explicit material_name + unit upserts a price-book row. We do NOT
 * auto-parse every material description into a catalog entry (a permit fee or a
 * "misc hardware" lump is not a reusable material).
 *
 * Upsert key = (vendor_name, material_name, unit). Idempotent: each price_history
 * entry records its source expense_id, so re-saving the SAME expense updates that
 * entry in place rather than appending — average_price never skews (rule #11).
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { round2 } from "../lib/job-costing.js";

const VM_WRITE_ROLES = ["owner", "project_manager"] as const;

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

interface PriceHistoryEntry {
  date: string;
  price: number;
  vendor: string;
  expense_id?: string | null;
}
interface VendorMaterialRow {
  id: string;
  vendor_name: string;
  material_name: string;
  category: string;
  unit: string;
  last_price: number;
  last_purchased_date: string | null;
  average_price: number | null;
  price_history: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function parseHistory(s: string | null): PriceHistoryEntry[] {
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? (a as PriceHistoryEntry[]) : [];
  } catch {
    return [];
  }
}
function shape(r: VendorMaterialRow) {
  return { ...r, price_history: parseHistory(r.price_history) };
}

// ─── GET /api/vendor-materials ───────────────────────────────────────────────

export async function handleVendorMaterialList(env: Env, url: URL): Promise<Response> {
  const search = (url.searchParams.get("search") ?? "").trim();
  const category = (url.searchParams.get("category") ?? "").trim();
  const vendor = (url.searchParams.get("vendor") ?? "").trim();

  const where: string[] = [];
  const binds: unknown[] = [];
  if (search) {
    where.push("(material_name LIKE ? OR vendor_name LIKE ?)");
    binds.push(`%${search}%`, `%${search}%`);
  }
  if (category) {
    where.push("category = ?");
    binds.push(category);
  }
  if (vendor) {
    where.push("vendor_name LIKE ?");
    binds.push(`%${vendor}%`);
  }
  const sql =
    "SELECT * FROM vendor_materials" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY material_name ASC LIMIT 200";
  const rows = (await env.DB.prepare(sql).bind(...binds).all<VendorMaterialRow>()).results ?? [];
  return json({ total: rows.length, materials: rows.map(shape) });
}

// ─── POST /api/vendor-materials (manual) ─────────────────────────────────────

export async function handleVendorMaterialCreate(env: Env, request: Request): Promise<Response> {
  const guarded = await guard(request, env, [...VM_WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");
  const vendorName = str(body.vendor_name);
  const materialName = str(body.material_name);
  const category = str(body.category) ?? "material";
  const unit = str(body.unit) ?? "ea";
  const price = Number(body.last_price ?? body.price);
  if (!vendorName || !materialName) return err(400, "vendor_and_material_required");
  if (!Number.isFinite(price) || price < 0) return err(400, "price_required");

  const date = str(body.last_purchased_date) ?? new Date().toISOString().slice(0, 10);
  const result = await upsertVendorMaterial(env, {
    vendor: vendorName,
    materialName,
    unit,
    category,
    price,
    date,
    expenseId: null,
    notes: str(body.notes),
  });
  return json({ material: result.row ? shape(result.row) : null, created: result.created }, { status: 201 });
}

// ─── PUT /api/vendor-materials/:id ───────────────────────────────────────────

export async function handleVendorMaterialUpdate(env: Env, request: Request, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...VM_WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");
  const row = await env.DB.prepare("SELECT * FROM vendor_materials WHERE id = ?").bind(id).first<VendorMaterialRow>();
  if (!row) return err(404, "not_found");

  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, col] of [
    ["vendor_name", "vendor_name"],
    ["material_name", "material_name"],
    ["category", "category"],
    ["unit", "unit"],
    ["notes", "notes"],
  ] as const) {
    if (k in body) {
      sets.push(`${col} = ?`);
      binds.push(str(body[k]));
    }
  }
  if ("last_price" in body) {
    const p = Number(body.last_price);
    if (!Number.isFinite(p) || p < 0) return err(400, "price_required");
    sets.push("last_price = ?");
    binds.push(p);
  }
  if (sets.length === 0) return err(400, "no_updatable_fields");
  sets.push("updated_at = datetime('now')");
  binds.push(id);
  await env.DB.prepare(`UPDATE vendor_materials SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  const updated = await env.DB.prepare("SELECT * FROM vendor_materials WHERE id = ?").bind(id).first<VendorMaterialRow>();
  return json({ material: updated ? shape(updated) : null });
}

// ─── Upsert-from-expense helper (idempotent) ─────────────────────────────────

export interface MaterialUpsertInput {
  vendor: string;
  materialName: string;
  unit: string;
  category: string;
  price: number;
  date: string;
  expenseId: string | null;
  notes?: string | null;
}

/**
 * Upsert a price-book row keyed on (vendor_name, material_name, unit).
 * Idempotent w.r.t. a source expense: a re-saved expense (same expenseId)
 * rewrites its existing price_history entry instead of appending.
 */
export async function upsertVendorMaterial(
  env: Env,
  input: MaterialUpsertInput,
): Promise<{ row: VendorMaterialRow | null; created: boolean }> {
  const existing = await env.DB.prepare(
    "SELECT * FROM vendor_materials WHERE vendor_name = ? AND material_name = ? AND unit = ? ORDER BY updated_at DESC LIMIT 1",
  )
    .bind(input.vendor, input.materialName, input.unit)
    .first<VendorMaterialRow>();

  const newEntry: PriceHistoryEntry = {
    date: input.date,
    price: round2(input.price),
    vendor: input.vendor,
    expense_id: input.expenseId,
  };

  if (!existing) {
    const id = crypto.randomUUID();
    const history = [newEntry];
    await env.DB.prepare(
      `INSERT INTO vendor_materials
         (id, vendor_name, material_name, category, unit, last_price, last_purchased_date, average_price, price_history, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
      .bind(
        id,
        input.vendor,
        input.materialName,
        input.category,
        input.unit,
        newEntry.price,
        input.date,
        newEntry.price,
        JSON.stringify(history),
        input.notes ?? null,
      )
      .run();
    const row = await env.DB.prepare("SELECT * FROM vendor_materials WHERE id = ?").bind(id).first<VendorMaterialRow>();
    return { row, created: true };
  }

  const history = parseHistory(existing.price_history);
  // Idempotency: replace this expense's prior entry rather than double-appending.
  const idx = input.expenseId ? history.findIndex((h) => h.expense_id === input.expenseId) : -1;
  if (idx >= 0) history[idx] = newEntry;
  else history.push(newEntry);

  const avg = history.length ? round2(history.reduce((a, h) => a + (h.price ?? 0), 0) / history.length) : newEntry.price;
  // Most recent purchase by date drives last_price/last_purchased_date.
  const latest = [...history].sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? newEntry;

  await env.DB.prepare(
    `UPDATE vendor_materials
       SET last_price = ?, last_purchased_date = ?, average_price = ?, price_history = ?,
           category = COALESCE(?, category), updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(latest.price, latest.date, avg, JSON.stringify(history), input.category, existing.id)
    .run();
  const row = await env.DB.prepare("SELECT * FROM vendor_materials WHERE id = ?").bind(existing.id).first<VendorMaterialRow>();
  return { row, created: false };
}
