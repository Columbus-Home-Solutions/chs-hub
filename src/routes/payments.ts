/**
 * Payments API — Sprint 9 (CHS-API-Route-Map §5 Financial).
 *
 *   GET  /api/payments            list + filters (?job_id=&method=&from=&to=)   [O/OA]
 *   POST /api/payments            record a MANUAL payment (check/cash)          [O/OA]
 *   GET  /api/jobs/:id/payments   payments for a job                            [O/PM/OA]
 *
 * The shared recordPayment() is the single insert path both the manual route and
 * the Stripe webhook use. It is IDEMPOTENT on the Stripe PaymentIntent id (the
 * partial UNIQUE index idx_payments_stripe_payment_id is the backstop), recomputes
 * the linked invoice's status, and fires the (simulated) payment-receipt
 * notification — exactly once per real payment.
 *
 * Money rules: manual (check/cash) payments carry NO convenience fee and
 * net_amount = amount. Electronic payments (from the webhook) carry the 3.5%
 * convenience fee (revenue, tracked separately) and net_amount = amount -
 * stripe_fee. The convenience fee is never folded into contract value / New Sales.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { triggerPaymentReceived } from "../lib/notification-engine.js";
import { recomputeInvoiceStatus, round2 } from "../lib/invoicing.js";

const PAYMENT_ROLES = ["owner", "office_admin"] as const;
const JOB_READ_ROLES = ["owner", "project_manager", "office_admin"] as const;
const MANUAL_METHODS = new Set(["check", "cash"]);

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

export interface RecordPaymentArgs {
  jobId: string | null;
  invoiceId: string | null;
  clientId: string | null;
  amount: number;
  method: string; // check | cash | credit_card | ach
  convenienceFee?: number | null;
  stripeFee?: number | null;
  stripePaymentId?: string | null;
  receivedDate?: string | null;
  notes?: string | null;
}

export interface RecordPaymentResult {
  created: boolean;
  paymentId: string;
  invoiceStatus?: string;
}

/**
 * Insert a payment idempotently and update the linked invoice + receipt.
 * Idempotency: keyed on stripe_payment_id (a re-delivered Stripe event or a
 * double manual submit with the same PaymentIntent never double-inserts). When
 * no stripe id is present (manual check/cash), each call records a payment.
 */
export async function recordPayment(env: Env, a: RecordPaymentArgs): Promise<RecordPaymentResult> {
  // Idempotency: if this PaymentIntent already produced a payment, no-op.
  if (a.stripePaymentId) {
    const existing = await env.DB.prepare(
      "SELECT id FROM payments WHERE stripe_payment_id = ?",
    )
      .bind(a.stripePaymentId)
      .first<{ id: string }>();
    if (existing) {
      return { created: false, paymentId: existing.id };
    }
  }

  const amount = round2(a.amount);
  const stripeFee = a.stripeFee != null ? round2(a.stripeFee) : null;
  const convenienceFee = a.convenienceFee != null ? round2(a.convenienceFee) : null;
  const netAmount = round2(amount - (stripeFee ?? 0)); // convenience fee is revenue, NOT netted out
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const receivedDate = a.receivedDate ?? nowIso.slice(0, 10);

  try {
    await env.DB.prepare(
      `INSERT INTO payments (
         id, job_id, invoice_id, client_id, amount, convenience_fee, stripe_fee, net_amount,
         payment_method, stripe_payment_id, received_date, collected_at, notes, synced_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        a.jobId,
        a.invoiceId,
        a.clientId,
        amount,
        convenienceFee,
        stripeFee,
        netAmount,
        a.method,
        a.stripePaymentId ?? null,
        receivedDate,
        nowIso,
        a.notes ?? null,
        nowIso,
        nowIso,
      )
      .run();
  } catch (e) {
    // UNIQUE backstop on stripe_payment_id — a racing redelivery lost. Treat as
    // idempotent: return the row that won.
    if (/UNIQUE/i.test((e as Error).message ?? "") && a.stripePaymentId) {
      const existing = await env.DB.prepare("SELECT id FROM payments WHERE stripe_payment_id = ?")
        .bind(a.stripePaymentId)
        .first<{ id: string }>();
      if (existing) return { created: false, paymentId: existing.id };
    }
    throw e;
  }

  let invoiceStatus: string | undefined;
  if (a.invoiceId) {
    const res = await recomputeInvoiceStatus(env, a.invoiceId);
    invoiceStatus = res?.status;
  }

  // Payment-receipt notification (simulated) — once per real payment.
  await triggerPaymentReceived(env, id);

  return { created: true, paymentId: id, invoiceStatus };
}

// ─── GET /api/payments ────────────────────────────────────────────────────────

export async function handlePaymentList(request: Request, env: Env, url: URL): Promise<Response> {
  const guarded = await guard(request, env, [...PAYMENT_ROLES]);
  if (guarded instanceof Response) return guarded;

  const jobId = url.searchParams.get("job_id");
  const method = url.searchParams.get("method");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const where: string[] = [];
  const binds: unknown[] = [];
  if (jobId) (where.push("job_id = ?"), binds.push(jobId));
  if (method) (where.push("payment_method = ?"), binds.push(method));
  if (from) (where.push("COALESCE(received_date, created_at) >= ?"), binds.push(from));
  if (to) (where.push("COALESCE(received_date, created_at) <= ?"), binds.push(to));

  const sql = `SELECT id, job_id, invoice_id, client_id, amount, convenience_fee, stripe_fee,
      net_amount, payment_method, stripe_payment_id, received_date, notes, created_at
    FROM payments${where.length ? " WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(received_date, created_at) DESC`;
  const rows = (await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results ?? [];
  return json({ total: rows.length, payments: rows });
}

// ─── POST /api/payments (manual check/cash) ───────────────────────────────────

export async function handlePaymentCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...PAYMENT_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const method = str(body.payment_method) ?? "check";
  if (!MANUAL_METHODS.has(method)) {
    return err(400, "bad_request", "Manual payments are check or cash only. Card/ACH flows through Stripe.");
  }
  const amount = num(body.amount);
  if (amount == null || amount <= 0) return err(400, "bad_request", "amount must be greater than zero.");

  const invoiceId = str(body.invoice_id);
  let jobId = str(body.job_id);
  let clientId = str(body.client_id);

  if (invoiceId) {
    const inv = await env.DB.prepare("SELECT job_id, client_id, status FROM invoices WHERE id = ?")
      .bind(invoiceId)
      .first<{ job_id: string | null; client_id: string | null; status: string | null }>();
    if (!inv) return err(404, "not_found", "Invoice not found.");
    if (inv.status === "void") return err(409, "invoice_void", "Cannot record a payment against a voided invoice.");
    jobId = jobId ?? inv.job_id;
    clientId = clientId ?? inv.client_id;
  }
  if (!jobId) return err(400, "bad_request", "job_id (or invoice_id) is required.");

  const result = await recordPayment(env, {
    jobId,
    invoiceId,
    clientId,
    amount,
    method, // no convenience fee, no stripe fee → net_amount = amount
    receivedDate: str(body.received_date),
    notes: str(body.notes),
  });

  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'payment_recorded', ?, ?, ?, datetime('now'))",
  )
    .bind(
      crypto.randomUUID(),
      user.email,
      invoiceId ? "invoice" : "job",
      invoiceId ?? jobId,
      JSON.stringify({ payment_id: result.paymentId, amount, method, invoice_status: result.invoiceStatus }),
    )
    .run();

  return json({ payment_id: result.paymentId, invoice_status: result.invoiceStatus }, { status: 201 });
}

// ─── GET /api/jobs/:id/payments ───────────────────────────────────────────────

export async function handleJobPayments(request: Request, env: Env, jobId: string): Promise<Response> {
  const guarded = await guard(request, env, [...JOB_READ_ROLES]);
  if (guarded instanceof Response) return guarded;

  const rows = (
    await env.DB.prepare(
      `SELECT id, job_id, invoice_id, client_id, amount, convenience_fee, stripe_fee, net_amount,
              payment_method, stripe_payment_id, received_date, notes, created_at
         FROM payments WHERE job_id = ? ORDER BY COALESCE(received_date, created_at) DESC`,
    )
      .bind(jobId)
      .all<Record<string, unknown>>()
  ).results ?? [];
  return json({ job_id: jobId, total: rows.length, payments: rows });
}
