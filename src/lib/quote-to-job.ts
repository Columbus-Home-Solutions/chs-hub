/**
 * Quote-to-job conversion engine — the SINGLE shared, idempotent function both
 * triggers call (Job Management §4.2):
 *   - the manual "Mark as Won" modal  (POST /api/estimate-requests/:id/win)
 *   - the Stripe deposit webhook       (POST /api/webhooks/stripe)
 *
 * There is exactly one conversion path. Calling it twice never creates a second
 * job. It keys on the estimate request's `converted_job_id` + `jobs.conversion_
 * complete` to decide between THREE entry cases:
 *
 *   1. Fully-converted job exists (conversion_complete = 1) → no-op, return it
 *      (idempotent — preserves the prior "{idempotent:true}" webhook behavior).
 *   2. Bare job row exists (converted_job_id set, conversion_complete = 0 — the
 *      Sprint 4/5 stub, e.g. production job #100) → COMPLETE the deferred steps
 *      ON THAT EXISTING ROW. No second job. (The Sprint 6 branch.)
 *   3. No job → create the job row, then run all steps.
 *
 * Full sequence (steps 5–9 are the Sprint 6 additions):
 *   1. Create / locate the job in deposit_paid; allocate job_number.
 *   2. Link the approved estimate; set converted_job_id on the request.
 *   3. Copy client / property / job_type / lead_source from the request.
 *   4. Set billing_model, contract_total, deposit_amount, deposit_paid (read the
 *      deposit the estimate already computed — don't recompute).
 *   5. Auto-generate task groups from estimate PARENT line items (one seed task
 *      each, order preserved via task_group_order).
 *   6. Budget baseline = the linked estimate's sub-item costs. The approved
 *      estimate is frozen and linked via jobs.estimate_id, so the per-line-item
 *      costing baseline is already persisted and job-readable (Sprint 9/10 reads
 *      estimate_line_items + estimate_sub_items through the link). No snapshot
 *      table — a copy would only risk drifting from the source of truth.
 *   7. Billing-schedule SCAFFOLD per billing_model (billing_schedule rows +, for
 *      cost-plus, the first billing_cycles window). No invoices fired — Sprint 9
 *      owns the billing engine.
 *   8. Activate the portal — REUSE the stub's portal_token (never regenerate a
 *      live link); set portal_type from billing_model.
 *   9. conversion_complete = 1.
 *
 * Reversal-aware (decision (c)): the conversion_complete flag + full audit trail
 * (written by the caller) + NO hard deletes / no ON DELETE CASCADE in this path
 * mean Sprint 9 can build a clean soft un-win that flags-and-preserves.
 *
 * The caller owns audit logging and the WC trigger (they hold the user email).
 */

import type { Env } from "../env.js";

export type DepositMethod = "check" | "cash" | "venmo" | "zelle" | "other" | "stripe";

export interface DepositPayment {
  amount: number;
  method: DepositMethod;
  reference?: string | null;
  /** Electronic-only: the 3.5% convenience fee the client paid on top (revenue). */
  convenienceFee?: number | null;
  /** Electronic-only: Stripe's own processing fee (cost). net = amount - stripeFee. */
  stripeFee?: number | null;
  /** Stripe PaymentIntent id, for reconciliation (electronic only). */
  stripePaymentId?: string | null;
}

export type ConversionOutcome =
  | {
      ok: true;
      jobId: string;
      jobNumber: number;
      /** Null when no new payment was recorded (idempotent no-op / bare-row completion). */
      paymentId: string | null;
      total: number;
      portalToken: string | null;
      /** True when a fully-converted job already existed and nothing changed (case 1). */
      idempotent: boolean;
      /** True when the full conversion sequence ran this call (cases 2 and 3). */
      completed: boolean;
    }
  | { ok: false; status: number; error: string; details: string };

interface RequestJoin {
  id: string;
  status: string;
  client_id: string;
  property_address: string;
  property_city: string;
  property_state: string | null;
  property_zip: string;
  lat: number | null;
  lon: number | null;
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
  e_deposit: number | null;
}

interface JobRow {
  id: string;
  job_number: number;
  status: string;
  conversion_complete: number | null;
  portal_token: string | null;
  contract_total: number | null;
  billing_model: string | null;
  estimate_id: string | null;
}

// An estimate counts as "reached the client" once it has been sent. sent_at is
// the source of truth; status is a belt-and-suspenders fallback for post-send.
const POST_SEND_ESTIMATE_STATUSES = new Set(["sent", "viewed", "approved", "revised"]);

export function isEstimateSent(status: string | null, sentAt: string | null): boolean {
  return !!sentAt || POST_SEND_ESTIMATE_STATUSES.has(status ?? "");
}

function portalTypeFor(billingModel: string | null): string {
  return billingModel === "cost_plus" ? "cost_plus" : "standard";
}

export async function convertQuoteToJob(
  env: Env,
  requestId: string,
  payment: DepositPayment,
  createdBy: string | null,
): Promise<ConversionOutcome> {
  const row = await env.DB.prepare(
    `SELECT er.id, er.status, er.client_id, er.property_address, er.property_city,
            er.property_state, er.property_zip, er.lat, er.lon, er.job_type, er.lead_source,
            er.estimate_id, er.converted_job_id,
            e.id AS e_id, e.total AS e_total, e.title AS e_title,
            e.billing_model AS e_billing, e.status AS e_status, e.sent_at AS e_sent_at,
            e.deposit_amount AS e_deposit
     FROM estimate_requests er
     LEFT JOIN estimates e ON e.id = er.estimate_id
     WHERE er.id = ?`,
  )
    .bind(requestId)
    .first<RequestJoin>();

  if (!row) {
    return { ok: false, status: 404, error: "not_found", details: "Estimate request not found." };
  }

  // ── Locate any existing job for this request (the idempotency anchor). ──
  let existing: JobRow | null = null;
  if (row.converted_job_id) {
    existing = await env.DB.prepare(
      `SELECT id, job_number, status, conversion_complete, portal_token,
              contract_total, billing_model, estimate_id
       FROM jobs WHERE id = ?`,
    )
      .bind(row.converted_job_id)
      .first<JobRow>();
  }

  // ── Case 1: fully converted → no-op, return it. ───────────────────────
  if (existing && (existing.conversion_complete ?? 0) === 1) {
    return {
      ok: true,
      jobId: existing.id,
      jobNumber: existing.job_number,
      paymentId: null,
      total: round2(existing.contract_total ?? row.e_total ?? 0),
      portalToken: existing.portal_token,
      idempotent: true,
      completed: false,
    };
  }

  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);

  // ── Case 2: bare job exists → complete the deferred steps in place. ────
  if (existing) {
    const billingModel = existing.billing_model ?? row.e_billing;
    const estimateId = existing.estimate_id ?? row.e_id;
    const total = round2(existing.contract_total ?? row.e_total ?? 0);
    const steps = await buildConversionSteps(
      env,
      existing.id,
      estimateId,
      billingModel,
      total,
      existing.portal_token,
      today,
      nowIso,
    );
    // Idempotent request/estimate state + the completion flag, plus the steps.
    const stmts = [
      ...steps,
      env.DB.prepare(
        "UPDATE estimate_requests SET status = 'won', converted_job_id = ?, updated_at = ? WHERE id = ?",
      ).bind(existing.id, nowIso, requestId),
      estimateId
        ? env.DB.prepare(
            `UPDATE estimates SET status = 'approved',
                signed_date = COALESCE(signed_date, ?), approved_date = COALESCE(approved_date, ?),
                updated_at = ? WHERE id = ?`,
          ).bind(today, today, nowIso, estimateId)
        : null,
      env.DB.prepare(
        "UPDATE jobs SET conversion_complete = 1, updated_at = ? WHERE id = ?",
      ).bind(nowIso, existing.id),
    ].filter((s): s is D1PreparedStatement => s !== null);

    await env.DB.batch(stmts);

    return {
      ok: true,
      jobId: existing.id,
      jobNumber: existing.job_number,
      paymentId: null, // the stub already recorded the deposit payment
      total,
      portalToken: existing.portal_token,
      idempotent: false,
      completed: true,
    };
  }

  // ── Case 3: no job → validate, create, run all steps. ─────────────────
  if (row.status === "won") {
    // Defensive: request says won but no job row found — data inconsistency.
    return {
      ok: false,
      status: 409,
      error: "won_without_job",
      details: "Request is marked won but no job row exists; manual review needed.",
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

  const total = round2(row.e_total ?? 0);
  const deposit = round2(payment.amount);
  // Fees are tracked separately: the convenience fee is CHS revenue, the Stripe
  // fee is a cost. net_amount = amount - stripe_fee. The contract-applicable
  // deposit is `amount` (fee-excluded); the fee never inflates contract value.
  const convenienceFee = payment.convenienceFee != null ? round2(payment.convenienceFee) : null;
  const stripeFee = payment.stripeFee != null ? round2(payment.stripeFee) : null;
  const netAmount = round2(deposit - (stripeFee ?? 0));

  const jobId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const portalToken = crypto.randomUUID().replace(/-/g, "");
  const billingModel = row.e_billing;

  const title = row.e_title || `${titleCase(row.job_type)} — ${row.property_address}`;

  // job_number hardening (Sprint 6 deviation 2): allocate INSIDE the INSERT via
  // COALESCE(MAX(job_number),0)+1, backed by the UNIQUE index idx_jobs_job_number.
  // No more read-then-write race (the old `MAX()+1` read outside the batch) and a
  // concurrent racer that picks the same number now fails the UNIQUE constraint
  // cleanly instead of silently colliding. The number is read back after the batch.
  //
  // jobs.synced_at is NOT NULL (legacy Jobber-sync column); native rows set it to
  // creation time so the column stays satisfied without pretending it was synced.
  const createJob = env.DB.prepare(
    `INSERT INTO jobs (
       id, job_number, title, status, client_id, source, total,
       created_at, synced_at, updated_at, created_by,
       billing_model, property_address, property_city, property_state, property_zip,
       lat, lon,
       job_type, lead_source, estimate_id, contract_total, deposit_amount, deposit_paid,
       portal_token, portal_type, conversion_complete
     )
     SELECT ?, COALESCE((SELECT MAX(job_number) FROM jobs), 0) + 1, ?, 'deposit_paid', ?, 'estimate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0`,
  ).bind(
    jobId,
    title,
    row.client_id,
    total,
    nowIso,
    nowIso,
    nowIso,
    createdBy,
    billingModel,
    row.property_address,
    row.property_city,
    row.property_state,
    row.property_zip,
    row.lat,
    row.lon,
    row.job_type,
    row.lead_source,
    row.e_id,
    total,
    deposit,
    portalToken,
    portalTypeFor(billingModel),
  );

  const createPayment = env.DB.prepare(
    `INSERT INTO payments (
       id, job_id, estimate_id, client_id, amount, convenience_fee, stripe_fee,
       net_amount, payment_method, stripe_payment_id,
       received_date, collected_at, notes, synced_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    paymentId,
    jobId,
    row.e_id,
    row.client_id,
    deposit,
    convenienceFee,
    stripeFee,
    netAmount,
    payment.method,
    payment.stripePaymentId ?? null,
    today,
    nowIso,
    payment.reference ?? null,
    nowIso,
    nowIso,
  );

  const linkRequest = env.DB.prepare(
    "UPDATE estimate_requests SET status = 'won', converted_job_id = ?, updated_at = ? WHERE id = ?",
  ).bind(jobId, nowIso, requestId);

  const approveEstimate = env.DB.prepare(
    `UPDATE estimates
       SET status = 'approved',
           signed_date = COALESCE(signed_date, ?),
           approved_date = ?,
           updated_at = ?
     WHERE id = ?`,
  ).bind(today, today, nowIso, row.e_id);

  const steps = await buildConversionSteps(
    env,
    jobId,
    row.e_id,
    billingModel,
    total,
    portalToken,
    today,
    nowIso,
  );

  // One atomic batch: a partial failure leaves no half-converted job. The
  // conversion_complete flag flips to 1 last, inside the same transaction.
  await env.DB.batch([
    createJob,
    createPayment,
    linkRequest,
    approveEstimate,
    ...steps,
    env.DB.prepare("UPDATE jobs SET conversion_complete = 1 WHERE id = ?").bind(jobId),
  ]);

  // Read back the in-transaction-allocated job_number.
  const jobNumberRow = await env.DB.prepare("SELECT job_number FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ job_number: number }>();
  const jobNumber = jobNumberRow?.job_number ?? 0;

  return {
    ok: true,
    jobId,
    jobNumber,
    paymentId,
    total,
    portalToken,
    idempotent: false,
    completed: true,
  };
}

// ─── reverse-conversion / un-win (Sprint 6 deviation 6) ───────────────────────

export type ReversalOutcome =
  | { ok: true; jobId: string; jobNumber: number | null; voidedInvoices: number; alreadyReversed: boolean }
  | { ok: false; status: number; error: string; details: string };

/**
 * Reverse a job conversion (bounced check / NSF / chargeback / refund). The
 * INVERSE of convertQuoteToJob() and its mirror in audit discipline: it
 * FLAGS-AND-PRESERVES, it never deletes. The job row is KEPT and flagged
 * (conversion_reversed=1 + reason + reversed_at); every non-void invoice on the
 * job is voided (preserved for audit); payments, tasks, the estimate, and the
 * job itself are untouched. A full audit_log row records the reversal.
 *
 * Trigger paths (both land here): a manual O-only action, and the Stripe
 * charge.refunded / charge.dispute.created webhook branch.
 */
export async function reverseJobConversion(
  env: Env,
  jobId: string,
  reason: string,
  reversedBy: string | null,
): Promise<ReversalOutcome> {
  const job = await env.DB.prepare(
    "SELECT id, job_number, conversion_reversed FROM jobs WHERE id = ? AND source = 'estimate'",
  )
    .bind(jobId)
    .first<{ id: string; job_number: number | null; conversion_reversed: number | null }>();
  if (!job) {
    return { ok: false, status: 404, error: "not_found", details: "Job not found." };
  }
  if ((job.conversion_reversed ?? 0) === 1) {
    return { ok: true, jobId, jobNumber: job.job_number, voidedInvoices: 0, alreadyReversed: true };
  }

  const nowIso = new Date().toISOString();
  const openInvoices = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM invoices WHERE job_id = ? AND status != 'void'",
  )
    .bind(jobId)
    .first<{ n: number }>();
  const voidedInvoices = openInvoices?.n ?? 0;

  // One atomic batch. NO deletes anywhere: the job is flagged, invoices are
  // voided (rows preserved), payments are never touched.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE jobs SET conversion_reversed = 1, reversal_reason = ?, reversed_at = ?, updated_at = ? WHERE id = ?",
    ).bind(reason, nowIso, nowIso, jobId),
    env.DB.prepare("UPDATE invoices SET status = 'void' WHERE job_id = ? AND status != 'void'").bind(jobId),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'job_conversion_reversed', 'job', ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      reversedBy ?? "system@reverse-conversion",
      jobId,
      JSON.stringify({ reason, voided_invoices: voidedInvoices, preserved: true }),
      nowIso,
    ),
  ]);

  return { ok: true, jobId, jobNumber: job.job_number, voidedInvoices, alreadyReversed: false };
}

/**
 * Build the prepared statements for steps 5–8 (task groups, billing scaffold,
 * portal activation). Reads are done here; the returned statements are run by
 * the caller inside a single batch/transaction. Re-runnable: skips task groups
 * and billing rows that already exist so a re-fire never duplicates children.
 */
async function buildConversionSteps(
  env: Env,
  jobId: string,
  estimateId: string | null,
  billingModel: string | null,
  total: number,
  existingPortalToken: string | null,
  today: string,
  nowIso: string,
): Promise<D1PreparedStatement[]> {
  const stmts: D1PreparedStatement[] = [];

  // Parent line items → task groups (order preserved). Sub-items never become
  // tasks; they are the budget baseline only (read via the estimate link).
  const lineItems = estimateId
    ? (
        await env.DB.prepare(
          "SELECT id, product_service, description, quantity, unit_price FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC",
        )
          .bind(estimateId)
          .all<{
            id: string;
            product_service: string | null;
            description: string | null;
            quantity: number | null;
            unit_price: number | null;
          }>()
      ).results ?? []
    : [];

  // Step 5 — only if no tasks exist yet (idempotent completion).
  const taskCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE job_id = ?",
  )
    .bind(jobId)
    .first<{ n: number }>();
  if ((taskCount?.n ?? 0) === 0 && lineItems.length > 0) {
    lineItems.forEach((li, i) => {
      const group = (li.product_service || `Phase ${i + 1}`).trim();
      stmts.push(
        env.DB.prepare(
          `INSERT INTO tasks (id, job_id, task_group, task_group_order, title, status, sort_order, is_punch_list, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, ?)`,
        ).bind(crypto.randomUUID(), jobId, group, i, `Start ${group}`, nowIso),
      );
    });
  }

  // Step 7 — billing-schedule scaffold (only if none exists yet).
  const billingCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM billing_schedule WHERE job_id = ?",
  )
    .bind(jobId)
    .first<{ n: number }>();
  if ((billingCount?.n ?? 0) === 0) {
    if (billingModel === "trade_by_trade") {
      // Invoice triggers linked to task-group completion (linkage only; no fire).
      lineItems.forEach((li, i) => {
        const group = (li.product_service || `Phase ${i + 1}`).trim();
        const amount = round2((li.quantity ?? 0) * (li.unit_price ?? 0));
        stmts.push(
          env.DB.prepare(
            `INSERT INTO billing_schedule (id, job_id, billing_model, sequence, label, trigger_type, trigger_ref, amount, status, created_at)
             VALUES (?, ?, 'trade_by_trade', ?, ?, 'trade_completion', ?, ?, 'draft', ?)`,
          ).bind(crypto.randomUUID(), jobId, i, group, group, amount, nowIso),
        );
      });
    } else if (billingModel === "cost_plus") {
      // First bi-weekly cycle WINDOW (do not generate the invoice).
      const periodEnd = addDays(today, 13); // 14-day inclusive window
      stmts.push(
        env.DB.prepare(
          `INSERT INTO billing_cycles (id, job_id, cycle_number, period_start, period_end, is_final_cycle, status, created_at)
           VALUES (?, ?, 1, ?, ?, 0, 'planning', ?)`,
        ).bind(crypto.randomUUID(), jobId, today, periodEnd, nowIso),
      );
      stmts.push(
        env.DB.prepare(
          `INSERT INTO billing_schedule (id, job_id, billing_model, sequence, label, trigger_type, trigger_ref, period_start, period_end, status, created_at)
           VALUES (?, ?, 'cost_plus', 1, 'Cycle 1 (bi-weekly)', 'cost_plus_cycle', '1', ?, ?, 'draft', ?)`,
        ).bind(crypto.randomUUID(), jobId, today, periodEnd, nowIso),
      );
    } else {
      // fixed_price (and any unset) → milestone draws. Prefer the estimate's
      // payment schedule; fall back to the default 33/33/34 (spec §3.1).
      const schedule = estimateId
        ? (
            await env.DB.prepare(
              "SELECT description, percentage, fixed_amount, amount, is_deposit FROM payment_schedules WHERE estimate_id = ? ORDER BY sort_order ASC",
            )
              .bind(estimateId)
              .all<{
                description: string | null;
                percentage: number | null;
                fixed_amount: number | null;
                amount: number | null;
                is_deposit: number | null;
              }>()
          ).results ?? []
        : [];

      const draws =
        schedule.length > 0
          ? schedule.map((s, i) => ({
              label: s.description || `Draw ${i + 1}`,
              percentage: s.percentage,
              amount:
                s.fixed_amount != null
                  ? round2(s.fixed_amount)
                  : s.percentage != null
                    ? round2((s.percentage / 100) * total)
                    : round2(s.amount ?? 0),
              isDeposit: (s.is_deposit ?? 0) === 1,
            }))
          : defaultMilestones(total);

      draws.forEach((d, i) => {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO billing_schedule (id, job_id, billing_model, sequence, label, trigger_type, trigger_ref, percentage, amount, status, created_at)
             VALUES (?, ?, 'fixed_price', ?, ?, 'milestone', ?, ?, ?, ?, ?)`,
          ).bind(
            crypto.randomUUID(),
            jobId,
            i,
            d.label,
            String(i + 1),
            d.percentage,
            d.amount,
            d.isDeposit ? "paid" : "draft", // deposit draw is already collected
            nowIso,
          ),
        );
      });
    }
  }

  // Step 8 — portal activation: REUSE the stub's token; set type from model.
  if (existingPortalToken) {
    stmts.push(
      env.DB.prepare("UPDATE jobs SET portal_type = ? WHERE id = ?").bind(
        portalTypeFor(billingModel),
        jobId,
      ),
    );
  } else {
    // No token on the row (should not happen for a stub) — mint one now rather
    // than leave the portal inactive. Never overwrites an existing live token.
    stmts.push(
      env.DB.prepare(
        "UPDATE jobs SET portal_token = COALESCE(portal_token, ?), portal_type = ? WHERE id = ?",
      ).bind(crypto.randomUUID().replace(/-/g, ""), portalTypeFor(billingModel), jobId),
    );
  }

  return stmts;
}

function defaultMilestones(total: number): {
  label: string;
  percentage: number | null;
  amount: number;
  isDeposit: boolean;
}[] {
  const draw = round2(total * 0.33);
  return [
    { label: "Draw 1 — Materials Deposit", percentage: 33, amount: draw, isDeposit: true },
    { label: "Draw 2 — 50% Completion", percentage: 33, amount: draw, isDeposit: false },
    {
      label: "Draw 3 — Completion",
      percentage: 34,
      amount: round2(total - draw * 2),
      isDeposit: false,
    },
  ];
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
