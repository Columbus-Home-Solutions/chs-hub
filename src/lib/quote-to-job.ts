/**
 * Quote-to-job conversion engine — Module-Spec-Estimating-Quoting §4.10.
 *
 * Shared by the manual "Mark as Won" flow (check/cash/Venmo/Zelle/Other) and,
 * later, the Stripe deposit webhook (Sprint 5+). Both paths run this identical
 * engine — the only difference is where the payment data comes from.
 *
 * On success it:
 *   - creates a native job at "deposit_paid" status (client/property/job type/
 *     lead source/estimate/billing carry over),
 *   - records the deposit payment (method + amount + reference),
 *   - links the request (status → won, converted_job_id set),
 *   - advances the estimate to "approved".
 *
 * The caller owns audit logging and the WC trigger (they hold the user email).
 * Idempotent: refuses if the request is already converted.
 *
 * Deferred to Job Management (Sprint 5+): task-group generation from parent line
 * items, budget baseline from sub-items, and client-portal activation. The job
 * record + portal_token are created here so that handoff is a pure read.
 */

import type { Env } from "../env.js";

export type DepositMethod = "check" | "cash" | "venmo" | "zelle" | "other" | "stripe";

export interface DepositPayment {
  amount: number;
  method: DepositMethod;
  reference?: string | null;
}

export type ConversionOutcome =
  | { ok: true; jobId: string; jobNumber: number; paymentId: string; total: number }
  | { ok: false; status: number; error: string; details: string };

interface RequestJoin {
  id: string;
  status: string;
  client_id: string;
  property_address: string;
  property_city: string;
  property_state: string | null;
  property_zip: string;
  job_type: string;
  lead_source: string;
  estimate_id: string | null;
  converted_job_id: string | null;
  e_id: string | null;
  e_total: number | null;
  e_title: string | null;
  e_billing: string | null;
  e_status: string | null;
  e_sent_at: string | null;
}

// An estimate counts as "reached the client" once it has been sent. sent_at is
// the source of truth; status is a belt-and-suspenders fallback for post-send.
const POST_SEND_ESTIMATE_STATUSES = new Set(["sent", "viewed", "approved", "revised"]);

export function isEstimateSent(status: string | null, sentAt: string | null): boolean {
  return !!sentAt || POST_SEND_ESTIMATE_STATUSES.has(status ?? "");
}

export async function convertQuoteToJob(
  env: Env,
  requestId: string,
  payment: DepositPayment,
  createdBy: string | null,
): Promise<ConversionOutcome> {
  const row = await env.DB.prepare(
    `SELECT er.id, er.status, er.client_id, er.property_address, er.property_city,
            er.property_state, er.property_zip, er.job_type, er.lead_source,
            er.estimate_id, er.converted_job_id,
            e.id AS e_id, e.total AS e_total, e.title AS e_title,
            e.billing_model AS e_billing, e.status AS e_status, e.sent_at AS e_sent_at
     FROM estimate_requests er
     LEFT JOIN estimates e ON e.id = er.estimate_id
     WHERE er.id = ?`,
  )
    .bind(requestId)
    .first<RequestJoin>();

  if (!row) {
    return { ok: false, status: 404, error: "not_found", details: "Estimate request not found." };
  }
  if (row.status === "won" || row.converted_job_id) {
    return {
      ok: false,
      status: 400,
      error: "already_won",
      details: "This request has already been converted to a job.",
    };
  }
  // Gate (§4.10): a quote must have reached the client before it can be won.
  if (!row.e_id || !isEstimateSent(row.e_status, row.e_sent_at)) {
    return {
      ok: false,
      status: 400,
      error: "estimate_not_sent",
      details: "Estimate must be sent to the client before marking as won.",
    };
  }
  if (!Number.isFinite(payment.amount) || payment.amount <= 0) {
    return {
      ok: false,
      status: 400,
      error: "invalid_payment",
      details: "A deposit amount greater than zero is required.",
    };
  }

  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const total = round2(row.e_total ?? 0);
  const deposit = round2(payment.amount);

  const jobId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const portalToken = crypto.randomUUID().replace(/-/g, "");

  const jobNumberRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(job_number), 0) + 1 AS n FROM jobs",
  ).first<{ n: number }>();
  const jobNumber = jobNumberRow?.n ?? 1;

  const title = row.e_title || `${titleCase(row.job_type)} — ${row.property_address}`;

  // jobs.synced_at is NOT NULL (legacy Jobber-sync column); native rows set it to
  // creation time so the column stays satisfied without pretending it was synced.
  await env.DB.prepare(
    `INSERT INTO jobs (
       id, job_number, title, status, client_id, source, total,
       created_at, synced_at, updated_at, created_by,
       billing_model, property_address, property_city, property_state, property_zip,
       job_type, lead_source, estimate_id, contract_total, deposit_amount, deposit_paid,
       portal_token, portal_type
     ) VALUES (?, ?, ?, 'deposit_paid', ?, 'estimate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'client')`,
  )
    .bind(
      jobId,
      jobNumber,
      title,
      row.client_id,
      total,
      nowIso,
      nowIso,
      nowIso,
      createdBy,
      row.e_billing,
      row.property_address,
      row.property_city,
      row.property_state,
      row.property_zip,
      row.job_type,
      row.lead_source,
      row.e_id,
      total,
      deposit,
      portalToken,
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO payments (
       id, job_id, client_id, amount, net_amount, payment_method,
       received_date, collected_at, notes, synced_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      paymentId,
      jobId,
      row.client_id,
      deposit,
      deposit,
      payment.method,
      today,
      nowIso,
      payment.reference ?? null,
      nowIso,
      nowIso,
    )
    .run();

  await env.DB.prepare(
    "UPDATE estimate_requests SET status = 'won', converted_job_id = ?, updated_at = ? WHERE id = ?",
  )
    .bind(jobId, nowIso, requestId)
    .run();

  await env.DB.prepare(
    "UPDATE estimates SET status = 'approved', signed_date = ?, updated_at = ? WHERE id = ?",
  )
    .bind(today, nowIso, row.e_id)
    .run();

  return { ok: true, jobId, jobNumber, paymentId, total };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
