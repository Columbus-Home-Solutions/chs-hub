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
 *   DELETE /api/estimates/:id                          cascade delete (guards on linked job)
 *   POST   /api/estimates/:id/send                     send-gate + status flip + WC hook
 *   POST   /api/estimates/:id/resend                   re-trigger estimate_sent (no status change)
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
import { cascadeDeleteEstimateChildren } from "../lib/cascade-delete.js";
import { NON_TEST_CLIENT } from "../lib/non-test-client.js";
import { triggerQuoteSent } from "../lib/wc/triggers.js";
import { triggerNotification } from "../lib/notification-engine.js";
import { renderContract } from "../lib/contracts.js";
import { depositFromSchedule, isPerLineItemBilling } from "../lib/deposit-from-schedule.js";
import { generateAndSendEstimateContract } from "../lib/estimate-contract-document.js";
import { createEstimateSubItem, SubItemValidationError } from "../lib/estimate-sub-items.js";
import { jobTypeTitleFragment } from "../../shared/job-type-label.js";
import { allocateNextEstimateNumber } from "../lib/estimate-number.js";
import { extractSupplierQuote } from "../lib/quote-import.js";
import { upsertVendorMaterial } from "./vendor-materials.js";
import { handleEstimateRequestWin } from "./estimate-requests.js";

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

function formatUsd(n: number | null | undefined): string {
  if (n == null) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
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
  deposit_payment_method: string | null;
  deposit_method_selected_at: string | null;
  valid_days: number | null;
  expiration_date: string | null;
  portal_token: string | null;
  include_reviews: number | null;
  review_ids: string | null;
  include_contract: number | null;
  contract_template_id: string | null;
  client_signature: string | null;
  signed_date: string | null;
  viewed_date: string | null;
  approved_date: string | null;
  notes: string | null;
  version: number | null;
  revised_from_id: string | null;
  is_current_version: number | null;
  sent_at: string | null;
  last_resent_at: string | null;
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
  sub_id: string | null;
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
export async function recomputeEstimate(env: Env, estimateId: string): Promise<Totals> {
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
    sub_id: r.sub_id ?? null,
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
    deposit_payment_method: (r as EstimateRow & { deposit_payment_method?: string | null }).deposit_payment_method ?? null,
    deposit_method_selected_at: (r as EstimateRow & { deposit_method_selected_at?: string | null }).deposit_method_selected_at ?? null,
    valid_days: r.valid_days ?? 7,
    expiration_date: r.expiration_date,
    portal_token: r.portal_token,
    include_reviews: (r.include_reviews ?? 1) === 1,
    review_ids: r.review_ids,
    include_contract: (r.include_contract ?? 1) === 1,
    contract_template_id: r.contract_template_id,
    client_signature: r.client_signature,
    signed: !!r.client_signature,
    signed_date: r.signed_date,
    viewed_date: r.viewed_date,
    approved_date: r.approved_date,
    portal_path: r.portal_token ? `/quote/${r.portal_token}` : null,
    notes: r.notes,
    version: r.version ?? 1,
    revised_from_id: r.revised_from_id,
    is_current_version: (r.is_current_version ?? 1) === 1,
    sent_at: r.sent_at,
    last_resent_at: r.last_resent_at ?? null,
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

  const linkedJob = await env.DB.prepare(
    "SELECT id, job_number FROM jobs WHERE estimate_id = ? LIMIT 1",
  )
    .bind(id)
    .first<{ id: string; job_number: number | null }>();

  // Every manual resend (audit trail for the SentStatusCard timeline).
  const resentRows = (
    await env.DB.prepare(
      `SELECT created_at FROM audit_logs
       WHERE entity_type = 'estimate' AND entity_id = ? AND action = 'estimate_resent'
       ORDER BY created_at ASC`,
    )
      .bind(id)
      .all<{ created_at: string }>()
  ).results ?? [];

  return {
    ...shapeEstimateHeader(row, totals),
    linked_job_id: linkedJob?.id ?? null,
    linked_job_number: linkedJob?.job_number ?? null,
    client_name: clientName,
    client_phone: ctx?.client_phone ?? null,
    client_email: ctx?.client_email ?? null,
    request_number: ctx?.request_number ?? null,
    property_address: ctx?.property_address ?? null,
    property_city: ctx?.property_city ?? null,
    property_state: ctx?.property_state ?? null,
    property_zip: ctx?.property_zip ?? null,
    job_type: ctx?.job_type ?? null,
    resent_dates: resentRows.map((r) => r.created_at),
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
    case "fifty_fifty":
      return {
        deposit_amount: round2(total * 0.5),
        deposit_type: "percentage",
        deposit_percentage: 50,
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
    case "per_line_item":
      return {
        deposit_amount: round2(total * 0.33),
        deposit_type: "percentage",
        deposit_percentage: 33,
      };
    default:
      return { deposit_amount: 0, deposit_type: "fixed", deposit_percentage: null };
  }
}

// ─── GET /api/estimates ───────────────────────────────────────────────────────

export async function handleEstimateList(env: Env, url: URL): Promise<Response> {
  const where: string[] = [NON_TEST_CLIENT];
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
           e.viewed_date, e.signed_date, e.created_at, e.updated_at,
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
    viewed_date: r.viewed_date ?? null,
    signed_date: r.signed_date ?? null,
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

// ─── DELETE /api/estimates/:id ────────────────────────────────────────────────

export async function handleEstimateDelete(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await env.DB.prepare(
    "SELECT id, estimate_number, title, status, client_id, request_id FROM estimates WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      estimate_number: number | null;
      title: string | null;
      status: string;
      client_id: string | null;
      request_id: string | null;
    }>();
  if (!row) return err(404, "not_found", "Estimate not found");

  if (row.status === "approved") {
    return json(
      {
        error: "cannot_delete_approved_estimate",
        message: "This estimate was approved and the deposit was paid. Delete the job instead.",
      },
      { status: 409 },
    );
  }

  const linked = await env.DB.prepare("SELECT id FROM jobs WHERE estimate_id = ? LIMIT 1")
    .bind(id)
    .first<{ id: string }>();
  if (linked) {
    return json(
      {
        error: "cannot_delete_converted_estimate",
        message: "This estimate has been converted to a job. Delete the job first.",
      },
      { status: 409 },
    );
  }

  if (row.request_id) {
    const req = await env.DB.prepare(
      "SELECT converted_job_id FROM estimate_requests WHERE id = ?",
    )
      .bind(row.request_id)
      .first<{ converted_job_id: string | null }>();
    if (req?.converted_job_id) {
      return json(
        {
          error: "cannot_delete_converted_estimate",
          message: "This request was already converted to a job.",
        },
        { status: 409 },
      );
    }
  }

  await cascadeDeleteEstimateChildren(env, id);

  const now = new Date().toISOString();
  if (row.request_id) {
    // Unlink and roll back to visit_done — "building" with no estimate is confusing.
    await env.DB.prepare(
      `UPDATE estimate_requests
          SET estimate_id = NULL,
              status = CASE WHEN status IN ('won','lost') THEN status ELSE 'visit_done' END,
              sent_date = CASE WHEN status IN ('won','lost') THEN sent_date ELSE NULL END,
              follow_up_count = CASE WHEN status IN ('won','lost') THEN follow_up_count ELSE 0 END,
              last_follow_up_date = CASE WHEN status IN ('won','lost') THEN last_follow_up_date ELSE NULL END,
              updated_at = ?
        WHERE id = ? AND estimate_id = ?`,
    )
      .bind(now, row.request_id, id)
      .run();
  } else {
    await env.DB.prepare("UPDATE estimate_requests SET estimate_id = NULL WHERE estimate_id = ?")
      .bind(id)
      .run();
  }

  await env.DB.prepare("DELETE FROM estimates WHERE id = ?").bind(id).run();

  await logAudit(env, user.email, "estimate_deleted", "estimate", id, {
    estimate_number: row.estimate_number,
    title: row.title,
    status: row.status,
    client_id: row.client_id,
    request_id: row.request_id,
  });

  return json({ ok: true, deleted: true, id });
}

// ─── POST /api/estimates ───────────────────────────────────────────────────────

export async function handleEstimateCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const requestId = str(body.estimate_request_id) ?? str(body.request_id);
  const directClientId = str(body.client_id);

  // Either a request_id (normal flow) or a direct client_id (standalone quick estimate) is required.
  if (!requestId && !directClientId) {
    return err(400, "bad_request", "estimate_request_id or client_id is required");
  }

  // ── Standalone (no request) path ──────────────────────────────────────────
  if (!requestId && directClientId) {
    const client = await env.DB.prepare("SELECT id, name, first_name, last_name FROM clients WHERE id = ?")
      .bind(directClientId)
      .first<{ id: string; name: string | null; first_name: string | null; last_name: string | null }>();
    if (!client) return err(404, "not_found", "Client not found");

    const mode = str(body.mode) ?? str(body.estimate_mode) ?? "trade_by_trade";
    const billingModel = str(body.billing_model) ?? "fixed_price";
    const clientLabel =
      [client.first_name, client.last_name].filter(Boolean).join(" ").trim() ||
      client.name ||
      "Client";
    const title = str(body.title) ?? `Estimate — ${clientLabel}`;
    const estimateNumber = await allocateNextEstimateNumber(env);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const dep = await defaultDeposit(env, billingModel, 0, null);

    await env.DB.prepare(
      `INSERT INTO estimates (
        id, estimate_number, request_id, client_id, title, estimate_mode, billing_model,
        status, subtotal, tax_amount, total, margin_percent,
        deposit_amount, deposit_type, deposit_percentage, valid_days,
        include_reviews, include_contract, version,
        created_at, updated_at, created_by
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'draft', 0, 0, 0, 0, ?, ?, ?, 7, 1, 1, 1, ?, ?, ?)`,
    )
      .bind(
        id,
        estimateNumber,
        directClientId,
        title,
        mode,
        billingModel,
        dep.deposit_amount,
        dep.deposit_type,
        dep.deposit_percentage,
        now,
        now,
        user.id,
      )
      .run();

    await logAudit(env, user.email, "estimate_created", "estimate", id, {
      estimate_number: estimateNumber,
      request_id: null,
      client_id: directClientId,
      mode,
      billing_model: billingModel,
      standalone: true,
    });

    const estimate = await loadFullEstimate(env, id);
    return json({ estimate, created: true }, { status: 201 });
  }

  // ── Normal (request-linked) path ──────────────────────────────────────────
  const req = await env.DB.prepare(
    `SELECT id, client_id, job_type, job_type_detail,
            property_address, property_city, property_state, property_zip, estimate_id
     FROM estimate_requests WHERE id = ?`,
  )
    .bind(requestId)
    .first<{
      id: string;
      client_id: string | null;
      job_type: string;
      job_type_detail: string | null;
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

  if (!req.client_id) {
    return err(
      400,
      "bad_request",
      "Link or create a client on this request before building an estimate",
    );
  }

  const mode = str(body.mode) ?? str(body.estimate_mode) ?? "trade_by_trade";
  const billingModel = str(body.billing_model) ?? "fixed_price";
  const title =
    str(body.title) ??
    `${jobTypeTitleFragment(req.job_type, req.job_type_detail)} — ${req.property_address ?? ""}`.trim();

  const estimateNumber = await allocateNextEstimateNumber(env);

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

  // Allow no-op updates (e.g. re-selecting the same billing model) so the
  // frontend can still run follow-up actions like payment-schedule auto-populate.
  if (updates.length === 0) {
    const estimate = await loadFullEstimate(env, id);
    return json({ estimate });
  }

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

export async function handleEstimateSend(
  request: Request,
  env: Env,
  id: string,
  exec?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
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
  const schedule = (
    await env.DB.prepare("SELECT * FROM payment_schedules WHERE estimate_id = ?")
      .bind(id)
      .all<PaymentRow>()
  ).results ?? [];

  // per_line_item estimates use a standalone deposit field (estimates.deposit_amount),
  // not payment_schedules milestones. Skip milestone validation for that model.
  const perLineItem = isPerLineItemBilling(est.billing_model);
  const depositDue = depositFromSchedule(schedule, totals.total);
  if (!perLineItem && depositDue <= 0) {
    return err(400, "send_blocked", "Add a deposit milestone to the payment schedule before sending.");
  }
  if (!perLineItem) {
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
  }

  const now = new Date();
  const validDays = est.valid_days ?? 7;
  const expiration = new Date(now.getTime() + validDays * 86_400_000);
  const portalToken = est.portal_token ?? crypto.randomUUID().replace(/-/g, "");

  // Freeze the contract text from the right template so the public page and the
  // signature both reference the exact words agreed to (legal review pending).
  let contractText: string | null = null;
  if ((est.include_contract ?? 1) === 1) {
    const ctx = await env.DB.prepare(
      `SELECT c.name AS client_name, c.first_name AS c_first, c.last_name AS c_last,
              er.property_address, er.property_city, er.property_state, er.property_zip
       FROM estimates e
       LEFT JOIN clients c ON c.id = e.client_id
       LEFT JOIN estimate_requests er ON er.id = e.request_id
       WHERE e.id = ?`,
    )
      .bind(id)
      .first<Record<string, unknown>>();
    const clientName =
      [ctx?.c_first, ctx?.c_last].filter(Boolean).join(" ").trim() ||
      (ctx?.client_name as string) ||
      null;
    const propertyAddress =
      [ctx?.property_address, ctx?.property_city, ctx?.property_state, ctx?.property_zip]
        .filter(Boolean)
        .join(", ") || null;
    const scheduleLines = schedule
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((p) => {
        const amt = shapePayment(p, totals.total).amount;
        const pct = p.percentage != null && p.fixed_amount == null ? ` (${p.percentage}%)` : "";
        const dep = (p.is_deposit ?? 0) === 1 ? " — deposit" : "";
        return `${p.description}: ${formatUsd(amt)}${pct}${dep}`;
      });
    contractText = await renderContract(env, {
      client_name: clientName,
      property_address: propertyAddress,
      job_title: est.title,
      total: totals.total,
      deposit_amount: est.deposit_amount,
      billing_model: est.billing_model,
      payment_schedule_lines: scheduleLines,
    });
  }

  await env.DB.prepare(
    `UPDATE estimates
     SET status = 'sent', sent_at = ?, expiration_date = ?, portal_token = ?,
         contract_text = ?, viewed_date = NULL, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      now.toISOString(),
      expiration.toISOString().slice(0, 10),
      portalToken,
      contractText,
      now.toISOString(),
      id,
    )
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

  // Generate Service Agreement at send time (estimate-phase, not job).
  let contractDocId: string | null = null;
  if ((est.include_contract ?? 1) === 1) {
    const contractResult = await generateAndSendEstimateContract(env, id, user.email, {
      exec,
    });
    contractDocId = contractResult.docId;
    if (contractResult.reason === "template_not_found") {
      console.error(`[estimate-send] contract generation failed for estimate ${id}`);
    }
  }

  await logAudit(env, user.email, "estimate_sent", "estimate", id, {
    total: totals.total,
    deposit_amount: est.deposit_amount,
    expiration_date: expiration.toISOString().slice(0, 10),
    contract_document_id: contractDocId,
  });

  // WC quotes-sent hook (count + dollar value; recomputed on next cron tick).
  triggerQuoteSent(env, id, totals.total);

  // Notification: estimate ready (sms+email). Enqueues then immediately
  // dispatches via waitUntil (cron remains the retry safety net). Keyed on the
  // estimate id so re-sending doesn't double-message until a re-send is
  // intended (a re-send mints the same token → same key; use revise for a true
  // new send). Needs the client id from the estimate.
  {
    const link = await env.DB.prepare("SELECT client_id, request_id FROM estimates WHERE id = ?")
      .bind(id)
      .first<{ client_id: string | null; request_id: string | null }>();
    if (link?.client_id) {
      await triggerNotification(
        env,
        "estimate_sent",
        {
          clientId: link.client_id,
          estimateId: id,
          estimateRequestId: link.request_id,
          instanceKey: now.toISOString().slice(0, 10),
        },
        { exec },
      );
    }
  }

  const estimate = await loadFullEstimate(env, id);
  // The public link is live now. Actual email/SMS delivery is the Notification
  // engine (Sprint 7); for now we surface a copyable link in the app.
  const publicUrl = `/quote/${portalToken}`;
  return json({ estimate, public_url: publicUrl, public_path: publicUrl });
}

// ─── POST /api/estimates/:id/mark-deposit-received ────────────────────────────
// Admin confirms cash/check deposit. Reuses the exact convertQuoteToJob path as
// Stripe webhook + Mark as Won (via estimate-requests/:id/win).

export async function handleEstimateMarkDepositReceived(
  request: Request,
  env: Env,
  id: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const est = await env.DB.prepare(
    "SELECT id, request_id, status FROM estimates WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; request_id: string | null; status: string }>();
  if (!est) return err(404, "not_found", "Estimate not found");
  if (!est.request_id) {
    return err(
      400,
      "no_request",
      "This estimate has no linked request — open the estimate request and use Mark as Won.",
    );
  }
  // Delegate to the shared win handler (same convertQuoteToJob completion logic).
  return handleEstimateRequestWin(request, env, est.request_id, ctx);
}

// ─── POST /api/estimates/:id/resend ─────────────────────────────────────────────
// Manual backup: re-fire the same estimate_sent notification as the original
// Send, without touching status / viewed / signed / deposit progress. Uses a
// unique instanceKey so dedupe doesn't block a deliberate re-delivery.

export async function handleEstimateResend(
  request: Request,
  env: Env,
  id: string,
  exec?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const est = await env.DB.prepare(
    `SELECT id, client_id, request_id, sent_at, status, viewed_date, signed_date, approved_date
     FROM estimates WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      client_id: string | null;
      request_id: string | null;
      sent_at: string | null;
      status: string;
      viewed_date: string | null;
      signed_date: string | null;
      approved_date: string | null;
    }>();
  if (!est) return err(404, "not_found", "Estimate not found");
  if (!est.sent_at) {
    return err(400, "not_sent", "Estimate must be sent at least once before it can be resent.");
  }
  if (!est.client_id) {
    return err(400, "no_client", "Estimate has no client on file to deliver to.");
  }

  const client = await env.DB.prepare(
    `SELECT first_name, last_name, name, email, phone FROM clients WHERE id = ?`,
  )
    .bind(est.client_id)
    .first<{
      first_name: string | null;
      last_name: string | null;
      name: string | null;
      email: string | null;
      phone: string | null;
    }>();
  const clientName =
    [client?.first_name, client?.last_name].filter(Boolean).join(" ").trim() ||
    client?.name ||
    "the client";

  const now = new Date();
  const nowIso = now.toISOString();

  // Same trigger + payload shape as handleEstimateSend — only instanceKey differs
  // (full ISO) so each manual resend bypasses the date-keyed dedupe of the original.
  // Immediate dispatch runs via waitUntil (shared engine); cron remains the retry net.
  const notifyResult = await triggerNotification(
    env,
    "estimate_sent",
    {
      clientId: est.client_id,
      estimateId: id,
      estimateRequestId: est.request_id,
      instanceKey: nowIso,
    },
    { exec },
  );

  await env.DB.prepare(
    `UPDATE estimates SET last_resent_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(nowIso, nowIso, id)
    .run();

  await logAudit(env, user.email, "estimate_resent", "estimate", id, {
    client_id: est.client_id,
    client_name: clientName,
    client_email: client?.email ?? null,
    client_phone: client?.phone ?? null,
    notification: notifyResult,
    // Prove we did not mutate progress fields
    status_unchanged: est.status,
    viewed_date_unchanged: est.viewed_date,
    signed_date_unchanged: est.signed_date,
    approved_date_unchanged: est.approved_date,
  });

  const estimate = await loadFullEstimate(env, id);
  return json({
    estimate,
    client_name: clientName,
    notification: notifyResult,
  });
}

// ─── POST /api/estimates/:id/lost ───────────────────────────────────────────────
// Marks the estimate's linked request lost with a reason (§4.8). Internal/auth.

const LOST_REASONS = new Set([
  "price_too_high",
  "went_with_competitor",
  "project_cancelled",
  "no_response",
  "timing",
  "other",
]);

export async function handleEstimateLost(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const est = await env.DB.prepare("SELECT id, request_id FROM estimates WHERE id = ?")
    .bind(id)
    .first<{ id: string; request_id: string | null }>();
  if (!est) return err(404, "not_found", "Estimate not found");
  if (!est.request_id) return err(400, "bad_request", "Estimate has no linked request to mark lost.");

  const body = (await readJson(request)) ?? {};
  const reason = str(body.reason) ?? str(body.lost_reason);
  if (!reason || !LOST_REASONS.has(reason)) {
    return err(
      400,
      "bad_request",
      "A valid reason is required: price_too_high, went_with_competitor, project_cancelled, no_response, timing, or other.",
    );
  }
  const notes = str(body.notes) ?? str(body.lost_notes);

  const reqRow = await env.DB.prepare("SELECT id, status FROM estimate_requests WHERE id = ?")
    .bind(est.request_id)
    .first<{ id: string; status: string }>();
  if (!reqRow) return err(404, "not_found", "Linked request not found");
  if (reqRow.status === "won") {
    return err(400, "bad_request", "Cannot mark a 'won' request as lost.");
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE estimate_requests
     SET status = 'lost', lost_reason = ?, lost_notes = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(reason, notes, now, est.request_id)
    .run();

  await logAudit(env, user.email, "estimate_lost", "estimate", id, {
    request_id: est.request_id,
    status_from: reqRow.status,
    lost_reason: reason,
  });

  const estimate = await loadFullEstimate(env, id);
  return json({ estimate, request_id: est.request_id, lost_reason: reason });
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

  // Only allow revision on estimates that have been sent to a client.
  if (!["sent", "viewed", "approved", "signed"].includes(orig.status)) {
    return err(409, "invalid_state", `Cannot revise an estimate with status '${orig.status}'. Revise is only available for sent, viewed, signed, or approved estimates.`);
  }

  // Block revision if this estimate has already been converted to a job.
  if (orig.request_id) {
    const req = await env.DB.prepare(
      "SELECT converted_job_id FROM estimate_requests WHERE id = ?",
    )
      .bind(orig.request_id)
      .first<{ converted_job_id: string | null }>();
    if (req?.converted_job_id) {
      return err(409, "already_converted", "This estimate has already been converted to a job. Use Change Orders to modify the project scope.");
    }
  }

  const newId = crypto.randomUUID();
  const now = new Date().toISOString();
  const estimateNumber = await allocateNextEstimateNumber(env);

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
          (id, parent_line_item_id, sort_order, description, category, vendor, quantity, unit, unit_cost, total_cost, material_id, notes, sub_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          si.sub_id ?? null,
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

  // Mark the original as revised + non-current. Null out its portal_token first
  // so the UNIQUE constraint doesn't fire when we assign it to the new row.
  await env.DB.prepare(
    "UPDATE estimates SET status = 'revised', is_current_version = 0, portal_token = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(now, id)
    .run();

  // Transfer the portal_token to the new version so the customer's existing
  // link continues to work — the token resolves to the current version because
  // this row now holds it. Also mark the new row as current version.
  if (orig.portal_token) {
    await env.DB.prepare(
      "UPDATE estimates SET portal_token = ?, is_current_version = 1, updated_at = ? WHERE id = ?",
    )
      .bind(orig.portal_token, now, newId)
      .run();
  }
  if (orig.request_id) {
    await env.DB.prepare(
      `UPDATE estimate_requests
       SET estimate_id = ?,
           follow_up_count = 0,
           last_follow_up_date = NULL,
           sent_date = NULL,
           status = CASE WHEN status IN ('sent','follow_up') THEN 'building' ELSE status END,
           updated_at = ?
       WHERE id = ?`,
    )
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
  if ("completion_status" in body) {
    const status = str(body.completion_status);
    if (status && !["not_started", "in_progress", "complete"].includes(status)) {
      return err(400, "bad_request", "completion_status must be not_started, in_progress, or complete.");
    }
    updates.push("completion_status = ?");
    binds.push(status ?? "not_started");
    if (status === "complete") {
      updates.push("completed_date = ?");
      binds.push(new Date().toISOString().slice(0, 10));
    } else if ("completion_status" in body) {
      updates.push("completed_date = ?");
      binds.push(null);
    }
  }
  if ("completed_date" in body && !("completion_status" in body)) {
    updates.push("completed_date = ?");
    binds.push(str(body.completed_date));
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

  let created: { id: string; estimate_id: string } | null;
  try {
    created = await createEstimateSubItem(
      env,
      lineItemId,
      {
        description: str(body.description),
        category: str(body.category),
        vendor: str(body.vendor),
        quantity: num(body.quantity),
        unit: str(body.unit),
        unit_cost: num(body.unit_cost) ?? 0,
        material_id: str(body.material_id),
        notes: str(body.notes),
        sort_order: num(body.sort_order),
        sub_id: str(body.sub_id),
      },
      { auditUserEmail: user.email },
    );
  } catch (e) {
    if (e instanceof SubItemValidationError) {
      return err(400, e.code, e.message);
    }
    throw e;
  }
  if (!created) return err(404, "not_found", "Parent line item not found");

  const row = await env.DB.prepare("SELECT * FROM estimate_sub_items WHERE id = ?")
    .bind(created.id)
    .first<SubItemRow>();
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

  const existingRow = await env.DB.prepare(
    "SELECT sub_id, category FROM estimate_sub_items WHERE id = ?",
  )
    .bind(subItemId)
    .first<{ sub_id: string | null; category: string }>();

  const updates: string[] = [];
  const binds: unknown[] = [];
  // Labor/Sub-linked rows: description/category/vendor are system snapshots — don't rewrite.
  const linked = Boolean(existingRow?.sub_id);
  const editableTextCols = linked
    ? (["unit", "notes"] as const)
    : (["description", "category", "vendor", "unit", "notes"] as const);
  for (const col of editableTextCols) {
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
  if ("material_id" in body && !linked) {
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

  const totals = await recomputeEstimate(env, estimateId);
  const saved = (
    await env.DB.prepare("SELECT * FROM payment_schedules WHERE estimate_id = ? ORDER BY sort_order ASC")
      .bind(estimateId)
      .all<PaymentRow>()
  ).results ?? [];
  const depositDue = depositFromSchedule(saved, totals.total);
  const depRow = saved.find((p) => (p.is_deposit ?? 0) === 1);
  await env.DB.prepare(
    "UPDATE estimates SET deposit_amount = ?, deposit_type = ?, deposit_percentage = ?, updated_at = ? WHERE id = ?",
  )
    .bind(
      depositDue,
      depRow?.percentage != null && depRow.fixed_amount == null ? "percentage" : "fixed",
      depRow?.percentage != null && depRow.fixed_amount == null ? depRow.percentage : null,
      new Date().toISOString(),
      estimateId,
    )
    .run();

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

// ─── Import supplier quote → material sub-items (AI extract + confirm) ────────

/** POST /api/estimate-sub-items/import-quote — read-only extraction. */
export async function handleImportQuoteExtract(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, ["owner", "project_manager"]);
  if (guarded instanceof Response) return guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const result = await extractSupplierQuote(env, {
    text: str(body.text),
    imageBase64: str(body.image_base64) ?? str(body.imageBase64),
    mediaType: str(body.media_type) ?? str(body.mediaType),
    pdfBase64: str(body.pdf_base64) ?? str(body.pdfBase64),
  });

  if (!result.ok) {
    return err(502, "extraction_failed", result.error ?? "Could not extract quote lines");
  }

  return json({
    vendor_guess: result.vendor_guess,
    lines: result.lines,
    quote_total: result.quote_total,
  });
}

/**
 * POST /api/line-items/:id/import-quote-confirm
 * Creates material sub-items for confirmed lines; optional vendor_materials upserts.
 */
export async function handleImportQuoteConfirm(
  request: Request,
  env: Env,
  lineItemId: string,
): Promise<Response> {
  const guarded = await guard(request, env, ["owner", "project_manager"]);
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

  const vendor = str(body.vendor) ?? "";
  const lines = Array.isArray(body.lines) ? body.lines : null;
  if (!lines || lines.length === 0) {
    return err(400, "bad_request", "Provide at least one line to import");
  }

  const createdIds: string[] = [];
  const priceBook: Array<{ material_name: string; created: boolean }> = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const raw of lines) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const description = str(row.description);
    if (!description) continue;

    const quantity = num(row.quantity) ?? 1;
    const unit = str(row.unit) ?? "each";
    const unitCost = num(row.unit_cost) ?? 0;
    const sku = str(row.sku);
    const notes = sku ? `SKU: ${sku}` : null;

    let created: { id: string; estimate_id: string } | null;
    try {
      created = await createEstimateSubItem(
        env,
        lineItemId,
        {
          description,
          category: "material",
          vendor: vendor || null,
          quantity,
          unit,
          unit_cost: unitCost,
          notes,
        },
        { auditUserEmail: user.email },
      );
    } catch (e) {
      if (e instanceof SubItemValidationError) {
        return err(400, e.code, e.message);
      }
      throw e;
    }
    if (!created) return err(404, "not_found", "Parent line item not found");
    createdIds.push(created.id);

    const saveBook =
      row.save_to_price_book === true ||
      row.save_to_price_book === 1 ||
      row.save_to_price_book === "true";
    if (saveBook && vendor && description && unit) {
      const price = unitCost;
      const upsert = await upsertVendorMaterial(env, {
        vendor,
        materialName: description,
        unit,
        category: "material",
        price,
        date: today,
        expenseId: null,
      });
      priceBook.push({ material_name: description, created: upsert.created });
    }
  }

  await logAudit(env, user.email, "estimate_quote_imported", "estimate", parent.estimate_id, {
    line_item_id: lineItemId,
    vendor,
    sub_item_ids: createdIds,
    price_book: priceBook,
  });

  const estimate = await loadFullEstimate(env, parent.estimate_id);
  return json({
    created_count: createdIds.length,
    sub_item_ids: createdIds,
    price_book: priceBook,
    estimate,
  }, { status: 201 });
}

