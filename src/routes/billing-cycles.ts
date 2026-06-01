/**
 * Cost-Plus Billing Cycles API — Sprint 11 (CHS-API-Route-Map "Cost-Plus
 * Billing Cycles"). All routes are O/PM.
 *
 *   GET  /api/jobs/:id/billing-cycles            list (chronological)
 *   GET  /api/billing-cycles/:id                 detail (+ live/final actuals + report)
 *   POST /api/jobs/:id/billing-cycles            create mini-budget
 *   PUT  /api/billing-cycles/:id                 edit projections (planning/active)
 *   POST /api/billing-cycles/:id/generate-invoice  upfront invoice (wraps Sprint 9)
 *   POST /api/billing-cycles/:id/reconcile         actual vs. projected → signed delta
 *   POST /api/billing-cycles/:id/bill-final         final cycle remaining-50% (Open Q3)
 *
 * The money logic lives in src/lib/cost-plus.ts. Actuals come from the Sprint 10
 * helper computeJobActuals (via periodActuals) — never re-derived. Cycle invoices
 * are ORDINARY invoices created/sent through the unchanged Sprint 9 path
 * (handleInvoiceCreate / handleInvoiceSend) and paid through the unchanged public
 * pay page + Stripe webhook (which branches on metadata.invoice_id, not type).
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import type { UserRole } from "../middleware/auth.js";
import {
  buildReconciliationReport,
  computeBreakdown,
  finalRemainingInvoiceMath,
  periodActuals,
  reconcile,
  resolveFeeRates,
  round2,
  unattributedActuals,
  upfrontInvoiceMath,
  type CycleForReport,
} from "../lib/cost-plus.js";
import { handleInvoiceCreate, handleInvoiceSend } from "./invoices.js";
import { addDays } from "../lib/invoicing.js";

const WRITE_ROLES: UserRole[] = ["owner", "project_manager"];
const COST_PLUS = "cost_plus";

/** Cycle invoices are due within 24 hours of receipt (contract §3). */
const DUE_TERM_DAYS = 1;

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
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─── cycle row shape ──────────────────────────────────────────────────────────

interface CycleRow extends CycleForReport {
  job_id: string;
  status: string;
  invoice_id: string | null;
  reconciliation_invoice_id: string | null;
  reconciliation_date: string | null;
  notes: string | null;
  created_at: string;
}

const CYCLE_COLUMNS = `id, job_id, cycle_number, period_start, period_end, is_final_cycle, status,
  projected_materials, projected_labor, projected_subs, projected_subtotal,
  pm_fee_rate, contractor_fee_rate, projected_pm_fee, projected_contractor_fee, projected_total,
  actual_materials, actual_labor, actual_subs, actual_subtotal, actual_pm_fee, actual_contractor_fee,
  actual_total, delta, credit_from_prior, credit_to_next, invoice_id, reconciliation_invoice_id,
  reconciliation_date, notes, created_at`;

async function loadCycle(env: Env, id: string): Promise<CycleRow | null> {
  return env.DB.prepare(`SELECT ${CYCLE_COLUMNS} FROM billing_cycles WHERE id = ?`)
    .bind(id)
    .first<CycleRow>();
}

interface JobCtx {
  id: string;
  client_id: string | null;
  billing_model: string | null;
  conversion_reversed: number | null;
}
async function loadJob(env: Env, jobId: string): Promise<JobCtx | null> {
  return env.DB.prepare(
    "SELECT id, client_id, billing_model, conversion_reversed FROM jobs WHERE id = ?",
  )
    .bind(jobId)
    .first<JobCtx>();
}

async function logAudit(
  env: Env,
  userEmail: string,
  action: string,
  cycleId: string,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, 'billing_cycle', ?, ?, datetime('now'))",
  )
    .bind(crypto.randomUUID(), userEmail, action, cycleId, JSON.stringify(details))
    .run();
}

// ─── GET /api/jobs/:id/billing-cycles ──────────────────────────────────────────

export async function handleCycleList(env: Env, jobId: string): Promise<Response> {
  const job = await loadJob(env, jobId);
  if (!job) return err(404, "not_found", "Job not found.");
  // Cost-plus only: a clear (non-error) empty signal for other billing models so
  // the Financial tab can simply hide the Cycle Manager.
  if (job.billing_model !== COST_PLUS) {
    return json({ job_id: jobId, billing_model: job.billing_model, is_cost_plus: false, cycles: [] });
  }

  const rows = (
    await env.DB.prepare(
      `SELECT ${CYCLE_COLUMNS} FROM billing_cycles WHERE job_id = ? ORDER BY cycle_number ASC`,
    )
      .bind(jobId)
      .all<CycleRow>()
  ).results ?? [];

  // Live actuals for the active (in-flight) cycle so the tracker is real-time.
  const cycles = await Promise.all(
    rows.map(async (c) => {
      let live = null as { materials: number; labor: number; subs: number; subtotal: number; total: number } | null;
      if (c.status === "active") {
        const costs = await periodActuals(env, jobId, c.period_start, c.period_end);
        const b = computeBreakdown(costs, {
          pm_fee_rate: c.pm_fee_rate,
          contractor_fee_rate: c.contractor_fee_rate,
        });
        live = { materials: b.materials, labor: b.labor, subs: b.subs, subtotal: b.subtotal, total: b.total };
      }
      return { ...c, live_actuals: live };
    }),
  );

  const unbilled = await unattributedActuals(
    env,
    jobId,
    rows.map((r) => ({ period_start: r.period_start, period_end: r.period_end })),
  );

  return json({
    job_id: jobId,
    billing_model: job.billing_model,
    is_cost_plus: true,
    unattributed_actuals: unbilled, // Open Q2: gap/unbilled costs surfaced, never dropped
    cycles,
  });
}

// ─── GET /api/billing-cycles/:id ───────────────────────────────────────────────

export async function handleCycleGet(env: Env, id: string): Promise<Response> {
  const cycle = await loadCycle(env, id);
  if (!cycle) return err(404, "not_found", "Billing cycle not found.");

  // For an active cycle, attach live actuals (projected vs. live). For a closed
  // cycle the stored actuals are final; we also build the reconciliation report.
  let live = null as Awaited<ReturnType<typeof periodActuals>> | null;
  let liveBreakdown = null as ReturnType<typeof computeBreakdown> | null;
  if (cycle.status === "active") {
    live = await periodActuals(env, cycle.job_id, cycle.period_start, cycle.period_end);
    liveBreakdown = computeBreakdown(live, {
      pm_fee_rate: cycle.pm_fee_rate,
      contractor_fee_rate: cycle.contractor_fee_rate,
    });
  }

  const report =
    cycle.status === "closed" || cycle.reconciliation_date
      ? await buildReconciliationReport(env, cycle)
      : null;

  const invoices = (
    await env.DB.prepare(
      `SELECT id, invoice_number, invoice_type, title, amount, credits_applied, total_due, status,
              due_date, sent_date, paid_date, paid_amount, payment_token
         FROM invoices WHERE cost_plus_cycle_id = ? ORDER BY created_at ASC`,
    )
      .bind(id)
      .all<Record<string, unknown>>()
  ).results ?? [];

  return json({ cycle, live_actuals: live, live_breakdown: liveBreakdown, report, invoices });
}

// ─── POST /api/jobs/:id/billing-cycles (create mini-budget) ────────────────────

export async function handleCycleCreate(request: Request, env: Env, jobId: string): Promise<Response> {
  const guarded = await guard(request, env, WRITE_ROLES);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const job = await loadJob(env, jobId);
  if (!job) return err(404, "not_found", "Job not found.");
  // Rule #1: cost-plus only.
  if (job.billing_model !== COST_PLUS) {
    return err(422, "not_cost_plus", "Billing cycles apply only to cost-plus jobs.");
  }
  if ((job.conversion_reversed ?? 0) === 1) {
    return err(409, "job_reversed", "This job's conversion was reversed; new cycles are blocked.");
  }

  const body = (await readJson(request)) ?? {};

  // Rule #2 (spec #3): no overlap — the prior cycle must be closed before a new
  // one is created. Also derive the auto-incrementing cycle_number in the handler
  // (NOT a UNIQUE constraint — the Sprint 9/10 lesson).
  const prior = await env.DB.prepare(
    `SELECT ${CYCLE_COLUMNS} FROM billing_cycles WHERE job_id = ? ORDER BY cycle_number DESC LIMIT 1`,
  )
    .bind(jobId)
    .first<CycleRow>();
  if (prior && prior.status !== "closed") {
    return err(
      409,
      "prior_cycle_open",
      `Cycle ${prior.cycle_number} is still ${prior.status}. Reconcile it before starting a new cycle (cycles cannot overlap).`,
    );
  }
  if (prior && (prior.is_final_cycle ?? 0) === 1) {
    return err(409, "final_cycle_closed", "The final cycle is closed; no further cycles can be created.");
  }

  const cycleNumber = (prior?.cycle_number ?? 0) + 1;
  // Prior closed cycle's signed credit_to_next pre-fills credit_from_prior.
  const creditFromPrior = round2(prior?.credit_to_next ?? 0);

  // Default the period to the next two weeks (anchored after the prior period).
  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = prior ? addDays(prior.period_end, 1) : today;
  const periodStart = (body.period_start as string) || defaultStart;
  const periodEnd = (body.period_end as string) || addDays(periodStart, 13); // 14-day inclusive window
  const isFinal = body.is_final_cycle === true || body.is_final_cycle === 1 ? 1 : 0;

  const rates = await resolveFeeRates(env, {
    pm_fee_rate: num(body.pm_fee_rate) ?? undefined,
    contractor_fee_rate: num(body.contractor_fee_rate) ?? undefined,
  });
  const breakdown = computeBreakdown(
    {
      materials: num(body.projected_materials) ?? 0,
      labor: num(body.projected_labor) ?? 0,
      subs: num(body.projected_subs) ?? 0,
    },
    rates,
  );

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO billing_cycles (
       id, job_id, cycle_number, period_start, period_end, is_final_cycle, status,
       projected_materials, projected_labor, projected_subs, projected_subtotal,
       pm_fee_rate, contractor_fee_rate, projected_pm_fee, projected_contractor_fee, projected_total,
       credit_from_prior, credit_to_next, notes, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))`,
  )
    .bind(
      id,
      jobId,
      cycleNumber,
      periodStart,
      periodEnd,
      isFinal,
      breakdown.materials,
      breakdown.labor,
      breakdown.subs,
      breakdown.subtotal,
      rates.pm_fee_rate,
      rates.contractor_fee_rate,
      breakdown.pm_fee,
      breakdown.contractor_fee,
      breakdown.total,
      creditFromPrior,
      (body.notes as string) ?? null,
    )
    .run();

  await logAudit(env, user.email, "cycle_created", id, {
    cycle_number: cycleNumber,
    projected_total: breakdown.total,
    credit_from_prior: creditFromPrior,
    is_final_cycle: isFinal,
  });

  const cycle = await loadCycle(env, id);
  return json({ cycle }, { status: 201 });
}

// ─── PUT /api/billing-cycles/:id (edit projections) ────────────────────────────

export async function handleCycleUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, WRITE_ROLES);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const cycle = await loadCycle(env, id);
  if (!cycle) return err(404, "not_found", "Billing cycle not found.");
  if (cycle.status === "closed") {
    return err(409, "cycle_closed", "A reconciled (closed) cycle cannot be edited.");
  }

  const body = (await readJson(request)) ?? {};

  // Re-snapshot fee rates ONLY if explicitly changed; otherwise keep the rates
  // the cycle was created under (rule #4).
  const rates = await resolveFeeRates(env, {
    pm_fee_rate: "pm_fee_rate" in body ? num(body.pm_fee_rate) ?? cycle.pm_fee_rate : cycle.pm_fee_rate,
    contractor_fee_rate:
      "contractor_fee_rate" in body
        ? num(body.contractor_fee_rate) ?? cycle.contractor_fee_rate
        : cycle.contractor_fee_rate,
  });

  const breakdown = computeBreakdown(
    {
      materials: "projected_materials" in body ? num(body.projected_materials) ?? 0 : cycle.projected_materials ?? 0,
      labor: "projected_labor" in body ? num(body.projected_labor) ?? 0 : cycle.projected_labor ?? 0,
      subs: "projected_subs" in body ? num(body.projected_subs) ?? 0 : cycle.projected_subs ?? 0,
    },
    rates,
  );

  const periodStart = "period_start" in body ? (body.period_start as string) : cycle.period_start;
  const periodEnd = "period_end" in body ? (body.period_end as string) : cycle.period_end;
  const isFinal =
    "is_final_cycle" in body
      ? body.is_final_cycle === true || body.is_final_cycle === 1
        ? 1
        : 0
      : cycle.is_final_cycle ?? 0;

  await env.DB.prepare(
    `UPDATE billing_cycles SET
       period_start = ?, period_end = ?, is_final_cycle = ?,
       projected_materials = ?, projected_labor = ?, projected_subs = ?, projected_subtotal = ?,
       pm_fee_rate = ?, contractor_fee_rate = ?, projected_pm_fee = ?, projected_contractor_fee = ?, projected_total = ?,
       notes = COALESCE(?, notes)
     WHERE id = ?`,
  )
    .bind(
      periodStart,
      periodEnd,
      isFinal,
      breakdown.materials,
      breakdown.labor,
      breakdown.subs,
      breakdown.subtotal,
      rates.pm_fee_rate,
      rates.contractor_fee_rate,
      breakdown.pm_fee,
      breakdown.contractor_fee,
      breakdown.total,
      "notes" in body ? (body.notes as string) ?? null : null,
      id,
    )
    .run();

  await logAudit(env, user.email, "cycle_updated", id, { projected_total: breakdown.total });
  return handleCycleGet(env, id);
}

// ─── invoice-path wrapper (reuses Sprint 9 create + send; no fork) ─────────────

interface CreatedInvoice {
  id: string;
  invoice_number: number | null;
  total_due: number | null;
  status: string | null;
}

/**
 * Create + send a cost-plus cycle invoice by calling the EXACT Sprint 9 handlers
 * with synthetic requests that carry the caller's Cf-Access identity (so guard()
 * + the in-transaction invoice-number allocation + the email-required-to-send
 * rule all apply unchanged). Returns the created invoice and whether the send
 * succeeded (a missing client email is non-fatal — the draft + cycle linkage
 * still stand; the user can add an email and send from the invoice list).
 */
async function createAndSendCycleInvoice(
  request: Request,
  env: Env,
  payload: Record<string, unknown>,
): Promise<{ invoice: CreatedInvoice; sent: boolean; sendError?: string } | Response> {
  const createReq = new Request("https://internal/api/invoices", {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(payload),
  });
  const createRes = await handleInvoiceCreate(createReq, env);
  if (createRes.status !== 201) return createRes; // propagate guard/validation errors
  const created = (await createRes.json()) as { invoice: CreatedInvoice };
  const invoiceId = created.invoice.id;

  const sendReq = new Request(`https://internal/api/invoices/${invoiceId}/send`, {
    method: "POST",
    headers: request.headers,
    body: "{}",
  });
  const sendRes = await handleInvoiceSend(sendReq, env, invoiceId);
  if (!sendRes.ok) {
    const e = (await sendRes.json().catch(() => ({}))) as { details?: string; error?: string };
    return { invoice: created.invoice, sent: false, sendError: e.details ?? e.error };
  }
  const sent = (await sendRes.json()) as { invoice: CreatedInvoice };
  return { invoice: sent.invoice, sent: true };
}

function cycleTitle(cycle: CycleRow, suffix = ""): string {
  const fmt = (d: string) =>
    new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return `Cycle ${cycle.cycle_number} — ${fmt(cycle.period_start)}–${fmt(cycle.period_end)}${suffix}`;
}

// ─── POST /api/billing-cycles/:id/generate-invoice ─────────────────────────────

export async function handleCycleGenerateInvoice(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, WRITE_ROLES);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const cycle = await loadCycle(env, id);
  if (!cycle) return err(404, "not_found", "Billing cycle not found.");
  if (cycle.status === "closed") {
    return err(409, "cycle_closed", "This cycle is already reconciled.");
  }
  // Idempotent: never create a second upfront invoice for the same cycle.
  if (cycle.invoice_id) {
    return json({ cycle, invoice_id: cycle.invoice_id, already_generated: true });
  }

  const isFinal = (cycle.is_final_cycle ?? 0) === 1;
  const math = upfrontInvoiceMath(cycle.projected_total ?? 0, cycle.credit_from_prior ?? 0, isFinal);
  if (math.amount <= 0) {
    return err(422, "nothing_to_bill", "This cycle's projected total is zero — add projections first.");
  }

  // Due within 24 hours of receipt (contract §3): anchor due_date = today + 1 day
  // (the invoice is created and sent now, so issued ≈ now).
  const dueDate = addDays(new Date().toISOString().slice(0, 10), DUE_TERM_DAYS);

  const result = await createAndSendCycleInvoice(request, env, {
    job_id: cycle.job_id,
    invoice_type: "cost_plus_cycle",
    cost_plus_cycle_id: cycle.id,
    title: cycleTitle(cycle, isFinal ? " (50% upfront)" : ""),
    amount: math.amount, // gross base (> 0); credit nets via credits_applied (after-fees ordering)
    credits_applied: math.credits_applied,
    due_date: dueDate,
  });
  if (result instanceof Response) return result;

  await env.DB.prepare("UPDATE billing_cycles SET invoice_id = ?, status = 'active' WHERE id = ?")
    .bind(result.invoice.id, id)
    .run();

  await logAudit(env, user.email, "cycle_invoice_generated", id, {
    invoice_id: result.invoice.id,
    invoice_number: result.invoice.invoice_number,
    amount: math.amount,
    credits_applied: math.credits_applied,
    net: math.net,
    is_final_cycle: isFinal,
    sent: result.sent,
  });

  // SPRINT-7 SEAM: a "cost-plus cycle invoice ready" client notification would
  // be triggered here. The engine stays SIMULATE this sprint; the Sprint 9
  // invoice send already fires triggerInvoiceSent for the payment-link email, so
  // no extra dispatch is wired.

  const updated = await loadCycle(env, id);
  return json({
    cycle: updated,
    invoice_id: result.invoice.id,
    invoice_amount_net: math.net,
    sent: result.sent,
    send_error: result.sent ? undefined : result.sendError,
  });
}

// ─── POST /api/billing-cycles/:id/reconcile ────────────────────────────────────

export async function handleCycleReconcile(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, WRITE_ROLES);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const cycle = await loadCycle(env, id);
  if (!cycle) return err(404, "not_found", "Billing cycle not found.");
  // Guard: only an active cycle (upfront invoice generated) can be reconciled.
  if (cycle.status !== "active") {
    return err(
      409,
      "not_active",
      `Only an active cycle can be reconciled (this one is ${cycle.status}). Generate the upfront invoice first.`,
    );
  }

  // Actuals from the Sprint 10 helper, windowed to the cycle period (rule #5).
  const actualCosts = await periodActuals(env, cycle.job_id, cycle.period_start, cycle.period_end);
  const rates = { pm_fee_rate: cycle.pm_fee_rate, contractor_fee_rate: cycle.contractor_fee_rate };
  const r = reconcile(cycle.projected_total ?? 0, actualCosts, rates);

  await env.DB.prepare(
    `UPDATE billing_cycles SET
       actual_materials = ?, actual_labor = ?, actual_subs = ?, actual_subtotal = ?,
       actual_pm_fee = ?, actual_contractor_fee = ?, actual_total = ?,
       delta = ?, credit_to_next = ?, reconciliation_date = datetime('now'), status = 'closed'
     WHERE id = ?`,
  )
    .bind(
      r.actual.materials,
      r.actual.labor,
      r.actual.subs,
      r.actual.subtotal,
      r.actual.pm_fee,
      r.actual.contractor_fee,
      r.actual.total,
      r.delta,
      r.credit_to_next,
      id,
    )
    .run();

  await logAudit(env, user.email, "cycle_reconciled", id, {
    actual_total: r.actual.total,
    delta: r.delta,
    credit_to_next: r.credit_to_next,
    outcome: r.outcome,
  });

  // SPRINT-7 SEAM: a "reconciliation report ready" client notification would be
  // triggered here. Engine stays SIMULATE; not dispatched this sprint.

  const updated = await loadCycle(env, id);
  const report = updated ? await buildReconciliationReport(env, updated) : null;
  return json({ cycle: updated, report });
}

// ─── POST /api/billing-cycles/:id/bill-final (Open Q3) ─────────────────────────

/**
 * Final cycle, remaining 50%, billed near completion. Requires the final cycle
 * to be reconciled first (so credit_to_next — the final delta — is known). The
 * remaining-50% invoice nets the reconciliation: remaining credit reduces it, a
 * remaining overage adds to it (§5.3 steps 5–6). Stored as
 * reconciliation_invoice_id (the one place that column is ever set — Open Q1).
 * The Sprint 9 →closed gate still blocks job close until THIS invoice is paid.
 */
export async function handleCycleBillFinal(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, WRITE_ROLES);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const cycle = await loadCycle(env, id);
  if (!cycle) return err(404, "not_found", "Billing cycle not found.");
  if ((cycle.is_final_cycle ?? 0) !== 1) {
    return err(422, "not_final_cycle", "bill-final applies only to the final cycle.");
  }
  if (!cycle.invoice_id) {
    return err(409, "no_upfront", "Generate the 50% upfront invoice before billing the final 50%.");
  }
  if (cycle.status !== "closed" || !cycle.reconciliation_date) {
    return err(409, "not_reconciled", "Reconcile the final cycle before billing the remaining 50%.");
  }
  // Idempotent.
  if (cycle.reconciliation_invoice_id) {
    return json({ cycle, invoice_id: cycle.reconciliation_invoice_id, already_generated: true });
  }

  const math = finalRemainingInvoiceMath(cycle.projected_total ?? 0, cycle.credit_to_next ?? 0);
  if (math.amount <= 0) {
    return err(422, "nothing_to_bill", "This cycle has no remaining amount to bill.");
  }

  const dueDate = addDays(new Date().toISOString().slice(0, 10), DUE_TERM_DAYS);
  const result = await createAndSendCycleInvoice(request, env, {
    job_id: cycle.job_id,
    invoice_type: "cost_plus_cycle",
    cost_plus_cycle_id: cycle.id,
    title: cycleTitle(cycle, " (final 50%)"),
    amount: math.amount,
    credits_applied: math.credits_applied,
    due_date: dueDate,
  });
  if (result instanceof Response) return result;

  await env.DB.prepare("UPDATE billing_cycles SET reconciliation_invoice_id = ? WHERE id = ?")
    .bind(result.invoice.id, id)
    .run();

  await logAudit(env, user.email, "cycle_final_billed", id, {
    invoice_id: result.invoice.id,
    amount: math.amount,
    credits_applied: math.credits_applied,
    net: math.net,
    sent: result.sent,
  });

  const updated = await loadCycle(env, id);
  return json({
    cycle: updated,
    invoice_id: result.invoice.id,
    invoice_amount_net: math.net,
    sent: result.sent,
    send_error: result.sent ? undefined : result.sendError,
  });
}
