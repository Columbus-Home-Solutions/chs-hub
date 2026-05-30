/**
 * Estimate Builder API (Sprint 4) — turns a pipeline request into a complete,
 * priced estimate: parent line items (client-facing), sub-items (internal
 * cost), payment schedules, templates, saved reviews, and a read-only material
 * search. Mirrors the estimate-requests.ts pattern exactly: thin handlers,
 * parameterized D1 queries, audit logging on every write, role enforcement via
 * guard(), and a "log intent, cron recomputes" WC hook on send.
 *
 * The API is the source of truth for all math — every read recomputes line
 * totals, sub-item costs, the estimate subtotal/total, internal cost, and
 * margin, persists them, and returns them in the payload so the frontend never
 * recomputes authoritative numbers.
 *
 * Estimate endpoints
 *   GET    /api/estimates                              list + filters
 *   GET    /api/estimates/:id                          full nested estimate
 *   POST   /api/estimates                              create from a request
 *   PUT    /api/estimates/:id                          update header
 *   POST   /api/estimates/:id/send                     send-gate + status flip + WC hook
 *   POST   /api/estimates/:id/revise                   clone into a new version
 * Line items (parent — client-facing)
 *   GET    /api/estimates/:id/line-items
 *   POST   /api/estimates/:id/line-items
 *   PUT    /api/line-items/:id
 *   DELETE /api/line-items/:id
 *   PUT    /api/estimates/:id/line-items/reorder
 * Sub-items (internal cost — never client-visible)
 *   POST   /api/line-items/:id/sub-items
 *   PUT    /api/sub-items/:id
 *   DELETE /api/sub-items/:id
 * Payment schedule
 *   GET    /api/estimates/:id/payment-schedule
 *   PUT    /api/estimates/:id/payment-schedule         replace full schedule
 * Templates
 *   GET    /api/estimate-templates
 *   GET    /api/estimate-templates/:id
 *   POST   /api/estimate-templates
 *   PUT    /api/estimate-templates/:id
 *   POST   /api/estimates/:id/apply-template/:templateId
 * Saved reviews
 *   GET/POST /api/reviews ; PUT/DELETE /api/reviews/:id
 * Materials
 *   GET    /api/materials/search?q=
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { triggerQuoteSent } from "../lib/wc/triggers.js";

const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;

// ─── shared helpers (match estimate-requests.ts) ────────────────────────────

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

function bool01(v: unknown, fallback = 0): number {
  if (v === true || v === 1 || v === "1" || v === "true") return 1;
  if (v === false || v === 0 || v === "0" || v === "false") return 0;
  return fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function logAudit(
  env: Env,
  userEmail: string,
  action: string,
  entityType: string,
  entityId: string,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
  )
    .bind(crypto.randomUUID(), userEmail, action, entityType, entityId, JSON.stringify(details))
    .run();
}

// ─── row types ──────────────────────────────────────────────────────────────

interface EstimateRow {
  id: string;
  estimate_number: number | null;
  request_id: string | null;
  client_id: string | null;
  title: string | null;
  estimate_mode: string | null;
  billing_model: string | null;
  status: string;
  subtotal: number | null;
  tax_amount: number | null;
  total: number | null;
  margin_percent: number | null;
  deposit_amount: number | null;
  deposit_type: string | null;
  deposit_percentage: number | null;
  valid_days: number | null;
  expiration_date: string | null;
  portal_token: string | null;
  include_reviews: number | null;
  review_ids: string | null;
  include_contract: number | null;
  contract_template_id: string | null;
  notes: string | null;
  version: number | null;
  revised_from_id: string | null;
  sent_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  created_by: string | null;
}

interface LineItemRow {
  id: string;
  estimate_id: string;
  sort_order: number;
  product_service: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  total: number | null;
  includes_note: string | null;
  created_at: string | null;
}

interface SubItemRow {
  id: string;
  parent_line_item_id: string;
  sort_order: number;
  description: string;
  category: string;
  vendor: string | null;
  quantity: number | null;
  unit: string | null;
  unit_cost: number | null;
  total_cost: number | null;
  material_id: string | null;
  notes: string | null;
  created_at: string | null;
}

interface PaymentRow {
  id: string;
  estimate_id: string;
  sort_order: number;
  description: string;
  percentage: number | null;
  fixed_amount: number | null;
  amount: number | null;
  is_deposit: number | null;
  trigger: string | null;
  notes: string | null;
  created_at: string | null;
}

// ─── computed totals (API is the source of truth for math) ──────────────────

interface Totals {
  subtotal: number;
  total: number;
  internal_cost: number;
  margin_percent: number;
}

/**
 * Recompute every derived number for an estimate from its line items and
 * sub-items, persist the per-row totals + the estimate rollup, and return the
 * rollup. Called after any line-item / sub-item / header mutation and on read.
 */
async function recomputeEstimate(env: Env, estimateId: string): Promise<Totals> {
  const lineItems = (
    await env.DB.prepare("SELECT * FROM estimate_line_items WHERE estimate_id = ?")
      .bind(estimateId)
      .all<LineItemRow>()
  ).results ?? [];

  let subtotal = 0;
  for (const li of lineItems) {
    const lineTotal = round2((li.quantity ?? 0) * (li.unit_price ?? 0));
    subtotal += lineTotal;
    if (li.total !== lineTotal) {
      await env.DB.prepare("UPDATE estimate_line_items SET total = ? WHERE id = ?")
        .bind(lineTotal, li.id)
        .run();
    }
  }
  subtotal = round2(subtotal);

  let internalCost = 0;
  if (lineItems.length > 0) {
    const subItems = (
      await env.DB.prepare(
        `SELECT * FROM estimate_sub_items
         WHERE parent_line_item_id IN (${lineItems.map(() => "?").join(",")})`,
      )
        .bind(...lineItems.map((li) => li.id))
        .all<SubItemRow>()
    ).results ?? [];
    for (const si of subItems) {
      const cost = round2((si.quantity ?? 0) * (si.unit_cost ?? 0));
      internalCost += cost;
      if (si.total_cost !== cost) {
        await env.DB.prepare("UPDATE estimate_sub_items SET total_cost = ? WHERE id = ?")
          .bind(cost, si.id)
          .run();
      }
    }
  }
  internalCost = round2(internalCost);

  const est = await env.DB.prepare(
    "SELECT tax_amount, deposit_type, deposit_percentage FROM estimates WHERE id = ?",
  )
    .bind(estimateId)
    .first<{ tax_amount: number | null; deposit_type: string | null; deposit_percentage: number | null }>();
  const tax = est?.tax_amount ?? 0;
  const total = round2(subtotal + tax);
  const marginPercent = total > 0 ? round2(((total - internalCost) / total) * 100) : 0;

  // Keep a percentage-based deposit (e.g. fixed-price 33%) tracking the live
  // total so it stays meaningful as line items change. Fixed-dollar deposits
  // (user overrides, cost-plus, trade-by-trade) are left untouched.
  if (est?.deposit_type === "percentage" && est.deposit_percentage != null) {
    const depositAmount = round2((est.deposit_percentage / 100) * total);
    await env.DB.prepare(
      "UPDATE estimates SET subtotal = ?, total = ?, margin_percent = ?, deposit_amount = ? WHERE id = ?",
    )
      .bind(subtotal, total, marginPercent, depositAmount, estimateId)
      .run();
  } else {
    await env.DB.prepare(
      "UPDATE estimates SET subtotal = ?, total = ?, margin_percent = ? WHERE id = ?",
    )
      .bind(subtotal, total, marginPercent, estimateId)
      .run();
  }

  return { subtotal, total, internal_cost: internalCost, margin_percent: marginPercent };
}

// ─── shaping ─────────────────────────────────────────────────────────────────

function shapeSubItem(r: SubItemRow) {
  return {
    id: r.id,
    parent_line_item_id: r.parent_line_item_id,
    sort_order: r.sort_order,
    description: r.description,
    category: r.category,
    vendor: r.vendor,
    quantity: r.quantity,
    unit: r.unit,
    unit_cost: r.unit_cost,
    total_cost: round2((r.quantity ?? 0) * (r.unit_cost ?? 0)),
    material_id: r.material_id,
    notes: r.notes,
  };
}

function shapeLineItem(r: LineItemRow, subItems: SubItemRow[]) {
  const subs = subItems
    .filter((s) => s.parent_line_item_id === r.id)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(shapeSubItem);
  return {
    id: r.id,
    estimate_id: r.estimate_id,
    sort_order: r.sort_order,
    product_service: r.product_service,
    description: r.description,
    quantity: r.quantity,
    unit: r.unit,
    unit_price: r.unit_price,
    total: round2((r.quantity ?? 0) * (r.unit_price ?? 0)),
    internal_cost: round2(subs.reduce((a, s) => a + s.total_cost, 0)),
    includes_note: r.includes_note,
    sub_items: subs,
  };
}

function shapePayment(r: PaymentRow, total: number) {
  const amount =
    r.fixed_amount != null
      ? r.fixed_amount
      : r.percentage != null
        ? round2((r.percentage / 100) * total)
        : (r.amount ?? 0);
  return {
    id: r.id,
    estimate_id: r.estimate_id,
    sort_order: r.sort_order,
    description: r.description,
    percentage: r.percentage,
    fixed_amount: r.fixed_amount,
    amount,
    is_deposit: (r.is_deposit ?? 0) === 1,
    trigger: r.trigger,
    notes: r.notes,
  };
}

function shapeEstimateHeader(r: EstimateRow, totals: Totals) {
  return {
    id: r.id,
    estimate_number: r.estimate_number,
    request_id: r.request_id,
    client_id: r.client_id,
    title: r.title,
    estimate_mode: r.estimate_mode,
    billing_model: r.billing_model,
    status: r.status,
    subtotal: totals.subtotal,
    tax_amount: r.tax_amount ?? 0,
    total: totals.total,
    internal_cost: totals.internal_cost,
    margin_percent: totals.margin_percent,
    deposit_amount: r.deposit_amount,
    deposit_type: r.deposit_type,
    deposit_percentage: r.deposit_percentage,
    valid_days: r.valid_days ?? 7,
    expiration_date: r.expiration_date,
    portal_token: r.portal_token,
    include_reviews: (r.include_reviews ?? 1) === 1,
    review_ids: r.review_ids,
    include_contract: (r.include_contract ?? 1) === 1,
    contract_template_id: r.contract_template_id,
    notes: r.notes,
    version: r.version ?? 1,
    revised_from_id: r.revised_from_id,
    sent_at: r.sent_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
  };
}

/** Load the full nested estimate (header + line items + sub-items + schedule) with fresh totals. */
async function loadFullEstimate(env: Env, id: string) {
  const exists = await env.DB.prepare("SELECT id FROM estimates WHERE id = ?").bind(id).first<{ id: string }>();
  if (!exists) return null;

  // Recompute first so the row we read below reflects fresh totals + deposit.
  const totals = await recomputeEstimate(env, id);
  const row = await env.DB.prepare("SELECT * FROM estimates WHERE id = ?").bind(id).first<EstimateRow>();
  if (!row) return null;

  // joined client + request context (best-effort)
  const ctx = await env.DB.prepare(
    `SELECT c.name AS client_name, c.first_name AS c_first, c.last_name AS c_last,
            c.phone AS client_phone, c.email AS client_email,
            er.request_number AS request_number,
            er.property_address, er.property_city, er.property_state, er.property_zip,
            er.job_type
     FROM estimates e
     LEFT JOIN clients c ON c.id = e.client_id
     LEFT JOIN estimate_requests er ON er.id = e.request_id
     WHERE e.id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();

  const lineItems = (
    await env.DB.prepare(
      "SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC",
    )
      .bind(id)
      .all<LineItemRow>()
  ).results ?? [];

  let subItems: SubItemRow[] = [];
  if (lineItems.length > 0) {
    subItems = (
      await env.DB.prepare(
        `SELECT * FROM estimate_sub_items
         WHERE parent_line_item_id IN (${lineItems.map(() => "?").join(",")})
         ORDER BY sort_order ASC`,
      )
        .bind(...lineItems.map((li) => li.id))
        .all<SubItemRow>()
    ).results ?? [];
  }

  const schedule = (
    await env.DB.prepare(
      "SELECT * FROM payment_schedules WHERE estimate_id = ? ORDER BY sort_order ASC",
    )
      .bind(id)
      .all<PaymentRow>()
  ).results ?? [];

  const clientName =
    [ctx?.c_first, ctx?.c_last].filter(Boolean).join(" ").trim() ||
    (ctx?.client_name as string) ||
    null;

  return {
    ...shapeEstimateHeader(row, totals),
    client_name: clientName,
    client_phone: ctx?.client_phone ?? null,
    client_email: ctx?.client_email ?? null,
    request_number: ctx?.request_number ?? null,
    property_address: ctx?.property_address ?? null,
    property_city: ctx?.property_city ?? null,
    property_state: ctx?.property_state ?? null,
    property_zip: ctx?.property_zip ?? null,
    job_type: ctx?.job_type ?? null,
    line_items: lineItems.map((li) => shapeLineItem(li, subItems)),
    payment_schedule: schedule.map((p) => shapePayment(p, totals.total)),
  };
}

// ─── deposit defaults (per billing model) ────────────────────────────────────

async function costPlusDefaultDeposit(env: Env): Promise<number> {
  // Pull from system_settings if a key exists; otherwise the billing-agreement
  // default. TODO(Sprint 5/Financial): formalize the settings key + label.
  const row = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = 'cost_plus_default_deposit'",
  ).first<{ value: string }>();
  const v = row ? Number(row.value) : NaN;
  return Number.isFinite(v) ? v : 1000;
}

/**
 * Compute the default deposit for a billing model given the current total.
 * Returns the columns to persist on the estimate. The user can override later.
 */
async function defaultDeposit(
  env: Env,
  billingModel: string | null,
  total: number,
  firstMilestoneAmount: number | null,
): Promise<{ deposit_amount: number; deposit_type: string; deposit_percentage: number | null }> {
  switch (billingModel) {
    case "fixed_price":
      return {
        deposit_amount: round2(total * 0.33),
        deposit_type: "percentage",
        deposit_percentage: 33,
      };
    case "trade_by_trade":
      // Configurable; default to the first milestone if one exists, else 0.
      return {
        deposit_amount: round2(firstMilestoneAmount ?? 0),
        deposit_type: "fixed",
        deposit_percentage: null,
      };
    case "cost_plus":
      return {
        deposit_amount: await costPlusDefaultDeposit(env),
        deposit_type: "fixed",
        deposit_percentage: null,
      };
    default:
      return { deposit_amount: 0, deposit_type: "fixed", deposit_percentage: null };
  }
}

// ─── GET /api/estimates ───────────────────────────────────────────────────────

export async function handleEstimateList(env: Env, url: URL): Promise<Response> {
  const where: string[] = [];
  const binds: unknown[] = [];

  const status = str(url.searchParams.get("status"));
  const requestId = str(url.searchParams.get("request_id"));
  const clientId = str(url.searchParams.get("client_id"));
  if (status) {
    where.push("e.status = ?");
    binds.push(status);
  }
  if (requestId) {
    where.push("e.request_id = ?");
    binds.push(requestId);
  }
  if (clientId) {
    where.push("e.client_id = ?");
    binds.push(clientId);
  }

  const sql = `
    SELECT e.id, e.estimate_number, e.request_id, e.client_id, e.title,
           e.estimate_mode, e.billing_model, e.status, e.subtotal, e.total,
           e.margin_percent, e.deposit_amount, e.version, e.sent_at, e.expiration_date,
           e.created_at, e.updated_at,
           c.name AS client_name, c.first_name AS c_first, c.last_name AS c_last
    FROM estimates e
    LEFT JOIN clients c ON c.id = e.client_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY e.created_at DESC
    LIMIT 1000`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  const rows = (results ?? []).map((r) => ({
    id: r.id,
    estimate_number: r.estimate_number,
    request_id: r.request_id,
    client_id: r.client_id,
    client_name:
      [r.c_first, r.c_last].filter(Boolean).join(" ").trim() || (r.client_name as string) || null,
    title: r.title,
    estimate_mode: r.estimate_mode,
    billing_model: r.billing_model,
    status: r.status,
    subtotal: r.subtotal ?? 0,
    total: r.total ?? 0,
    margin_percent: r.margin_percent ?? 0,
    deposit_amount: r.deposit_amount,
    version: r.version ?? 1,
    sent_at: r.sent_at,
    expiration_date: r.expiration_date,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
  return json({ as_of: new Date().toISOString(), total: rows.length, estimates: rows });
}

// ─── GET /api/estimates/:id ────────────────────────────────────────────────────

export async function handleEstimateGet(env: Env, id: string): Promise<Response> {
  const estimate = await loadFullEstimate(env, id);
  if (!estimate) return err(404, "not_found", "Estimate not found");
  return json({ estimate });
}

// ─── POST /api/estimates ───────────────────────────────────────────────────────

export async function handleEstimateCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const requestId = str(body.estimate_request_id) ?? str(body.request_id);
  if (!requestId) return err(400, "bad_request", "estimate_request_id is required");

  const req = await env.DB.prepare(
    `SELECT id, client_id, job_type,
            property_address, property_city, property_state, property_zip, estimate_id
     FROM estimate_requests WHERE id = ?`,
  )
    .bind(requestId)
    .first<{
      id: string;
      client_id: string;
      job_type: string;
      property_address: string;
      property_city: string;
      property_state: string | null;
      property_zip: string;
      estimate_id: string | null;
    }>();
  if (!req) return err(404, "not_found", "Estimate request not found");

  // If the request already has an estimate, return it (idempotent "open existing").
  if (req.estimate_id) {
    const existing = await loadFullEstimate(env, req.estimate_id);
    if (existing) return json({ estimate: existing, created: false });
  }

  const mode = str(body.mode) ?? str(body.estimate_mode) ?? "trade_by_trade";
  const billingModel = str(body.billing_model) ?? "fixed_price";
  const title =
    str(body.title) ??
    `${(req.job_type ?? "Estimate").replace(/_/g, " ")} — ${req.property_address ?? ""}`.trim();

  const maxNum = await env.DB.prepare(
    "SELECT COALESCE(MAX(estimate_number), 0) AS n FROM estimates",
  ).first<{ n: number }>();
  const estimateNumber = (maxNum?.n ?? 0) + 1;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const validDays = num(body.valid_days) ?? 7;
  const dep = await defaultDeposit(env, billingModel, 0, null);

  await env.DB.prepare(
    `INSERT INTO estimates (
      id, estimate_number, request_id, client_id, title, estimate_mode, billing_model,
      status, subtotal, tax_amount, total, margin_percent,
      deposit_amount, deposit_type, deposit_percentage, valid_days,
      include_reviews, include_contract, version,
      created_at, updated_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 0, 0, 0, 0, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?)`,
  )
    .bind(
      id,
      estimateNumber,
      requestId,
      req.client_id,
      title,
      mode,
      billingModel,
      dep.deposit_amount,
      dep.deposit_type,
      dep.deposit_percentage,
      validDays,
      now,
      now,
      user.id, // estimates.created_by has a FK to users(id)
    )
    .run();

  // Link the estimate back to its request and nudge the request into "building".
  await env.DB.prepare(
    `UPDATE estimate_requests
     SET estimate_id = ?,
         status = CASE WHEN status IN ('new_request','appointment_set','visit_done') THEN 'building' ELSE status END,
         updated_at = ?
     WHERE id = ?`,
  )
    .bind(id, now, requestId)
    .run();

  await logAudit(env, user.email, "estimate_created", "estimate", id, {
    estimate_number: estimateNumber,
    request_id: requestId,
    client_id: req.client_id,
    mode,
    billing_model: billingModel,
  });

  const estimate = await loadFullEstimate(env, id);
  return json({ estimate, created: true }, { status: 201 });
}

// ─── PUT /api/estimates/:id ─────────────────────────────────────────────────────

const HEADER_TEXT = ["title", "estimate_mode", "notes", "review_ids", "contract_template_id"] as const;

export async function handleEstimateUpdate(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare(
    "SELECT id, billing_model, total, deposit_amount FROM estimates WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; billing_model: string | null; total: number | null; deposit_amount: number | null }>();
  if (!existing) return err(404, "not_found", "Estimate not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const updates: string[] = [];
  const binds: unknown[] = [];

  for (const col of HEADER_TEXT) {
    if (col in body) {
      updates.push(`${col} = ?`);
      binds.push(str(body[col]));
    }
  }
  if ("tax_amount" in body) {
    updates.push("tax_amount = ?");
    binds.push(num(body.tax_amount) ?? 0);
  }
  if ("valid_days" in body) {
    const v = num(body.valid_days);
    updates.push("valid_days = ?");
    binds.push(v != null && v > 0 ? Math.trunc(v) : 7);
  }
  if ("include_reviews" in body) {
    updates.push("include_reviews = ?");
    binds.push(bool01(body.include_reviews, 1));
  }
  if ("include_contract" in body) {
    updates.push("include_contract = ?");
    binds.push(bool01(body.include_contract, 1));
  }

  // Deposit: explicit override OR recalculated default on billing-model change.
  let billingChanged = false;
  if ("billing_model" in body) {
    const bm = str(body.billing_model);
    if (bm && bm !== existing.billing_model) {
      billingChanged = true;
      updates.push("billing_model = ?");
      binds.push(bm);
    }
  }
  const depositOverride = "deposit_amount" in body;
  if (depositOverride) {
    updates.push("deposit_amount = ?");
    binds.push(num(body.deposit_amount) ?? 0);
    if ("deposit_type" in body) {
      updates.push("deposit_type = ?");
      binds.push(str(body.deposit_type) ?? "fixed");
    }
    if ("deposit_percentage" in body) {
      updates.push("deposit_percentage = ?");
      binds.push(num(body.deposit_percentage));
    }
  } else if (billingChanged) {
    const firstMs = await env.DB.prepare(
      "SELECT amount, percentage, fixed_amount FROM payment_schedules WHERE estimate_id = ? ORDER BY sort_order ASC LIMIT 1",
    )
      .bind(id)
      .first<{ amount: number | null; percentage: number | null; fixed_amount: number | null }>();
    const total = existing.total ?? 0;
    const firstMsAmount =
      firstMs?.fixed_amount ??
      (firstMs?.percentage != null ? round2((firstMs.percentage / 100) * total) : firstMs?.amount ?? null);
    const dep = await defaultDeposit(env, str(body.billing_model), total, firstMsAmount);
    updates.push("deposit_amount = ?", "deposit_type = ?", "deposit_percentage = ?");
    binds.push(dep.deposit_amount, dep.deposit_type, dep.deposit_percentage);
  }

  if (updates.length === 0) return err(400, "bad_request", "No updatable fields supplied");

  updates.push("updated_at = ?");
  binds.push(new Date().toISOString());
  binds.push(id);

  await env.DB.prepare(`UPDATE estimates SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  await recomputeEstimate(env, id);
  await logAudit(env, user.email, "estimate_updated", "estimate", id, { fields: Object.keys(body) });

  const estimate = await loadFullEstimate(env, id);
  return json({ estimate });
}

// ─── POST /api/estimates/:id/send ───────────────────────────────────────────────

export async function handleEstimateSend(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const exists = await env.DB.prepare("SELECT id FROM estimates WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!exists) return err(404, "not_found", "Estimate not found");

  // Recompute first so the deposit gate below sees the fresh (percentage-tracked) deposit.
  const totals = await recomputeEstimate(env, id);
  const est = await env.DB.prepare("SELECT * FROM estimates WHERE id = ?")
    .bind(id)
    .first<EstimateRow>();
  if (!est) return err(404, "not_found", "Estimate not found");

  // Send gate (business rules 1 + 8).
  const lineCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM estimate_line_items WHERE estimate_id = ?",
  )
    .bind(id)
    .first<{ n: number }>();
  if ((lineCount?.n ?? 0) < 1) {
    return err(400, "send_blocked", "An estimate needs at least one line item before it can be sent.");
  }
  if (!est.deposit_amount || est.deposit_amount <= 0) {
    return err(400, "send_blocked", "Configure a deposit amount before sending.");
  }

  const schedule = (
    await env.DB.prepare("SELECT * FROM payment_schedules WHERE estimate_id = ?")
      .bind(id)
      .all<PaymentRow>()
  ).results ?? [];
  const pctRows = schedule.filter((p) => p.percentage != null && p.fixed_amount == null);
  if (pctRows.length > 0) {
    const sum = round2(pctRows.reduce((a, p) => a + (p.percentage ?? 0), 0));
    if (Math.abs(sum - 100) > 0.01) {
      return err(
        400,
        "send_blocked",
        `Percentage milestones must sum to 100% (currently ${sum}%).`,
      );
    }
  }

  const now = new Date();
  const validDays = est.valid_days ?? 7;
  const expiration = new Date(now.getTime() + validDays * 86_400_000);
  const portalToken = est.portal_token ?? crypto.randomUUID().replace(/-/g, "");

  await env.DB.prepare(
    `UPDATE estimates
     SET status = 'sent', sent_at = ?, expiration_date = ?, portal_token = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(now.toISOString(), expiration.toISOString().slice(0, 10), portalToken, now.toISOString(), id)
    .run();

  // Move the linked request to "sent" and stamp its sent_date.
  if (est.request_id) {
    await env.DB.prepare(
      `UPDATE estimate_requests
       SET status = CASE WHEN status IN ('won','lost') THEN status ELSE 'sent' END,
           sent_date = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(now.toISOString(), now.toISOString(), est.request_id)
      .run();
  }

  await logAudit(env, user.email, "estimate_sent", "estimate", id, {
    total: totals.total,
    deposit_amount: est.deposit_amount,
    expiration_date: expiration.toISOString().slice(0, 10),
  });

  // WC quotes-sent hook (count + dollar value; recomputed on next cron tick).
  triggerQuoteSent(env, id, totals.total);

  const estimate = await loadFullEstimate(env, id);
  return json({ estimate });
}

// ─── POST /api/estimates/:id/revise ─────────────────────────────────────────────

export async function handleEstimateRevise(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const orig = await env.DB.prepare("SELECT * FROM estimates WHERE id = ?")
    .bind(id)
    .first<EstimateRow>();
  if (!orig) return err(404, "not_found", "Estimate not found");

  const newId = crypto.randomUUID();
  const now = new Date().toISOString();
  const maxNum = await env.DB.prepare(
    "SELECT COALESCE(MAX(estimate_number), 0) AS n FROM estimates",
  ).first<{ n: number }>();
  const estimateNumber = (maxNum?.n ?? 0) + 1;

  // Clone the header into a fresh draft version.
  await env.DB.prepare(
    `INSERT INTO estimates (
      id, estimate_number, request_id, client_id, title, estimate_mode, billing_model,
      status, subtotal, tax_amount, total, margin_percent,
      deposit_amount, deposit_type, deposit_percentage, valid_days,
      include_reviews, review_ids, include_contract, contract_template_id, notes,
      version, revised_from_id, created_at, updated_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId,
      estimateNumber,
      orig.request_id,
      orig.client_id,
      orig.title,
      orig.estimate_mode,
      orig.billing_model,
      orig.subtotal ?? 0,
      orig.tax_amount ?? 0,
      orig.total ?? 0,
      orig.margin_percent ?? 0,
      orig.deposit_amount,
      orig.deposit_type,
      orig.deposit_percentage,
      orig.valid_days ?? 7,
      orig.include_reviews ?? 1,
      orig.review_ids,
      orig.include_contract ?? 1,
      orig.contract_template_id,
      orig.notes,
      (orig.version ?? 1) + 1,
      orig.id,
      now,
      now,
      user.id, // estimates.created_by has a FK to users(id)
    )
    .run();

  // Clone line items (and remember old→new id mapping for sub-items).
  const lineItems = (
    await env.DB.prepare("SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC")
      .bind(id)
      .all<LineItemRow>()
  ).results ?? [];
  const idMap = new Map<string, string>();
  for (const li of lineItems) {
    const liId = crypto.randomUUID();
    idMap.set(li.id, liId);
    await env.DB.prepare(
      `INSERT INTO estimate_line_items
        (id, estimate_id, sort_order, product_service, description, quantity, unit, unit_price, total, includes_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        liId,
        newId,
        li.sort_order,
        li.product_service,
        li.description,
        li.quantity ?? 1,
        li.unit,
        li.unit_price ?? 0,
        li.total,
        li.includes_note,
        now,
      )
      .run();
  }

  if (lineItems.length > 0) {
    const subItems = (
      await env.DB.prepare(
        `SELECT * FROM estimate_sub_items WHERE parent_line_item_id IN (${lineItems.map(() => "?").join(",")})`,
      )
        .bind(...lineItems.map((li) => li.id))
        .all<SubItemRow>()
    ).results ?? [];
    for (const si of subItems) {
      const newParent = idMap.get(si.parent_line_item_id);
      if (!newParent) continue;
      await env.DB.prepare(
        `INSERT INTO estimate_sub_items
          (id, parent_line_item_id, sort_order, description, category, vendor, quantity, unit, unit_cost, total_cost, material_id, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          newParent,
          si.sort_order,
          si.description,
          si.category,
          si.vendor,
          si.quantity,
          si.unit,
          si.unit_cost ?? 0,
          si.total_cost,
          si.material_id,
          si.notes,
          now,
        )
        .run();
    }
  }

  // Clone the payment schedule.
  const schedule = (
    await env.DB.prepare("SELECT * FROM payment_schedules WHERE estimate_id = ? ORDER BY sort_order ASC")
      .bind(id)
      .all<PaymentRow>()
  ).results ?? [];
  for (const p of schedule) {
    await env.DB.prepare(
      `INSERT INTO payment_schedules
        (id, estimate_id, sort_order, description, percentage, fixed_amount, amount, is_deposit, trigger, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        newId,
        p.sort_order,
        p.description,
        p.percentage,
        p.fixed_amount,
        p.amount,
        p.is_deposit ?? 0,
        p.trigger,
        p.notes,
        now,
      )
      .run();
  }

  // Preserve the original; mark it revised, and point the request at the new version.
  await env.DB.prepare("UPDATE estimates SET status = 'revised', updated_at = ? WHERE id = ?")
    .bind(now, id)
    .run();
  if (orig.request_id) {
    await env.DB.prepare("UPDATE estimate_requests SET estimate_id = ?, updated_at = ? WHERE id = ?")
      .bind(newId, now, orig.request_id)
      .run();
  }

  await recomputeEstimate(env, newId);
  await logAudit(env, user.email, "estimate_revised", "estimate", newId, {
    revised_from_id: id,
    version: (orig.version ?? 1) + 1,
  });

  const estimate = await loadFullEstimate(env, newId);
  return json({ estimate, created: true }, { status: 201 });
}

// ─── Parent line items ──────────────────────────────────────────────────────

export async function handleLineItemList(env: Env, estimateId: string): Promise<Response> {
  const est = await env.DB.prepare("SELECT id FROM estimates WHERE id = ?").bind(estimateId).first();
  if (!est) return err(404, "not_found", "Estimate not found");
  await recomputeEstimate(env, estimateId);

  const lineItems = (
    await env.DB.prepare(
      "SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC",
    )
      .bind(estimateId)
      .all<LineItemRow>()
  ).results ?? [];
  let subItems: SubItemRow[] = [];
  if (lineItems.length > 0) {
    subItems = (
      await env.DB.prepare(
        `SELECT * FROM estimate_sub_items WHERE parent_line_item_id IN (${lineItems.map(() => "?").join(",")}) ORDER BY sort_order ASC`,
      )
        .bind(...lineItems.map((li) => li.id))
        .all<SubItemRow>()
    ).results ?? [];
  }
  return json({ line_items: lineItems.map((li) => shapeLineItem(li, subItems)) });
}

export async function handleLineItemCreate(
  request: Request,
  env: Env,
  estimateId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const est = await env.DB.prepare("SELECT id FROM estimates WHERE id = ?").bind(estimateId).first();
  if (!est) return err(404, "not_found", "Estimate not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");
  const productService = str(body.product_service);
  if (!productService) return err(400, "bad_request", "product_service is required");

  const maxSort = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) AS n FROM estimate_line_items WHERE estimate_id = ?",
  )
    .bind(estimateId)
    .first<{ n: number }>();
  const sortOrder = num(body.sort_order) ?? (maxSort?.n ?? -1) + 1;

  const id = crypto.randomUUID();
  const quantity = num(body.quantity) ?? 1;
  const unitPrice = num(body.unit_price) ?? 0;
  await env.DB.prepare(
    `INSERT INTO estimate_line_items
      (id, estimate_id, sort_order, product_service, description, quantity, unit, unit_price, total, includes_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      id,
      estimateId,
      sortOrder,
      productService,
      str(body.description) ?? "",
      quantity,
      str(body.unit),
      unitPrice,
      round2(quantity * unitPrice),
      str(body.includes_note),
    )
    .run();

  await recomputeEstimate(env, estimateId);
  await logAudit(env, user.email, "estimate_line_item_created", "estimate_line_item", id, {
    estimate_id: estimateId,
    product_service: productService,
  });

  const row = await env.DB.prepare("SELECT * FROM estimate_line_items WHERE id = ?").bind(id).first<LineItemRow>();
  return json({ line_item: row ? shapeLineItem(row, []) : null }, { status: 201 });
}

export async function handleLineItemUpdate(
  request: Request,
  env: Env,
  lineItemId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare(
    "SELECT id, estimate_id FROM estimate_line_items WHERE id = ?",
  )
    .bind(lineItemId)
    .first<{ id: string; estimate_id: string }>();
  if (!existing) return err(404, "not_found", "Line item not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const updates: string[] = [];
  const binds: unknown[] = [];
  if ("product_service" in body) {
    updates.push("product_service = ?");
    binds.push(str(body.product_service) ?? "");
  }
  if ("description" in body) {
    updates.push("description = ?");
    binds.push(str(body.description) ?? "");
  }
  if ("quantity" in body) {
    updates.push("quantity = ?");
    binds.push(num(body.quantity) ?? 0);
  }
  if ("unit" in body) {
    updates.push("unit = ?");
    binds.push(str(body.unit));
  }
  if ("unit_price" in body) {
    updates.push("unit_price = ?");
    binds.push(num(body.unit_price) ?? 0);
  }
  if ("includes_note" in body) {
    updates.push("includes_note = ?");
    binds.push(str(body.includes_note));
  }
  if ("sort_order" in body) {
    updates.push("sort_order = ?");
    binds.push(num(body.sort_order) ?? 0);
  }
  if (updates.length === 0) return err(400, "bad_request", "No updatable fields supplied");

  binds.push(lineItemId);
  await env.DB.prepare(`UPDATE estimate_line_items SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  await recomputeEstimate(env, existing.estimate_id);
  await logAudit(env, user.email, "estimate_line_item_updated", "estimate_line_item", lineItemId, {
    fields: Object.keys(body),
  });

  const row = await env.DB.prepare("SELECT * FROM estimate_line_items WHERE id = ?")
    .bind(lineItemId)
    .first<LineItemRow>();
  const subs = (
    await env.DB.prepare("SELECT * FROM estimate_sub_items WHERE parent_line_item_id = ? ORDER BY sort_order ASC")
      .bind(lineItemId)
      .all<SubItemRow>()
  ).results ?? [];
  return json({ line_item: row ? shapeLineItem(row, subs) : null });
}

export async function handleLineItemDelete(
  request: Request,
  env: Env,
  lineItemId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare(
    "SELECT id, estimate_id FROM estimate_line_items WHERE id = ?",
  )
    .bind(lineItemId)
    .first<{ id: string; estimate_id: string }>();
  if (!existing) return err(404, "not_found", "Line item not found");

  // Cascade sub-items explicitly (FK ON DELETE CASCADE may be off in D1).
  await env.DB.prepare("DELETE FROM estimate_sub_items WHERE parent_line_item_id = ?").bind(lineItemId).run();
  await env.DB.prepare("DELETE FROM estimate_line_items WHERE id = ?").bind(lineItemId).run();

  await recomputeEstimate(env, existing.estimate_id);
  await logAudit(env, user.email, "estimate_line_item_deleted", "estimate_line_item", lineItemId, {
    estimate_id: existing.estimate_id,
  });
  return json({ ok: true });
}

export async function handleLineItemReorder(
  request: Request,
  env: Env,
  estimateId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const est = await env.DB.prepare("SELECT id FROM estimates WHERE id = ?").bind(estimateId).first();
  if (!est) return err(404, "not_found", "Estimate not found");

  const body = await readJson(request);
  const ids = Array.isArray(body?.ids) ? (body!.ids as unknown[]).map((x) => String(x)) : null;
  if (!ids || ids.length === 0) return err(400, "bad_request", "Provide an array of line item ids");

  for (let i = 0; i < ids.length; i++) {
    await env.DB.prepare(
      "UPDATE estimate_line_items SET sort_order = ? WHERE id = ? AND estimate_id = ?",
    )
      .bind(i, ids[i], estimateId)
      .run();
  }

  await logAudit(env, user.email, "estimate_line_items_reordered", "estimate", estimateId, {
    order: ids,
  });
  return handleLineItemList(env, estimateId);
}

// ─── Sub-items (internal cost) ────────────────────────────────────────────────

export async function handleSubItemCreate(
  request: Request,
  env: Env,
  lineItemId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const parent = await env.DB.prepare(
    "SELECT id, estimate_id FROM estimate_line_items WHERE id = ?",
  )
    .bind(lineItemId)
    .first<{ id: string; estimate_id: string }>();
  if (!parent) return err(404, "not_found", "Parent line item not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");
  const description = str(body.description);
  const category = str(body.category);
  if (!description) return err(400, "bad_request", "description is required");
  if (!category) return err(400, "bad_request", "category is required");

  const maxSort = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) AS n FROM estimate_sub_items WHERE parent_line_item_id = ?",
  )
    .bind(lineItemId)
    .first<{ n: number }>();
  const sortOrder = num(body.sort_order) ?? (maxSort?.n ?? -1) + 1;

  const id = crypto.randomUUID();
  const quantity = num(body.quantity);
  const unitCost = num(body.unit_cost) ?? 0;

  // Snapshot the material price if a material_id was supplied (business rule 5).
  let materialId = str(body.material_id);
  let resolvedUnitCost = unitCost;
  let resolvedVendor = str(body.vendor);
  if (materialId) {
    const mat = await env.DB.prepare(
      "SELECT id, vendor_name, last_price FROM vendor_materials WHERE id = ?",
    )
      .bind(materialId)
      .first<{ id: string; vendor_name: string; last_price: number }>();
    if (mat) {
      if (!("unit_cost" in body)) resolvedUnitCost = mat.last_price;
      if (!resolvedVendor) resolvedVendor = mat.vendor_name;
    } else {
      materialId = null; // reference only; don't store a dangling id
    }
  }

  await env.DB.prepare(
    `INSERT INTO estimate_sub_items
      (id, parent_line_item_id, sort_order, description, category, vendor, quantity, unit, unit_cost, total_cost, material_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      id,
      lineItemId,
      sortOrder,
      description,
      category,
      resolvedVendor,
      quantity,
      str(body.unit),
      resolvedUnitCost,
      round2((quantity ?? 0) * resolvedUnitCost),
      materialId,
      str(body.notes),
    )
    .run();

  await recomputeEstimate(env, parent.estimate_id);
  await logAudit(env, user.email, "estimate_sub_item_created", "estimate_sub_item", id, {
    parent_line_item_id: lineItemId,
    category,
  });

  const row = await env.DB.prepare("SELECT * FROM estimate_sub_items WHERE id = ?").bind(id).first<SubItemRow>();
  return json({ sub_item: row ? shapeSubItem(row) : null }, { status: 201 });
}

export async function handleSubItemUpdate(
  request: Request,
  env: Env,
  subItemId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare(
    `SELECT s.id, s.parent_line_item_id, li.estimate_id
     FROM estimate_sub_items s JOIN estimate_line_items li ON li.id = s.parent_line_item_id
     WHERE s.id = ?`,
  )
    .bind(subItemId)
    .first<{ id: string; parent_line_item_id: string; estimate_id: string }>();
  if (!existing) return err(404, "not_found", "Sub-item not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const updates: string[] = [];
  const binds: unknown[] = [];
  for (const col of ["description", "category", "vendor", "unit", "notes"] as const) {
    if (col in body) {
      updates.push(`${col} = ?`);
      binds.push(str(body[col]));
    }
  }
  if ("quantity" in body) {
    updates.push("quantity = ?");
    binds.push(num(body.quantity));
  }
  if ("unit_cost" in body) {
    updates.push("unit_cost = ?");
    binds.push(num(body.unit_cost) ?? 0);
  }
  if ("material_id" in body) {
    updates.push("material_id = ?");
    binds.push(str(body.material_id));
  }
  if (updates.length === 0) return err(400, "bad_request", "No updatable fields supplied");

  binds.push(subItemId);
  await env.DB.prepare(`UPDATE estimate_sub_items SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  await recomputeEstimate(env, existing.estimate_id);
  await logAudit(env, user.email, "estimate_sub_item_updated", "estimate_sub_item", subItemId, {
    fields: Object.keys(body),
  });

  const row = await env.DB.prepare("SELECT * FROM estimate_sub_items WHERE id = ?").bind(subItemId).first<SubItemRow>();
  return json({ sub_item: row ? shapeSubItem(row) : null });
}

export async function handleSubItemDelete(
  request: Request,
  env: Env,
  subItemId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare(
    `SELECT s.id, li.estimate_id
     FROM estimate_sub_items s JOIN estimate_line_items li ON li.id = s.parent_line_item_id
     WHERE s.id = ?`,
  )
    .bind(subItemId)
    .first<{ id: string; estimate_id: string }>();
  if (!existing) return err(404, "not_found", "Sub-item not found");

  await env.DB.prepare("DELETE FROM estimate_sub_items WHERE id = ?").bind(subItemId).run();
  await recomputeEstimate(env, existing.estimate_id);
  await logAudit(env, user.email, "estimate_sub_item_deleted", "estimate_sub_item", subItemId, {
    estimate_id: existing.estimate_id,
  });
  return json({ ok: true });
}

// ─── Payment schedule ─────────────────────────────────────────────────────────

export async function handlePaymentScheduleGet(env: Env, estimateId: string): Promise<Response> {
  const est = await env.DB.prepare("SELECT id FROM estimates WHERE id = ?").bind(estimateId).first();
  if (!est) return err(404, "not_found", "Estimate not found");
  const totals = await recomputeEstimate(env, estimateId);
  const rows = (
    await env.DB.prepare("SELECT * FROM payment_schedules WHERE estimate_id = ? ORDER BY sort_order ASC")
      .bind(estimateId)
      .all<PaymentRow>()
  ).results ?? [];
  return json({ payment_schedule: rows.map((p) => shapePayment(p, totals.total)) });
}

export async function handlePaymentScheduleReplace(
  request: Request,
  env: Env,
  estimateId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const est = await env.DB.prepare("SELECT id FROM estimates WHERE id = ?").bind(estimateId).first();
  if (!est) return err(404, "not_found", "Estimate not found");

  const body = await readJson(request);
  const milestones = Array.isArray(body?.milestones)
    ? (body!.milestones as Record<string, unknown>[])
    : Array.isArray(body?.payment_schedule)
      ? (body!.payment_schedule as Record<string, unknown>[])
      : null;
  if (!milestones) return err(400, "bad_request", "Provide a milestones array");

  await env.DB.prepare("DELETE FROM payment_schedules WHERE estimate_id = ?").bind(estimateId).run();
  for (let i = 0; i < milestones.length; i++) {
    const m = milestones[i];
    await env.DB.prepare(
      `INSERT INTO payment_schedules
        (id, estimate_id, sort_order, description, percentage, fixed_amount, amount, is_deposit, trigger, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
      .bind(
        crypto.randomUUID(),
        estimateId,
        num(m.sort_order) ?? i,
        str(m.description) ?? `Payment ${i + 1}`,
        num(m.percentage),
        num(m.fixed_amount),
        num(m.amount),
        bool01(m.is_deposit, 0),
        str(m.trigger),
        str(m.notes),
      )
      .run();
  }

  await logAudit(env, user.email, "estimate_payment_schedule_replaced", "estimate", estimateId, {
    count: milestones.length,
  });
  return handlePaymentScheduleGet(env, estimateId);
}

// ─── Templates ──────────────────────────────────────────────────────────────

function shapeTemplate(r: Record<string, unknown>, parseItems = false) {
  const base = {
    id: r.id,
    name: r.name,
    job_type: r.job_type,
    description: r.description,
    default_billing_model: r.default_billing_model,
    is_active: (r.is_active ?? 1) === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  if (!parseItems) return base;
  let lineItems: unknown = [];
  let schedule: unknown = null;
  try {
    lineItems = r.line_items ? JSON.parse(r.line_items as string) : [];
  } catch {
    lineItems = [];
  }
  try {
    schedule = r.default_payment_schedule ? JSON.parse(r.default_payment_schedule as string) : null;
  } catch {
    schedule = null;
  }
  return { ...base, line_items: lineItems, default_payment_schedule: schedule };
}

export async function handleTemplateList(env: Env, url: URL): Promise<Response> {
  const where: string[] = [];
  const binds: unknown[] = [];
  // Builder selector wants active templates; management view passes ?active=all.
  const active = url.searchParams.get("active");
  if (active !== "all") {
    where.push("is_active = 1");
  }
  const jobType = str(url.searchParams.get("job_type"));
  if (jobType) {
    where.push("job_type = ?");
    binds.push(jobType);
  }
  const sql = `SELECT * FROM estimate_templates ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY name ASC`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  return json({ templates: (results ?? []).map((r) => shapeTemplate(r)) });
}

export async function handleTemplateGet(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM estimate_templates WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!row) return err(404, "not_found", "Template not found");
  return json({ template: shapeTemplate(row, true) });
}

export async function handleTemplateCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");
  const name = str(body.name);
  const jobType = str(body.job_type);
  if (!name) return err(400, "bad_request", "name is required");
  if (!jobType) return err(400, "bad_request", "job_type is required");

  // Either an explicit line_items JSON array, or build it from an existing estimate.
  let lineItemsJson: string;
  let scheduleJson: string | null = null;
  let defaultBilling = str(body.default_billing_model);

  const fromEstimateId = str(body.from_estimate_id);
  if (fromEstimateId) {
    const est = await env.DB.prepare("SELECT billing_model FROM estimates WHERE id = ?")
      .bind(fromEstimateId)
      .first<{ billing_model: string | null }>();
    if (!est) return err(404, "not_found", "Source estimate not found");
    defaultBilling = defaultBilling ?? est.billing_model;
    const lineItems = (
      await env.DB.prepare("SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC")
        .bind(fromEstimateId)
        .all<LineItemRow>()
    ).results ?? [];
    let subItems: SubItemRow[] = [];
    if (lineItems.length > 0) {
      subItems = (
        await env.DB.prepare(
          `SELECT * FROM estimate_sub_items WHERE parent_line_item_id IN (${lineItems.map(() => "?").join(",")}) ORDER BY sort_order ASC`,
        )
          .bind(...lineItems.map((li) => li.id))
          .all<SubItemRow>()
      ).results ?? [];
    }
    lineItemsJson = JSON.stringify(
      lineItems.map((li) => ({
        product_service: li.product_service,
        description: li.description,
        quantity: li.quantity,
        unit: li.unit,
        unit_price: li.unit_price,
        includes_note: li.includes_note,
        sub_items: subItems
          .filter((s) => s.parent_line_item_id === li.id)
          .map((s) => ({
            description: s.description,
            category: s.category,
            vendor: s.vendor,
            quantity: s.quantity,
            unit: s.unit,
            unit_cost: s.unit_cost,
          })),
      })),
    );
    const schedule = (
      await env.DB.prepare("SELECT * FROM payment_schedules WHERE estimate_id = ? ORDER BY sort_order ASC")
        .bind(fromEstimateId)
        .all<PaymentRow>()
    ).results ?? [];
    if (schedule.length > 0) {
      scheduleJson = JSON.stringify(
        schedule.map((p) => ({
          description: p.description,
          percentage: p.percentage,
          fixed_amount: p.fixed_amount,
          is_deposit: (p.is_deposit ?? 0) === 1,
          trigger: p.trigger,
        })),
      );
    }
  } else {
    lineItemsJson = JSON.stringify(Array.isArray(body.line_items) ? body.line_items : []);
    if (body.default_payment_schedule) scheduleJson = JSON.stringify(body.default_payment_schedule);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO estimate_templates
      (id, name, job_type, description, default_billing_model, line_items, default_payment_schedule, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
  )
    .bind(id, name, jobType, str(body.description), defaultBilling, lineItemsJson, scheduleJson)
    .run();

  await logAudit(env, user.email, "estimate_template_created", "estimate_template", id, { name, job_type: jobType });
  const row = await env.DB.prepare("SELECT * FROM estimate_templates WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return json({ template: row ? shapeTemplate(row, true) : null }, { status: 201 });
}

export async function handleTemplateUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare("SELECT id FROM estimate_templates WHERE id = ?").bind(id).first();
  if (!existing) return err(404, "not_found", "Template not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const updates: string[] = [];
  const binds: unknown[] = [];
  for (const col of ["name", "job_type", "description", "default_billing_model"] as const) {
    if (col in body) {
      updates.push(`${col} = ?`);
      binds.push(str(body[col]));
    }
  }
  if ("line_items" in body) {
    updates.push("line_items = ?");
    binds.push(JSON.stringify(Array.isArray(body.line_items) ? body.line_items : []));
  }
  if ("default_payment_schedule" in body) {
    updates.push("default_payment_schedule = ?");
    binds.push(body.default_payment_schedule ? JSON.stringify(body.default_payment_schedule) : null);
  }
  if ("is_active" in body) {
    updates.push("is_active = ?");
    binds.push(bool01(body.is_active, 1));
  }
  if (updates.length === 0) return err(400, "bad_request", "No updatable fields supplied");

  updates.push("updated_at = datetime('now')");
  binds.push(id);
  await env.DB.prepare(`UPDATE estimate_templates SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  await logAudit(env, user.email, "estimate_template_updated", "estimate_template", id, { fields: Object.keys(body) });
  const row = await env.DB.prepare("SELECT * FROM estimate_templates WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return json({ template: row ? shapeTemplate(row, true) : null });
}

export async function handleApplyTemplate(
  request: Request,
  env: Env,
  estimateId: string,
  templateId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const est = await env.DB.prepare("SELECT id FROM estimates WHERE id = ?").bind(estimateId).first();
  if (!est) return err(404, "not_found", "Estimate not found");
  const tpl = await env.DB.prepare("SELECT * FROM estimate_templates WHERE id = ?")
    .bind(templateId)
    .first<Record<string, unknown>>();
  if (!tpl) return err(404, "not_found", "Template not found");

  let lineItems: Array<Record<string, unknown>> = [];
  try {
    lineItems = tpl.line_items ? JSON.parse(tpl.line_items as string) : [];
  } catch {
    lineItems = [];
  }

  const startSort = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) AS n FROM estimate_line_items WHERE estimate_id = ?",
  )
    .bind(estimateId)
    .first<{ n: number }>();
  let sort = (startSort?.n ?? -1) + 1;

  for (const li of lineItems) {
    const liId = crypto.randomUUID();
    const qty = num(li.quantity) ?? 1;
    const price = num(li.unit_price) ?? 0;
    await env.DB.prepare(
      `INSERT INTO estimate_line_items
        (id, estimate_id, sort_order, product_service, description, quantity, unit, unit_price, total, includes_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
      .bind(
        liId,
        estimateId,
        sort++,
        str(li.product_service) ?? "Item",
        str(li.description) ?? "",
        qty,
        str(li.unit),
        price,
        round2(qty * price),
        str(li.includes_note),
      )
      .run();
    const subs = Array.isArray(li.sub_items) ? (li.sub_items as Record<string, unknown>[]) : [];
    let subSort = 0;
    for (const s of subs) {
      const sQty = num(s.quantity);
      const sCost = num(s.unit_cost) ?? 0;
      await env.DB.prepare(
        `INSERT INTO estimate_sub_items
          (id, parent_line_item_id, sort_order, description, category, vendor, quantity, unit, unit_cost, total_cost, material_id, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, datetime('now'))`,
      )
        .bind(
          crypto.randomUUID(),
          liId,
          subSort++,
          str(s.description) ?? "Cost",
          str(s.category) ?? "material",
          str(s.vendor),
          sQty,
          str(s.unit),
          sCost,
          round2((sQty ?? 0) * sCost),
        )
        .run();
    }
  }

  await recomputeEstimate(env, estimateId);
  await logAudit(env, user.email, "estimate_template_applied", "estimate", estimateId, {
    template_id: templateId,
    line_items_added: lineItems.length,
  });

  const estimate = await loadFullEstimate(env, estimateId);
  return json({ estimate });
}

// ─── Saved reviews ─────────────────────────────────────────────────────────

function shapeReview(r: Record<string, unknown>) {
  return {
    id: r.id,
    reviewer_name: r.reviewer_name,
    review_date: r.review_date,
    rating: r.rating,
    review_text: r.review_text,
    source: r.source,
    is_active: (r.is_active ?? 1) === 1,
    sort_order: r.sort_order,
    created_at: r.created_at,
  };
}

export async function handleReviewList(env: Env, url: URL): Promise<Response> {
  const where: string[] = [];
  if (url.searchParams.get("active") === "true") where.push("is_active = 1");
  const sql = `SELECT * FROM saved_reviews ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(sort_order, 9999) ASC, created_at DESC`;
  const { results } = await env.DB.prepare(sql).all<Record<string, unknown>>();
  return json({ reviews: (results ?? []).map(shapeReview) });
}

export async function handleReviewCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");
  const reviewerName = str(body.reviewer_name);
  const reviewText = str(body.review_text);
  const source = str(body.source) ?? "manual";
  const rating = num(body.rating);
  if (!reviewerName) return err(400, "bad_request", "reviewer_name is required");
  if (!reviewText) return err(400, "bad_request", "review_text is required");
  if (rating == null || rating < 1 || rating > 5) return err(400, "bad_request", "rating must be 1-5");

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO saved_reviews (id, reviewer_name, review_date, rating, review_text, source, is_active, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      id,
      reviewerName,
      str(body.review_date),
      Math.trunc(rating),
      reviewText,
      source,
      bool01(body.is_active, 1),
      num(body.sort_order),
    )
    .run();

  await logAudit(env, user.email, "saved_review_created", "saved_review", id, { reviewer_name: reviewerName });
  const row = await env.DB.prepare("SELECT * FROM saved_reviews WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return json({ review: row ? shapeReview(row) : null }, { status: 201 });
}

export async function handleReviewUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare("SELECT id FROM saved_reviews WHERE id = ?").bind(id).first();
  if (!existing) return err(404, "not_found", "Review not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const updates: string[] = [];
  const binds: unknown[] = [];
  for (const col of ["reviewer_name", "review_date", "review_text", "source"] as const) {
    if (col in body) {
      updates.push(`${col} = ?`);
      binds.push(str(body[col]));
    }
  }
  if ("rating" in body) {
    const r = num(body.rating);
    if (r == null || r < 1 || r > 5) return err(400, "bad_request", "rating must be 1-5");
    updates.push("rating = ?");
    binds.push(Math.trunc(r));
  }
  if ("is_active" in body) {
    updates.push("is_active = ?");
    binds.push(bool01(body.is_active, 1));
  }
  if ("sort_order" in body) {
    updates.push("sort_order = ?");
    binds.push(num(body.sort_order));
  }
  if (updates.length === 0) return err(400, "bad_request", "No updatable fields supplied");

  binds.push(id);
  await env.DB.prepare(`UPDATE saved_reviews SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
  await logAudit(env, user.email, "saved_review_updated", "saved_review", id, { fields: Object.keys(body) });
  const row = await env.DB.prepare("SELECT * FROM saved_reviews WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return json({ review: row ? shapeReview(row) : null });
}

export async function handleReviewDelete(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare("SELECT id FROM saved_reviews WHERE id = ?").bind(id).first();
  if (!existing) return err(404, "not_found", "Review not found");
  await env.DB.prepare("DELETE FROM saved_reviews WHERE id = ?").bind(id).run();
  await logAudit(env, user.email, "saved_review_deleted", "saved_review", id, {});
  return json({ ok: true });
}

// ─── Material search (read-only; populated by Financial module later) ─────────

export async function handleMaterialSearch(env: Env, url: URL): Promise<Response> {
  const q = str(url.searchParams.get("q"));
  if (!q) return json({ materials: [] });
  const like = `%${q.toLowerCase()}%`;
  const { results } = await env.DB.prepare(
    `SELECT id, vendor_name, material_name, category, unit, last_price, average_price, last_purchased_date
     FROM vendor_materials
     WHERE LOWER(material_name) LIKE ? OR LOWER(vendor_name) LIKE ?
     ORDER BY material_name ASC
     LIMIT 50`,
  )
    .bind(like, like)
    .all<Record<string, unknown>>();
  return json({
    materials: (results ?? []).map((r) => ({
      id: r.id,
      vendor_name: r.vendor_name,
      material_name: r.material_name,
      category: r.category,
      unit: r.unit,
      last_price: r.last_price,
      average_price: r.average_price,
      last_purchased_date: r.last_purchased_date,
    })),
  });
}
