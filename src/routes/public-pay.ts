/**
 * Public, token-gated invoice payment page (Sprint 9) — the invoice analogue of
 * public-quote.ts. UNAUTHENTICATED: the invoice's per-row payment_token is the
 * only credential. Mirrors the quote pay flow (3.5% convenience fee, Stripe
 * PaymentIntent) but for an issued invoice instead of a deposit.
 *
 *   GET  /api/public/pay/:token          client-facing invoice payload (+view track)
 *   POST /api/public/pay/:token/intent   Stripe PaymentIntent (balance + 3.5%)
 *
 * The PaymentIntent metadata carries invoice_id/job_id/client_id/base_amount/
 * convenience_fee — the SAME webhook (POST /api/webhooks/stripe) recognizes
 * metadata.invoice_id and routes to recordPayment(). One payment path, idempotent.
 *
 * HARD RULE: this endpoint never exposes internal cost data, other invoices, or
 * line-item sub-items — only the narrow invoice summary the client needs to pay.
 */

import type { Env } from "../env.js";
import {
  convenienceFee as computeFee,
  createPaymentIntent,
  getStripeConfig,
} from "../lib/stripe.js";
import { CONVENIENCE_FEE_RATE, invoiceLabel, loadInvoiceByToken, round2 } from "../lib/invoicing.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}
function usd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

const PAYABLE_STATUSES = new Set(["sent", "viewed", "partial", "past_due"]);

async function collectedForInvoice(env: Env, invoiceId: string): Promise<number> {
  const agg = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = ?",
  )
    .bind(invoiceId)
    .first<{ paid: number }>();
  return round2(agg?.paid ?? 0);
}

async function companyName(env: Env): Promise<string> {
  const r = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = 'company_name'",
  )
    .first<{ value: string | null }>()
    .catch(() => null);
  return (r?.value ?? "").trim() || "Columbus Home Solutions, LLC";
}

// ─── GET /api/public/pay/:token ───────────────────────────────────────────────

export async function handlePublicPayGet(env: Env, token: string): Promise<Response> {
  const inv = await loadInvoiceByToken(env, token);
  if (!inv) return err(404, "not_found", "This payment link is invalid or no longer available.");
  if (inv.status === "draft") {
    return err(404, "not_found", "This invoice has not been issued yet.");
  }
  if (inv.status === "void") {
    return err(410, "void", "This invoice has been voided and can no longer be paid.");
  }

  // Track first view (sent → viewed) without disturbing later statuses.
  if (!inv.viewed_date) {
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE invoices SET viewed_date = ?, status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END WHERE id = ?",
    )
      .bind(nowIso, inv.id)
      .run();
  }

  const collected = await collectedForInvoice(env, inv.id);
  const totalDue = round2(inv.total_due ?? inv.amount ?? 0);
  const balance = Math.max(0, round2(totalDue - collected));
  const feePreview = balance > 0 ? computeFee(balance, CONVENIENCE_FEE_RATE) : 0;

  return json({
    ok: true,
    company_name: await companyName(env),
    invoice: {
      invoice_number: inv.invoice_number,
      invoice_display: invoiceLabel(inv.invoice_number),
      title: inv.title,
      description: inv.description,
      invoice_type: inv.invoice_type,
      amount: round2(inv.amount ?? 0),
      tax_amount: round2(inv.tax_amount ?? 0),
      late_fee_amount: round2(inv.late_fee_amount ?? 0),
      credits_applied: round2(inv.credits_applied ?? 0),
      total_due: totalDue,
      collected,
      balance,
      due_date: inv.due_date,
      status: inv.status,
      paid: inv.status === "paid" || balance <= 0,
    },
    convenience_fee_preview: feePreview,
    total_charge_preview: round2(balance + feePreview),
    disclosure:
      balance > 0
        ? `Balance: ${usd(balance)} + Convenience Fee (3.5%): ${usd(feePreview)} = Total: ${usd(round2(balance + feePreview))}`
        : "This invoice is paid in full.",
  });
}

// ─── POST /api/public/pay/:token/intent ───────────────────────────────────────

export async function handlePublicPayIntent(_request: Request, env: Env, token: string): Promise<Response> {
  const inv = await loadInvoiceByToken(env, token);
  if (!inv) return err(404, "not_found", "This payment link is invalid or no longer available.");
  if (inv.status === "void") return err(410, "void", "This invoice has been voided.");
  if (!PAYABLE_STATUSES.has(inv.status ?? "")) {
    return err(409, "not_payable", "This invoice is not currently open for payment.");
  }

  const collected = await collectedForInvoice(env, inv.id);
  const totalDue = round2(inv.total_due ?? inv.amount ?? 0);
  const balance = Math.max(0, round2(totalDue - collected));
  if (balance <= 0) {
    return err(409, "already_paid", "This invoice is already paid in full.");
  }

  const cfg = await getStripeConfig(env);
  const fee = computeFee(balance, CONVENIENCE_FEE_RATE);
  const totalCharge = round2(balance + fee);

  const intent = await createPaymentIntent(cfg, {
    amountCents: Math.round(totalCharge * 100),
    description: `${invoiceLabel(inv.invoice_number)} — ${inv.title ?? "Invoice"}`,
    metadata: {
      kind: "invoice",
      invoice_id: inv.id,
      job_id: inv.job_id ?? "",
      client_id: inv.client_id ?? "",
      token,
      base_amount: String(balance),
      convenience_fee: String(fee),
    },
  });
  if (!intent.ok) return err(intent.status, intent.error, intent.details);

  return json({
    ok: true,
    client_secret: intent.client_secret,
    publishable_key: cfg.publishableKey,
    base_amount: balance,
    convenience_fee: fee,
    total_charge: totalCharge,
    disclosure: `Balance: ${usd(balance)} + Convenience Fee (3.5%): ${usd(fee)} = Total: ${usd(totalCharge)}`,
  });
}
