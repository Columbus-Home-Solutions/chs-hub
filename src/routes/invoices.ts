/**
 * Invoices API — Sprint 9 (CHS-API-Route-Map §5 Financial).
 *
 *   GET  /api/invoices               list + filters (?job_id=&status=&billing_model=&from=&to=)
 *   GET  /api/invoices/:id           detail (+ its payments)
 *   POST /api/invoices               create (invoice_number allocated in-transaction)
 *   PUT  /api/invoices/:id           update (draft/sent only)
 *   POST /api/invoices/:id/send      generate payment link, status='sent', enqueue send notification
 *   POST /api/invoices/:id/void      O only — status='void', preserved for audit
 *   GET  /api/jobs/:id/invoices      invoices for a job (+ summary + generation suggestions)
 *
 * Roles: invoices O/PM/OA; void O only. Reads stay open (dashboard host is
 * Access-gated, matching the chs-hub convention); writes go through guard().
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { triggerInvoiceSent } from "../lib/notification-engine.js";
import {
  INVOICE_COLUMNS,
  INVOICE_TYPES,
  type InvoiceType,
  computeSuggestions,
  computeTotalDue,
  loadInvoice,
  paymentLink,
  round2,
  shapeInvoice,
  type InvoiceRow,
} from "../lib/invoicing.js";

const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;
const VOID_ROLES = ["owner"] as const;

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
async function logAudit(
  env: Env,
  userEmail: string,
  action: string,
  entityId: string,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, 'invoice', ?, ?, datetime('now'))",
  )
    .bind(crypto.randomUUID(), userEmail, action, entityId, JSON.stringify(details))
    .run();
}

async function paymentsForInvoice(env: Env, invoiceId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, amount, payment_method, convenience_fee, stripe_fee, net_amount,
            stripe_payment_id, received_date, notes, created_at
       FROM payments WHERE invoice_id = ? ORDER BY COALESCE(received_date, created_at) DESC`,
  )
    .bind(invoiceId)
    .all<Record<string, unknown>>();
  return results ?? [];
}

// ─── GET /api/invoices ────────────────────────────────────────────────────────

export async function handleInvoiceList(env: Env, url: URL): Promise<Response> {
  const jobId = url.searchParams.get("job_id");
  const status = url.searchParams.get("status");
  const billingModel = url.searchParams.get("billing_model");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const where: string[] = [];
  const binds: unknown[] = [];
  if (jobId) (where.push("job_id = ?"), binds.push(jobId));
  if (status) (where.push("status = ?"), binds.push(status));
  if (billingModel) (where.push("billing_model = ?"), binds.push(billingModel));
  if (from) (where.push("COALESCE(issued_date, created_at) >= ?"), binds.push(from));
  if (to) (where.push("COALESCE(issued_date, created_at) <= ?"), binds.push(to));

  const sql = `SELECT ${INVOICE_COLUMNS} FROM invoices${
    where.length ? " WHERE " + where.join(" AND ") : ""
  } ORDER BY COALESCE(invoice_number, 0) DESC, created_at DESC`;
  const rows = (await env.DB.prepare(sql).bind(...binds).all<InvoiceRow>()).results ?? [];
  return json({ total: rows.length, invoices: rows.map(shapeInvoice) });
}

// ─── GET /api/invoices/:id ────────────────────────────────────────────────────

export async function handleInvoiceGet(env: Env, id: string): Promise<Response> {
  const inv = await loadInvoice(env, id);
  if (!inv) return err(404, "not_found", "Invoice not found.");
  return json({ invoice: shapeInvoice(inv), payments: await paymentsForInvoice(env, id) });
}

// ─── POST /api/invoices ───────────────────────────────────────────────────────

interface JobCtx {
  id: string;
  client_id: string | null;
  billing_model: string | null;
  conversion_reversed: number | null;
}

export async function handleInvoiceCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const jobId = str(body.job_id);
  if (!jobId) return err(400, "bad_request", "job_id is required (invoices are always job-scoped).");

  const invoiceType = (str(body.invoice_type) ?? "manual") as InvoiceType;
  if (!INVOICE_TYPES.includes(invoiceType)) {
    return err(400, "bad_request", `invoice_type must be one of: ${INVOICE_TYPES.join(", ")}`);
  }

  const job = await env.DB.prepare(
    "SELECT id, client_id, billing_model, conversion_reversed FROM jobs WHERE id = ? AND source = 'estimate'",
  )
    .bind(jobId)
    .first<JobCtx>();
  if (!job) return err(404, "not_found", "Job not found.");
  if ((job.conversion_reversed ?? 0) === 1) {
    return err(409, "job_reversed", "This job's conversion was reversed; new invoices are blocked.");
  }

  const amount = num(body.amount);
  if (amount == null || amount <= 0) return err(400, "bad_request", "amount must be greater than zero.");
  const taxAmount = num(body.tax_amount) ?? 0;
  const credits = num(body.credits_applied) ?? 0;
  const totalDue = computeTotalDue(amount, taxAmount, 0, credits);

  const title = str(body.title) ?? defaultTitle(invoiceType);
  const description = str(body.description);
  const dueDate = str(body.due_date);
  const milestoneNumber = num(body.milestone_number);
  const tradeLineItemId = str(body.trade_line_item_id);
  const costPlusCycleId = str(body.cost_plus_cycle_id);
  const notes = str(body.notes);
  const billingScheduleId = str(body.billing_schedule_id);

  const id = crypto.randomUUID();
  const paymentToken = crypto.randomUUID().replace(/-/g, "");
  const nowIso = new Date().toISOString();

  // invoice_number is allocated INSIDE the INSERT via COALESCE(MAX)+1, backed by
  // the UNIQUE index idx_invoices_invoice_number. A concurrent racer that picks
  // the same number fails the UNIQUE constraint cleanly; we retry a few times.
  const insertSql = `INSERT INTO invoices (
      id, invoice_number, job_id, client_id, billing_model, invoice_type, title, description,
      amount, tax_amount, late_fee_amount, credits_applied, total_due, status, due_date,
      payment_token, portal_link, milestone_number, trade_line_item_id, cost_plus_cycle_id,
      notes, synced_at, created_at, created_by
    )
    SELECT ?, COALESCE((SELECT MAX(invoice_number) FROM invoices), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'draft', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?`;
  const binds = [
    id,
    jobId,
    job.client_id,
    job.billing_model,
    invoiceType,
    title,
    description,
    amount,
    taxAmount,
    credits,
    totalDue,
    dueDate,
    paymentToken,
    milestoneNumber,
    tradeLineItemId,
    costPlusCycleId,
    notes,
    nowIso,
    nowIso,
    user.email,
  ];

  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await env.DB.prepare(insertSql).bind(...binds).run();
      break;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (/UNIQUE/i.test(msg) && msg.includes("invoice_number") && attempts < 4) {
        attempts++;
        continue; // collision → re-run MAX()+1 (allocates the next free number)
      }
      throw e;
    }
  }

  // Link the originating billing_schedule row so suggestions don't re-offer it.
  if (billingScheduleId) {
    await env.DB.prepare("UPDATE billing_schedule SET status = 'invoiced' WHERE id = ? AND job_id = ?")
      .bind(billingScheduleId, jobId)
      .run();
  }

  const inv = await loadInvoice(env, id);
  await logAudit(env, user.email, "invoice_created", id, {
    invoice_number: inv?.invoice_number,
    invoice_type: invoiceType,
    amount,
    total_due: totalDue,
    job_id: jobId,
  });

  return json({ invoice: shapeInvoice(inv!) }, { status: 201 });
}

function defaultTitle(t: InvoiceType): string {
  switch (t) {
    case "deposit": return "Deposit";
    case "milestone": return "Milestone Draw";
    case "trade_completion": return "Trade Completion";
    case "final": return "Final Invoice";
    case "change_order": return "Change Order";
    case "cost_plus_cycle": return "Billing Cycle";
    default: return "Invoice";
  }
}

// ─── PUT /api/invoices/:id ────────────────────────────────────────────────────

export async function handleInvoiceUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const inv = await loadInvoice(env, id);
  if (!inv) return err(404, "not_found", "Invoice not found.");
  if (inv.status === "void") return err(409, "invoice_void", "Voided invoices cannot be edited.");
  if (inv.status === "paid") return err(409, "invoice_paid", "Paid invoices cannot be edited.");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const amount = "amount" in body ? num(body.amount) : inv.amount;
  if (amount == null || amount <= 0) return err(400, "bad_request", "amount must be greater than zero.");
  const taxAmount = "tax_amount" in body ? num(body.tax_amount) ?? 0 : inv.tax_amount ?? 0;
  const credits = "credits_applied" in body ? num(body.credits_applied) ?? 0 : inv.credits_applied ?? 0;
  const lateFee = inv.late_fee_amount ?? 0;
  const totalDue = computeTotalDue(amount, taxAmount, lateFee, credits);

  const title = "title" in body ? str(body.title) : inv.title;
  const description = "description" in body ? str(body.description) : inv.description;
  const dueDate = "due_date" in body ? str(body.due_date) : inv.due_date;
  const notes = "notes" in body ? str(body.notes) : inv.notes;
  const milestoneNumber = "milestone_number" in body ? num(body.milestone_number) : inv.milestone_number;

  await env.DB.prepare(
    `UPDATE invoices SET amount = ?, tax_amount = ?, credits_applied = ?, total_due = ?,
       title = ?, description = ?, due_date = ?, notes = ?, milestone_number = ? WHERE id = ?`,
  )
    .bind(amount, taxAmount, credits, totalDue, title, description, dueDate, notes, milestoneNumber, id)
    .run();

  await logAudit(env, user.email, "invoice_updated", id, { amount, total_due: totalDue });
  return handleInvoiceGet(env, id);
}

// ─── POST /api/invoices/:id/send ──────────────────────────────────────────────

export async function handleInvoiceSend(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const inv = await loadInvoice(env, id);
  if (!inv) return err(404, "not_found", "Invoice not found.");
  if (inv.status === "void") return err(409, "invoice_void", "Voided invoices cannot be sent.");
  if (inv.status === "paid") return err(409, "invoice_paid", "This invoice is already paid.");

  // Business rule #1: an invoice cannot be sent without a valid client email.
  const client = inv.client_id
    ? await env.DB.prepare("SELECT email FROM clients WHERE id = ?")
        .bind(inv.client_id)
        .first<{ email: string | null }>()
    : null;
  const email = (client?.email ?? "").trim();
  if (!email || !email.includes("@")) {
    return err(422, "no_client_email", "The client has no valid email address — add one before sending.");
  }

  const token = inv.payment_token ?? crypto.randomUUID().replace(/-/g, "");
  const link = paymentLink(env, token);
  const nowIso = new Date().toISOString();
  // Default the due date to sent + 7 days if it wasn't set (the 7-day grace).
  const dueDate = inv.due_date ?? new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  await env.DB.prepare(
    `UPDATE invoices SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
       sent_date = COALESCE(sent_date, ?), issued_date = COALESCE(issued_date, ?),
       due_date = ?, payment_token = ?, portal_link = ? WHERE id = ?`,
  )
    .bind(nowIso, nowIso.slice(0, 10), dueDate, token, link, id)
    .run();

  await logAudit(env, user.email, "invoice_sent", id, {
    invoice_number: inv.invoice_number,
    to: email,
    payment_link: link,
  });

  // Fire the (simulated) invoice-delivery notification with the payment link.
  await triggerInvoiceSent(env, id, {
    invoice_number: inv.invoice_number != null ? String(inv.invoice_number) : "",
    invoice_amount: usd(inv.total_due ?? inv.amount ?? 0),
    due_date: fmtDate(dueDate),
    payment_link: link,
  });

  return handleInvoiceGet(env, id);
}

// ─── POST /api/invoices/:id/void (O only) ─────────────────────────────────────

export async function handleInvoiceVoid(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...VOID_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const inv = await loadInvoice(env, id);
  if (!inv) return err(404, "not_found", "Invoice not found.");
  if (inv.status === "void") return handleInvoiceGet(env, id); // idempotent
  if (inv.status === "paid") {
    return err(409, "invoice_paid", "A paid invoice can't be voided — use a refund / reverse-conversion instead.");
  }

  const body = await readJson(request);
  const reason = body ? str(body.reason) : null;
  await env.DB.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").bind(id).run();
  await logAudit(env, user.email, "invoice_voided", id, { invoice_number: inv.invoice_number, reason });
  return handleInvoiceGet(env, id);
}

// ─── GET /api/jobs/:id/invoices (+ summary + suggestions) ─────────────────────

export async function handleJobInvoices(env: Env, jobId: string): Promise<Response> {
  const job = await env.DB.prepare(
    "SELECT id, billing_model, contract_total FROM jobs WHERE id = ? AND source = 'estimate'",
  )
    .bind(jobId)
    .first<{ id: string; billing_model: string | null; contract_total: number | null }>();
  if (!job) return err(404, "not_found", "Job not found.");

  const rows = (
    await env.DB.prepare(
      `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE job_id = ? ORDER BY COALESCE(invoice_number, 0) DESC, created_at DESC`,
    )
      .bind(jobId)
      .all<InvoiceRow>()
  ).results ?? [];
  const invoices = rows.map(shapeInvoice);

  // Summary bar: invoiced (non-void), paid, balance due.
  const totalInvoiced = round2(
    rows.filter((r) => r.status !== "void").reduce((s, r) => s + (r.total_due ?? r.amount ?? 0), 0),
  );
  const paidAgg = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE job_id = ?",
  )
    .bind(jobId)
    .first<{ paid: number }>();
  const totalPaid = round2(paidAgg?.paid ?? 0);
  const contractTotal = round2(job.contract_total ?? 0);

  const suggestions = await computeSuggestions(env, jobId, job.billing_model, contractTotal);

  return json({
    job_id: jobId,
    billing_model: job.billing_model,
    summary: {
      contract_total: contractTotal,
      total_invoiced: totalInvoiced,
      total_paid: totalPaid,
      balance_due: round2(totalInvoiced - totalPaid),
    },
    invoices,
    suggestions,
  });
}

function usd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
