/**
 * Vendor & Service Subscriptions — Owner-only cost/renewal tracker.
 *
 *   GET    /api/vendor-subscriptions
 *   GET    /api/vendor-subscriptions/:id
 *   POST   /api/vendor-subscriptions
 *   PUT    /api/vendor-subscriptions/:id
 *   DELETE /api/vendor-subscriptions/:id   (soft-delete: is_active = 0)
 *
 * Informational only — not wired to billing APIs or integration_connections.
 */

import type { Env } from "../env.js";
import { writeAudit, actorEmail } from "../lib/audit.js";

const CATEGORIES = [
  "infrastructure",
  "communications",
  "documents",
  "payments",
  "accounting",
  "ai_cloud",
  "marketing_crm",
  "development",
] as const;

const COST_PERIODS = ["monthly", "annual", "usage_based", "one_time"] as const;

type Category = (typeof CATEGORIES)[number];
type CostPeriod = (typeof COST_PERIODS)[number];

interface VendorSubRow {
  id: string;
  service_name: string;
  category: string;
  cost_amount: number | null;
  cost_period: string | null;
  currency: string;
  renewal_date: string | null;
  auto_renews: number;
  account_email: string | null;
  account_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  support_notes: string | null;
  is_active: number;
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

function shape(row: VendorSubRow) {
  return {
    id: row.id,
    service_name: row.service_name,
    category: row.category,
    cost_amount: row.cost_amount,
    cost_period: row.cost_period,
    currency: row.currency,
    renewal_date: row.renewal_date,
    auto_renews: row.auto_renews === 1,
    account_email: row.account_email,
    account_id: row.account_id,
    contact_name: row.contact_name,
    contact_email: row.contact_email,
    contact_phone: row.contact_phone,
    support_notes: row.support_notes,
    is_active: row.is_active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SELECT = `SELECT id, service_name, category, cost_amount, cost_period, currency,
  renewal_date, auto_renews, account_email, account_id, contact_name, contact_email,
  contact_phone, support_notes, is_active, created_at, updated_at
FROM vendor_subscriptions`;

// ─── GET /api/vendor-subscriptions ───────────────────────────────────────────

export async function handleVendorSubscriptionList(
  env: Env,
  url: URL,
): Promise<Response> {
  const includeInactive = url.searchParams.get("all") === "1";
  const category = str(url.searchParams.get("category"));

  const where: string[] = [];
  const binds: unknown[] = [];
  if (!includeInactive) {
    where.push("is_active = 1");
  }
  if (category) {
    where.push("category = ?");
    binds.push(category);
  }

  const sql = `${SELECT}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY
      CASE WHEN renewal_date IS NULL THEN 1 ELSE 0 END,
      renewal_date ASC,
      service_name ASC`;

  const { results } = await env.DB.prepare(sql).bind(...binds).all<VendorSubRow>();
  return json({
    subscriptions: (results ?? []).map(shape),
    categories: CATEGORIES,
    cost_periods: COST_PERIODS,
  });
}

// ─── GET /api/vendor-subscriptions/:id ───────────────────────────────────────

export async function handleVendorSubscriptionGet(
  env: Env,
  id: string,
): Promise<Response> {
  const row = await env.DB.prepare(`${SELECT} WHERE id = ?`)
    .bind(id)
    .first<VendorSubRow>();
  if (!row) return err(404, "not_found", "Vendor subscription not found");
  return json({ subscription: shape(row) });
}

// ─── POST /api/vendor-subscriptions ──────────────────────────────────────────

export async function handleVendorSubscriptionCreate(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const serviceName = str(body.service_name);
  const category = str(body.category);
  if (!serviceName) return err(400, "bad_request", "service_name is required");
  if (!category || !(CATEGORIES as readonly string[]).includes(category)) {
    return err(400, "bad_request", `category must be one of: ${CATEGORIES.join(", ")}`);
  }

  const costPeriod = str(body.cost_period);
  if (costPeriod && !(COST_PERIODS as readonly string[]).includes(costPeriod)) {
    return err(400, "bad_request", `cost_period must be one of: ${COST_PERIODS.join(", ")}`);
  }

  let costAmount: number | null = null;
  if (body.cost_amount !== null && body.cost_amount !== undefined && body.cost_amount !== "") {
    const n = Number(body.cost_amount);
    if (!Number.isFinite(n)) return err(400, "bad_request", "cost_amount must be a number");
    costAmount = n;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO vendor_subscriptions (
       id, service_name, category, cost_amount, cost_period, currency, renewal_date,
       auto_renews, account_email, account_id, contact_name, contact_email, contact_phone,
       support_notes, is_active, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      id,
      serviceName,
      category as Category,
      costAmount,
      costPeriod as CostPeriod | null,
      str(body.currency) ?? "USD",
      str(body.renewal_date),
      body.auto_renews === false || body.auto_renews === 0 || body.auto_renews === "0" ? 0 : 1,
      str(body.account_email),
      str(body.account_id),
      str(body.contact_name),
      str(body.contact_email),
      str(body.contact_phone),
      str(body.support_notes),
      now,
      now,
    )
    .run();

  await writeAudit(env, {
    userEmail: actorEmail(request),
    action: "vendor_subscription.create",
    entityType: "vendor_subscription",
    entityId: id,
    details: { service_name: serviceName, category },
  });

  const row = await env.DB.prepare(`${SELECT} WHERE id = ?`).bind(id).first<VendorSubRow>();
  return json({ subscription: row ? shape(row) : null }, { status: 201 });
}

// ─── PUT /api/vendor-subscriptions/:id ───────────────────────────────────────

export async function handleVendorSubscriptionUpdate(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const existing = await env.DB.prepare(`${SELECT} WHERE id = ?`)
    .bind(id)
    .first<VendorSubRow>();
  if (!existing) return err(404, "not_found", "Vendor subscription not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const changes: Record<string, { old: unknown; new: unknown }> = {};
  const updates: string[] = [];
  const binds: unknown[] = [];

  const setText = (col: keyof VendorSubRow, value: string | null) => {
    const old = existing[col];
    if (old === value) return;
    changes[col] = { old, new: value };
    updates.push(`${col} = ?`);
    binds.push(value);
  };

  if ("service_name" in body) {
    const v = str(body.service_name);
    if (!v) return err(400, "bad_request", "service_name cannot be empty");
    setText("service_name", v);
  }
  if ("category" in body) {
    const v = str(body.category);
    if (!v || !(CATEGORIES as readonly string[]).includes(v)) {
      return err(400, "bad_request", `category must be one of: ${CATEGORIES.join(", ")}`);
    }
    setText("category", v);
  }
  if ("cost_period" in body) {
    const v = str(body.cost_period);
    if (v && !(COST_PERIODS as readonly string[]).includes(v)) {
      return err(400, "bad_request", `cost_period must be one of: ${COST_PERIODS.join(", ")}`);
    }
    setText("cost_period", v);
  }
  if ("currency" in body) setText("currency", str(body.currency) ?? "USD");
  if ("renewal_date" in body) setText("renewal_date", str(body.renewal_date));
  if ("account_email" in body) setText("account_email", str(body.account_email));
  if ("account_id" in body) setText("account_id", str(body.account_id));
  if ("contact_name" in body) setText("contact_name", str(body.contact_name));
  if ("contact_email" in body) setText("contact_email", str(body.contact_email));
  if ("contact_phone" in body) setText("contact_phone", str(body.contact_phone));
  if ("support_notes" in body) setText("support_notes", str(body.support_notes));

  if ("cost_amount" in body) {
    let next: number | null = null;
    if (body.cost_amount !== null && body.cost_amount !== undefined && body.cost_amount !== "") {
      const n = Number(body.cost_amount);
      if (!Number.isFinite(n)) return err(400, "bad_request", "cost_amount must be a number");
      next = n;
    }
    if (existing.cost_amount !== next) {
      changes.cost_amount = { old: existing.cost_amount, new: next };
      updates.push("cost_amount = ?");
      binds.push(next);
    }
  }

  if ("auto_renews" in body) {
    const next =
      body.auto_renews === false || body.auto_renews === 0 || body.auto_renews === "0" ? 0 : 1;
    if (existing.auto_renews !== next) {
      changes.auto_renews = { old: existing.auto_renews === 1, new: next === 1 };
      updates.push("auto_renews = ?");
      binds.push(next);
    }
  }

  if ("is_active" in body) {
    const next =
      body.is_active === false || body.is_active === 0 || body.is_active === "0" ? 0 : 1;
    if (existing.is_active !== next) {
      changes.is_active = { old: existing.is_active === 1, new: next === 1 };
      updates.push("is_active = ?");
      binds.push(next);
    }
  }

  if (updates.length === 0) return err(400, "bad_request", "No updatable fields supplied");

  const now = new Date().toISOString();
  updates.push("updated_at = ?");
  binds.push(now);
  binds.push(id);

  await env.DB.prepare(
    `UPDATE vendor_subscriptions SET ${updates.join(", ")} WHERE id = ?`,
  )
    .bind(...binds)
    .run();

  await writeAudit(env, {
    userEmail: actorEmail(request),
    action: "vendor_subscription.update",
    entityType: "vendor_subscription",
    entityId: id,
    details: { service_name: existing.service_name, changes },
  });

  const row = await env.DB.prepare(`${SELECT} WHERE id = ?`).bind(id).first<VendorSubRow>();
  return json({ subscription: row ? shape(row) : null });
}

// ─── DELETE /api/vendor-subscriptions/:id ────────────────────────────────────

export async function handleVendorSubscriptionDelete(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const existing = await env.DB.prepare(`${SELECT} WHERE id = ?`)
    .bind(id)
    .first<VendorSubRow>();
  if (!existing) return err(404, "not_found", "Vendor subscription not found");
  if (existing.is_active === 0) {
    return json({ ok: true, subscription: shape(existing) });
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE vendor_subscriptions SET is_active = 0, updated_at = ? WHERE id = ?`,
  )
    .bind(now, id)
    .run();

  await writeAudit(env, {
    userEmail: actorEmail(request),
    action: "vendor_subscription.deactivate",
    entityType: "vendor_subscription",
    entityId: id,
    details: { service_name: existing.service_name },
  });

  const row = await env.DB.prepare(`${SELECT} WHERE id = ?`).bind(id).first<VendorSubRow>();
  return json({ ok: true, subscription: row ? shape(row) : null });
}
