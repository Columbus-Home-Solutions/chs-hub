/**
 * Line item catalog — reusable estimate services/pricing (Settings + autocomplete).
 *
 *   GET    /api/catalog       list or search (?q=, ?include_inactive=true)
 *   POST   /api/catalog       create (owner)
 *   PUT    /api/catalog/:id   update (owner)
 *   DELETE /api/catalog/:id   hard delete (owner)
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";

const WRITE_ROLES = ["owner"] as const;
const READ_ROLES = ["owner", "project_manager", "office_admin"] as const;

interface CatalogRow {
  id: string;
  name: string;
  description: string | null;
  unit: string | null;
  unit_price: number;
  is_active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

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

function bool01(v: unknown, defaultVal: 0 | 1): 0 | 1 {
  if (v === true || v === 1 || v === "1" || v === "true") return 1;
  if (v === false || v === 0 || v === "0" || v === "false") return 0;
  return defaultVal;
}

async function logAudit(
  env: Env,
  userEmail: string,
  action: string,
  entityId: string,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, ?, 'line_item_catalog', ?, ?, datetime('now'))`,
  )
    .bind(crypto.randomUUID(), userEmail, action, entityId, JSON.stringify(details))
    .run();
}

function shapeItem(row: CatalogRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    unit: row.unit,
    unit_price: row.unit_price,
    is_active: (row.is_active ?? 1) === 1,
    sort_order: row.sort_order ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SELECT_FIELDS =
  "id, name, description, unit, unit_price, is_active, sort_order, created_at, updated_at";

async function loadItem(env: Env, id: string): Promise<CatalogRow | null> {
  return env.DB.prepare(`SELECT ${SELECT_FIELDS} FROM line_item_catalog WHERE id = ?`)
    .bind(id)
    .first<CatalogRow>();
}

/** GET /api/catalog */
export async function handleCatalogList(request: Request, env: Env, url: URL): Promise<Response> {
  const guarded = await guard(request, env, [...READ_ROLES]);
  if (guarded instanceof Response) return guarded;

  const q = (url.searchParams.get("q") ?? "").trim();
  if (q) {
    const { results } = await env.DB.prepare(
      `SELECT ${SELECT_FIELDS} FROM line_item_catalog
        WHERE is_active = 1 AND lower(name) LIKE lower(?)
        ORDER BY name ASC
        LIMIT 8`,
    )
      .bind(`%${q}%`)
      .all<CatalogRow>();
    return json({ items: (results ?? []).map(shapeItem) });
  }

  const includeInactive = url.searchParams.get("include_inactive") === "true";
  const where = includeInactive ? "" : "WHERE is_active = 1";
  const { results } = await env.DB.prepare(
    `SELECT ${SELECT_FIELDS} FROM line_item_catalog ${where}
      ORDER BY sort_order ASC, name ASC`,
  ).all<CatalogRow>();

  return json({ items: (results ?? []).map(shapeItem) });
}

/** POST /api/catalog */
export async function handleCatalogCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const name = str(body.name);
  if (!name) return err(400, "bad_request", "name is required");

  const unitPrice = num(body.unit_price);
  if (unitPrice == null || unitPrice < 0) {
    return err(400, "bad_request", "unit_price is required and must be >= 0");
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO line_item_catalog
       (id, name, description, unit, unit_price, is_active, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(
      id,
      name,
      str(body.description),
      str(body.unit),
      unitPrice,
      num(body.sort_order) ?? 0,
      now,
      now,
    )
    .run();

  await logAudit(env, user.email, "catalog_item_created", id, { name, unit_price: unitPrice });
  const row = await loadItem(env, id);
  return json({ item: row ? shapeItem(row) : null }, { status: 201 });
}

/** PUT /api/catalog/:id */
export async function handleCatalogUpdate(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await loadItem(env, id);
  if (!existing) return err(404, "not_found", "Catalog item not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const sets: string[] = [];
  const binds: unknown[] = [];

  if ("name" in body) {
    const name = str(body.name);
    if (!name) return err(400, "bad_request", "name cannot be empty");
    sets.push("name = ?");
    binds.push(name);
  }
  if ("description" in body) {
    sets.push("description = ?");
    binds.push(str(body.description));
  }
  if ("unit" in body) {
    sets.push("unit = ?");
    binds.push(str(body.unit));
  }
  if ("unit_price" in body) {
    const unitPrice = num(body.unit_price);
    if (unitPrice == null || unitPrice < 0) {
      return err(400, "bad_request", "unit_price must be >= 0");
    }
    sets.push("unit_price = ?");
    binds.push(unitPrice);
  }
  if ("is_active" in body) {
    sets.push("is_active = ?");
    binds.push(bool01(body.is_active, 1));
  }
  if ("sort_order" in body) {
    const sortOrder = num(body.sort_order);
    sets.push("sort_order = ?");
    binds.push(sortOrder ?? 0);
  }

  if (sets.length === 0) return err(400, "bad_request", "No updatable fields supplied");

  sets.push("updated_at = datetime('now')");
  binds.push(id);

  await env.DB.prepare(`UPDATE line_item_catalog SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  await logAudit(env, user.email, "catalog_item_updated", id, { fields: Object.keys(body) });
  const row = await loadItem(env, id);
  return json({ item: row ? shapeItem(row) : null });
}

/** DELETE /api/catalog/:id */
export async function handleCatalogDelete(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await loadItem(env, id);
  if (!existing) return err(404, "not_found", "Catalog item not found");

  await env.DB.prepare("DELETE FROM line_item_catalog WHERE id = ?").bind(id).run();
  await logAudit(env, user.email, "catalog_item_deleted", id, { name: existing.name });

  return new Response(null, { status: 204 });
}
