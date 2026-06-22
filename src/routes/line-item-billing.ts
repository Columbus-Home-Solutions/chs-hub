/**
 * Per-line-item billing API — Sprint 22.
 *
 *   GET  /api/jobs/:id/line-items-billing-status   line items + invoiced/blocked state
 *   POST /api/jobs/:id/line-item-invoice           create invoice for selected line items
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import {
  computeTotalDue,
  INVOICE_COLUMNS,
  round2,
  shapeInvoice,
  type InvoiceRow,
} from "../lib/invoicing.js";

const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;

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

interface LineItemRow {
  id: string;
  description: string;
  total: number | null;
  unit_price: number;
  quantity: number;
  completion_status: string | null;
  completed_date: string | null;
  blocked_by_line_item_id: string | null;
}

function lineAmount(li: LineItemRow): number {
  return round2(li.total ?? li.unit_price * li.quantity);
}

async function invoicedLineItemIds(env: Env, jobId: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    `SELECT line_item_ids FROM invoices
       WHERE job_id = ? AND status != 'void' AND line_item_ids IS NOT NULL AND line_item_ids != ''`,
  )
    .bind(jobId)
    .all<{ line_item_ids: string }>();

  const ids = new Set<string>();
  for (const r of results ?? []) {
    for (const id of r.line_item_ids.split(",").map((s) => s.trim()).filter(Boolean)) {
      ids.add(id);
    }
  }
  return ids;
}

async function loadJobLineItems(env: Env, jobId: string): Promise<LineItemRow[]> {
  const job = await env.DB.prepare("SELECT estimate_id FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ estimate_id: string | null }>();
  if (!job?.estimate_id) return [];

  const { results } = await env.DB.prepare(
    `SELECT id, description, total, unit_price, quantity,
            completion_status, completed_date, blocked_by_line_item_id
       FROM estimate_line_items
       WHERE estimate_id = ?
       ORDER BY sort_order ASC`,
  )
    .bind(job.estimate_id)
    .all<LineItemRow>();
  return results ?? [];
}

function isBlocked(
  li: LineItemRow,
  byId: Map<string, LineItemRow>,
): { blocked: boolean; blocking_description: string | null } {
  if (!li.blocked_by_line_item_id) return { blocked: false, blocking_description: null };
  const prereq = byId.get(li.blocked_by_line_item_id);
  if (!prereq) return { blocked: false, blocking_description: null };
  const prereqComplete = (prereq.completion_status ?? "not_started") === "complete";
  if (prereqComplete) return { blocked: false, blocking_description: null };
  return { blocked: true, blocking_description: prereq.description };
}

export async function handleLineItemsBillingStatus(env: Env, jobId: string): Promise<Response> {
  const job = await env.DB.prepare(
    "SELECT id, billing_model, estimate_id, contract_total, payer_id FROM jobs WHERE id = ? AND source = 'estimate'",
  )
    .bind(jobId)
    .first<{
      id: string;
      billing_model: string | null;
      estimate_id: string | null;
      contract_total: number | null;
      payer_id: string | null;
    }>();
  if (!job) return err(404, "not_found", "Job not found.");

  const items = await loadJobLineItems(env, jobId);
  const invoiced = await invoicedLineItemIds(env, jobId);
  const byId = new Map(items.map((li) => [li.id, li]));

  let totalInvoiced = 0;
  const lineItems = items.map((li) => {
    const amount = lineAmount(li);
    const isInvoiced = invoiced.has(li.id);
    if (isInvoiced) totalInvoiced += amount;
    const { blocked, blocking_description } = isBlocked(li, byId);
    return {
      id: li.id,
      description: li.description,
      amount,
      completion_status: li.completion_status ?? "not_started",
      completed_date: li.completed_date,
      blocked_by_line_item_id: li.blocked_by_line_item_id,
      invoiced: isInvoiced,
      blocked,
      blocking_item_description: blocking_description,
    };
  });

  const contractTotal = round2(job.contract_total ?? 0);
  return json({
    job_id: jobId,
    billing_model: job.billing_model,
    payer_id: job.payer_id,
    summary: {
      contract_total: contractTotal,
      total_invoiced: round2(totalInvoiced),
      amount_remaining: round2(Math.max(0, contractTotal - totalInvoiced)),
    },
    line_items: lineItems,
  });
}

export async function handleLineItemInvoiceCreate(
  request: Request,
  env: Env,
  jobId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const job = await env.DB.prepare(
    `SELECT id, client_id, billing_model, payer_id, estimate_id, contract_total, conversion_reversed
       FROM jobs WHERE id = ? AND source = 'estimate'`,
  )
    .bind(jobId)
    .first<{
      id: string;
      client_id: string | null;
      billing_model: string | null;
      payer_id: string | null;
      estimate_id: string | null;
      contract_total: number | null;
      conversion_reversed: number | null;
    }>();
  if (!job) return err(404, "not_found", "Job not found.");
  if (job.billing_model !== "per_line_item") {
    return err(400, "wrong_billing_model", "Line-item invoicing requires billing_model = per_line_item.");
  }
  if ((job.conversion_reversed ?? 0) === 1) {
    return err(409, "job_reversed", "This job's conversion was reversed; new invoices are blocked.");
  }

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const rawIds = body.line_item_ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return err(400, "bad_request", "line_item_ids must be a non-empty array.");
  }
  const lineItemIds = rawIds.map((id) => String(id).trim()).filter(Boolean);
  if (lineItemIds.length === 0) {
    return err(400, "bad_request", "line_item_ids must contain at least one valid id.");
  }

  const items = await loadJobLineItems(env, jobId);
  const byId = new Map(items.map((li) => [li.id, li]));
  const invoiced = await invoicedLineItemIds(env, jobId);

  const alreadyInvoiced: string[] = [];
  const blockedItems: string[] = [];
  const missing: string[] = [];
  let amount = 0;

  for (const id of lineItemIds) {
    const li = byId.get(id);
    if (!li) {
      missing.push(id);
      continue;
    }
    if (invoiced.has(id)) {
      alreadyInvoiced.push(li.description);
      continue;
    }
    const { blocked } = isBlocked(li, byId);
    if (blocked) {
      blockedItems.push(li.description);
      continue;
    }
    amount += lineAmount(li);
  }

  if (missing.length > 0) {
    return err(400, "invalid_line_items", `Unknown line item ids: ${missing.join(", ")}`);
  }
  if (alreadyInvoiced.length > 0) {
    return err(
      409,
      "already_invoiced",
      `These line items are already invoiced: ${alreadyInvoiced.join("; ")}`,
    );
  }
  if (blockedItems.length > 0) {
    return err(
      409,
      "blocked_line_items",
      `These line items are blocked by incomplete prerequisites: ${blockedItems.join("; ")}`,
    );
  }
  if (amount <= 0) {
    return err(400, "bad_request", "Selected line items have no billable amount.");
  }

  const notes = str(body.notes);
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const invoiceId = crypto.randomUUID();
  const paymentToken = crypto.randomUUID().replace(/-/g, "");
  const lineItemIdsCsv = lineItemIds.join(",");
  const totalDue = computeTotalDue(amount, 0, 0, 0);
  const title = `Line Item Completion — ${lineItemIds.length} item(s)`;

  const insertSql = `INSERT INTO invoices (
      id, invoice_number, job_id, client_id, billing_model, invoice_type, title,
      amount, tax_amount, late_fee_amount, credits_applied, total_due, status,
      payment_token, line_item_ids, payer_id, notes, synced_at, created_at, created_by
    )
    SELECT ?, COALESCE((SELECT MAX(invoice_number) FROM invoices), 0) + 1, ?, ?, 'per_line_item',
           'line_item_completion', ?, ?, 0, 0, 0, ?, 'draft', ?, ?, ?, ?, ?, ?, ?`;

  let inserted = false;
  for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
    try {
      await env.DB.prepare(insertSql)
        .bind(
          invoiceId,
          jobId,
          job.client_id,
          title,
          amount,
          totalDue,
          paymentToken,
          lineItemIdsCsv,
          job.payer_id,
          notes,
          nowIso,
          nowIso,
          user.email,
        )
        .run();
      inserted = true;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (!msg.includes("UNIQUE") || attempt === 2) throw e;
    }
  }

  for (const id of lineItemIds) {
    await env.DB.prepare(
      `UPDATE estimate_line_items SET completion_status = 'complete', completed_date = ? WHERE id = ?`,
    )
      .bind(today, id)
      .run();
  }

  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'line_item_invoice_created', 'invoice', ?, ?, datetime('now'))",
  )
    .bind(
      crypto.randomUUID(),
      user.email,
      invoiceId,
      JSON.stringify({ job_id: jobId, line_item_ids: lineItemIds, amount }),
    )
    .run();

  const inv = await env.DB.prepare(
    `SELECT ${INVOICE_COLUMNS}, line_item_ids, payer_id FROM invoices WHERE id = ?`,
  )
    .bind(invoiceId)
    .first<InvoiceRow & { line_item_ids: string | null; payer_id: string | null }>();

  return json({ invoice: inv ? shapeInvoice(inv) : null }, { status: 201 });
}
