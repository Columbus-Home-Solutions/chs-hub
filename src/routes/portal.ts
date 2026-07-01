/**
 * Client Portal — PUBLIC, token-gated API (Sprint 12). The token is the only
 * credential: jobs.portal_token (unguessable, never expires — business rule #3)
 * resolves to exactly ONE job (rule #2). No Cloudflare Access; these routes are
 * the new public surface added to client.homesolutionsar.com (the same host the
 * Sprint 9 pay/quote pages live on). The host-aware guard in src/index.ts allows
 * /api/portal/* + /portal/* here; everything else on that host 404s.
 *
 *   GET  /api/portal/:token                       landing (header + quick stats)
 *   GET  /api/portal/:token/photos                client-visible photo timeline
 *   GET  /api/portal/:token/photos/:id/(image|thumb)  R2 proxy for portal images
 *   GET  /api/portal/:token/invoices              invoices + payments + schedule
 *   POST /api/portal/:token/pay/:invoiceId        Stripe intent (REUSES Sprint 9)
 *   GET  /api/portal/:token/budget                cost-plus Budget & Costs (S11)
 *   GET  /api/portal/:token/messages              portal_message thread
 *   POST /api/portal/:token/messages              client → contractor message
 *   GET  /api/portal/:token/schedule              S13 SEAM (empty state)
 *   GET  /api/portal/:token/change-orders         S13 SEAM (empty state)
 *   POST /api/portal/:token/change-orders/:id/sign  S13 SEAM (501)
 *   GET  /api/portal/:token/documents             read-only contract + docs
 *   GET  /api/portal/:token/completion-package    S15 SEAM (501)
 *
 * MONEY IS NEVER RECOMPUTED HERE. Quick-stats reuse the Sprint 6/9 job summary
 * math; the pay route hands off to handlePublicPayIntent (Sprint 9) which sets
 * metadata.invoice_id so the SINGLE Stripe webhook records the payment unchanged;
 * the Budget tab renders Sprint 11's buildReconciliationReport() / cycle list.
 */

import type { Env } from "../env.js";
import { round2 } from "../lib/invoicing.js";
import { formatPmPhone } from "../lib/pm-fields.js";
import { handlePublicPayIntent } from "./public-pay.js";
import { handleCycleList } from "./billing-cycles.js";
import { buildReconciliationReport, type CycleForReport } from "../lib/cost-plus.js";
import { handlePhotoStream } from "./photos.js";
import { createOwnerInApp } from "../lib/notification-engine.js";
import { applyChangeOrder } from "./change-orders.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}

/** Statuses an invoice can be paid in (mirrors Sprint 9 public-pay). */
const PAYABLE_STATUSES = new Set(["sent", "viewed", "partial", "past_due"]);

interface PortalJob {
  id: string;
  job_number: number | null;
  title: string | null;
  status: string | null;
  client_id: string | null;
  payer_id: string | null;
  billing_model: string | null;
  portal_type: string | null;
  contract_total: number | null;
  deposit_amount: number | null;
  property_address: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
  conversion_reversed: number | null;
  assigned_to: string | null;
}

/** Resolve the one job a portal_token maps to (rule #2). Null → invalid token. */
async function resolveJob(env: Env, token: string): Promise<PortalJob | null> {
  if (!token) return null;
  return env.DB.prepare(
    `SELECT id, job_number, title, status, client_id, payer_id, billing_model, portal_type,
            contract_total, deposit_amount,
            property_address, property_city, property_state, property_zip,
            conversion_reversed, assigned_to
       FROM jobs WHERE portal_token = ?`,
  )
    .bind(token)
    .first<PortalJob>();
}

async function companyName(env: Env): Promise<string> {
  const r = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'company_name'")
    .first<{ value: string | null }>()
    .catch(() => null);
  return (r?.value ?? "").trim() || "Columbus Home Solutions, LLC";
}

async function clientName(env: Env, clientId: string | null): Promise<string> {
  if (!clientId) return "";
  const c = await env.DB.prepare(
    "SELECT name, first_name, last_name FROM clients WHERE id = ?",
  )
    .bind(clientId)
    .first<{ name: string | null; first_name: string | null; last_name: string | null }>();
  return (
    [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim() || (c?.name ?? "").trim() || ""
  );
}

function fullAddress(j: PortalJob): string {
  return [j.property_address, j.property_city, j.property_state, j.property_zip]
    .filter(Boolean)
    .join(", ");
}

async function collectedForInvoice(env: Env, invoiceId: string): Promise<number> {
  const agg = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = ?",
  )
    .bind(invoiceId)
    .first<{ paid: number }>();
  return round2(agg?.paid ?? 0);
}

// ─── GET /api/portal/:token (landing + quick stats) ────────────────────────────

async function handleLanding(env: Env, token: string): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token", "This portal link is invalid or no longer available.");

  const onHold = (job.conversion_reversed ?? 0) === 1;

  // Quick-stats reuse the Job Detail summary-bar logic (Sprint 6/9): total paid =
  // every payment recorded against the job; remaining = contract − paid. Not
  // re-derived from invoice internals.
  const paidRow = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE job_id = ?",
  )
    .bind(job.id)
    .first<{ paid: number }>();
  const totalPaid = round2(paidRow?.paid ?? 0);
  const contractTotal = job.contract_total != null ? round2(job.contract_total) : null;
  const remaining = contractTotal != null ? round2(Math.max(0, contractTotal - totalPaid)) : null;

  // Next payment due: the earliest still-open invoice (not on a reversed job).
  let nextDue: { invoice_id: string; amount: number; due_date: string | null } | null = null;
  if (!onHold) {
    const open = await env.DB.prepare(
      `SELECT id, total_due, amount, due_date FROM invoices
        WHERE job_id = ? AND status IN ('sent','viewed','partial','past_due')
        ORDER BY (due_date IS NULL), due_date ASC, created_at ASC LIMIT 1`,
    )
      .bind(job.id)
      .first<{ id: string; total_due: number | null; amount: number | null; due_date: string | null }>();
    if (open) {
      const collected = await collectedForInvoice(env, open.id);
      const balance = round2(Math.max(0, (open.total_due ?? open.amount ?? 0) - collected));
      if (balance > 0) nextDue = { invoice_id: open.id, amount: balance, due_date: open.due_date };
    }
  }

  // Completion-package tab is visible only once the owner has SENT it (S15).
  const sentPkg = await env.DB.prepare(
    `SELECT 1 AS x FROM documents
      WHERE job_id = ? AND document_category='completion_package'
        AND COALESCE(is_active,1)=1 AND COALESCE(is_signed,0)=1 LIMIT 1`,
  )
    .bind(job.id)
    .first<{ x: number }>();

  let billing_party: {
    company_name: string | null;
    contact_name: string;
    email: string;
    notice: string;
  } | null = null;
  if (job.payer_id) {
    const payer = await env.DB.prepare(
      "SELECT company_name, contact_name, email FROM payers WHERE id = ?",
    )
      .bind(job.payer_id)
      .first<{ company_name: string | null; contact_name: string; email: string }>();
    if (payer) {
      const label = payer.company_name ?? payer.contact_name;
      billing_party = {
        company_name: payer.company_name,
        contact_name: payer.contact_name,
        email: payer.email,
        notice: `Invoices for this project are billed to ${label}. Payment links will be sent to ${payer.email}.`,
      };
    }
  }

  let project_manager: {
    assigned_to: string;
    assigned_to_name: string;
    assigned_to_phone: string | null;
    assigned_to_email: string | null;
  } | null = null;
  if (job.assigned_to) {
    const pmUser = await env.DB.prepare(
      "SELECT first_name, last_name, name, business_phone, email FROM users WHERE id = ? AND is_active = 1",
    )
      .bind(job.assigned_to)
      .first<{
        first_name: string | null;
        last_name: string | null;
        name: string | null;
        business_phone: string | null;
        email: string | null;
      }>();
    if (pmUser) {
      const name =
        [pmUser.first_name, pmUser.last_name].filter(Boolean).join(" ").trim() ||
        (pmUser.name ?? "").trim();
      if (name) {
        project_manager = {
          assigned_to: job.assigned_to,
          assigned_to_name: name,
          assigned_to_phone: formatPmPhone(pmUser.business_phone),
          assigned_to_email: pmUser.email?.trim() || null,
        };
      }
    }
  }

  return json({
    ok: true,
    company_name: await companyName(env),
    portal_type: job.portal_type ?? "standard",
    is_cost_plus: (job.portal_type ?? "") === "cost_plus",
    completion_package_available: !!sentPkg,
    on_hold: onHold,
    billing_party,
    project_manager,
    header: {
      client_name: await clientName(env, job.client_id),
      property_address: fullAddress(job),
      job_title: job.title,
      job_display: job.job_number != null ? `JOB-${String(job.job_number).padStart(3, "0")}` : null,
      status: onHold ? "on_hold" : job.status,
    },
    quick_stats: {
      contract_total: contractTotal,
      total_paid: totalPaid,
      remaining_balance: remaining,
      next_payment: nextDue,
    },
  });
}

// ─── GET /api/portal/:token/photos ─────────────────────────────────────────────
// Open Question 2: photos has no is_client_visible flag, so we default to all
// active, non-receipt photos. Receipts (photo_type='receipt') are internal and
// always excluded. SPRINT-12 SEAM (Open Q2): a future per-photo "show to client"
// toggle would add an is_client_visible column + filter here.

async function handlePhotos(env: Env, token: string): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token", "This portal link is invalid or no longer available.");

  const rows = (
    await env.DB.prepare(
      `SELECT id, caption, category, photo_type, COALESCE(taken_at, created_at) AS shot_at
         FROM photos
        WHERE job_id = ? AND COALESCE(is_active, 1) = 1 AND COALESCE(photo_type, '') != 'receipt'
        ORDER BY COALESCE(taken_at, created_at) DESC`,
    )
      .bind(job.id)
      .all<{ id: string; caption: string | null; category: string | null; photo_type: string | null; shot_at: string | null }>()
  ).results ?? [];

  const photos = rows.map((p) => ({
    id: p.id,
    caption: p.caption,
    category: p.category,
    taken_at: p.shot_at,
    image_url: `/api/portal/${encodeURIComponent(token)}/photos/${p.id}/image`,
    thumb_url: `/api/portal/${encodeURIComponent(token)}/photos/${p.id}/thumb`,
  }));

  return json({ ok: true, total: photos.length, photos });
}

/** Proxy a photo's R2 bytes — the only photo route reachable on the public host. */
async function handlePhotoImage(
  env: Env,
  token: string,
  photoId: string,
  variant: "original" | "thumb",
): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token");
  // Confirm the photo belongs to this job and is client-visible before streaming.
  const owns = await env.DB.prepare(
    `SELECT id FROM photos
       WHERE id = ? AND job_id = ? AND COALESCE(is_active, 1) = 1 AND COALESCE(photo_type,'') != 'receipt'`,
  )
    .bind(photoId, job.id)
    .first<{ id: string }>();
  if (!owns) return err(404, "not_found");
  return handlePhotoStream(env, photoId, variant);
}

// ─── GET /api/portal/:token/invoices ───────────────────────────────────────────

async function handleInvoices(env: Env, token: string): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token", "This portal link is invalid or no longer available.");
  const onHold = (job.conversion_reversed ?? 0) === 1;

  const invoiceRows = (
    await env.DB.prepare(
      `SELECT id, invoice_number, invoice_type, title, description, amount, tax_amount,
              late_fee_amount, credits_applied, total_due, status, due_date, sent_date,
              paid_date, payment_token
         FROM invoices
        WHERE job_id = ? AND status != 'draft'
        ORDER BY COALESCE(sent_date, created_at) DESC, invoice_number DESC`,
    )
      .bind(job.id)
      .all<{
        id: string;
        invoice_number: number | null;
        invoice_type: string | null;
        title: string | null;
        description: string | null;
        amount: number | null;
        tax_amount: number | null;
        late_fee_amount: number | null;
        credits_applied: number | null;
        total_due: number | null;
        status: string | null;
        due_date: string | null;
        sent_date: string | null;
        paid_date: string | null;
        payment_token: string | null;
      }>()
  ).results ?? [];

  const invoices = await Promise.all(
    invoiceRows.map(async (inv) => {
      const collected = await collectedForInvoice(env, inv.id);
      const totalDue = round2(inv.total_due ?? inv.amount ?? 0);
      const balance = round2(Math.max(0, totalDue - collected));
      const payable =
        !onHold && PAYABLE_STATUSES.has(inv.status ?? "") && balance > 0 && !!inv.payment_token;
      return {
        id: inv.id,
        invoice_number: inv.invoice_number,
        invoice_display: `INV-${String(inv.invoice_number ?? 0).padStart(3, "0")}`,
        invoice_type: inv.invoice_type,
        title: inv.title,
        description: inv.description,
        amount: round2(inv.amount ?? 0),
        tax_amount: round2(inv.tax_amount ?? 0),
        late_fee_amount: round2(inv.late_fee_amount ?? 0),
        credits_applied: round2(inv.credits_applied ?? 0),
        total_due: totalDue,
        collected,
        balance,
        status: inv.status,
        due_date: inv.due_date,
        sent_date: inv.sent_date,
        paid_date: inv.paid_date,
        payable,
        // The proven Sprint 9 pay page; the portal also pays in-app via /pay/:invoiceId.
        pay_path: inv.payment_token ? `/pay/${inv.payment_token}` : null,
      };
    }),
  );

  // Payment history (completed payments → receipts) across the job.
  const payments = (
    await env.DB.prepare(
      `SELECT id, invoice_id, amount, convenience_fee, payment_method,
              COALESCE(received_date, collected_at, created_at) AS paid_at
         FROM payments WHERE job_id = ?
        ORDER BY COALESCE(received_date, collected_at, created_at) DESC`,
    )
      .bind(job.id)
      .all<{
        id: string;
        invoice_id: string | null;
        amount: number | null;
        convenience_fee: number | null;
        payment_method: string | null;
        paid_at: string | null;
      }>()
  ).results ?? [];

  // Payment schedule / milestones (status per Sprint 6 billing_schedule).
  const schedule = (
    await env.DB.prepare(
      `SELECT id, label, trigger_type, percentage, amount, period_start, period_end, status
         FROM billing_schedule WHERE job_id = ? ORDER BY sequence ASC`,
    )
      .bind(job.id)
      .all<Record<string, unknown>>()
  ).results ?? [];

  return json({
    ok: true,
    on_hold: onHold,
    invoices,
    payments: payments.map((p) => ({
      id: p.id,
      invoice_id: p.invoice_id,
      amount: round2(p.amount ?? 0),
      convenience_fee: round2(p.convenience_fee ?? 0),
      payment_method: p.payment_method,
      paid_at: p.paid_at,
    })),
    payment_schedule: schedule,
  });
}

// ─── POST /api/portal/:token/pay/:invoiceId ────────────────────────────────────
// REUSES the Sprint 9 public-pay intent path (which sets metadata.invoice_id so
// the single Stripe webhook records the payment) — NEVER forks Stripe. The job
// portal_token identifies the job; we resolve the invoice's own payment_token
// (Sprint 9 deviation 4) and hand off to handlePublicPayIntent unchanged.

async function handlePay(
  request: Request,
  env: Env,
  token: string,
  invoiceId: string,
): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token", "This portal link is invalid or no longer available.");
  if ((job.conversion_reversed ?? 0) === 1) {
    return err(422, "job_on_hold", "This project is on hold — please contact us before paying.");
  }

  const inv = await env.DB.prepare(
    "SELECT id, job_id, status, payment_token FROM invoices WHERE id = ?",
  )
    .bind(invoiceId)
    .first<{ id: string; job_id: string | null; status: string | null; payment_token: string | null }>();
  if (!inv || inv.job_id !== job.id) {
    return err(404, "not_found", "Invoice not found for this project.");
  }
  // Rule #6: a draft / void / already-paid invoice cannot be paid.
  if (inv.status === "draft") return err(422, "not_payable", "This invoice has not been issued yet.");
  if (inv.status === "void") return err(422, "not_payable", "This invoice has been voided.");
  if (inv.status === "paid") return err(422, "already_paid", "This invoice is already paid in full.");
  if (!inv.payment_token) {
    return err(422, "no_payment_token", "This invoice has no payment link configured.");
  }

  // Hand off to the EXACT Sprint 9 intent path (3.5% fee, PaymentIntent, the
  // metadata.invoice_id the shared webhook keys on). No reimplementation.
  return handlePublicPayIntent(request, env, inv.payment_token);
}

// ─── GET /api/portal/:token/budget (cost-plus only) ────────────────────────────
// Consumes Sprint 11's cycle list (handleCycleList) + buildReconciliationReport
// verbatim. Money is rendered, never recomputed (rule #7).

async function handleBudget(env: Env, token: string): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token", "This portal link is invalid or no longer available.");
  if ((job.portal_type ?? "") !== "cost_plus") {
    return err(404, "not_cost_plus", "This project does not have a cost-plus budget view.");
  }

  // Reuse the Cycle Manager's assembled data (cycles + live actuals + unattributed).
  const listRes = await handleCycleList(env, job.id);
  const list = (await listRes.json()) as {
    cycles?: (CycleForReport & {
      status: string;
      invoice_id: string | null;
      reconciliation_date: string | null;
      live_actuals: { materials: number; labor: number; subs: number; subtotal: number; total: number } | null;
    })[];
    unattributed_actuals?: { amount: number; has_unattributed: boolean };
  };
  const cycles = list.cycles ?? [];

  // Per-cycle reconciliation reports for closed/reconciled cycles (Sprint 11).
  const reconciliations = await Promise.all(
    cycles
      .filter((c) => c.status === "closed" || c.reconciliation_date)
      .map((c) => buildReconciliationReport(env, c)),
  );

  // Running project totals (rendered, not recomputed): sum the cycles' stored
  // projected/actual totals; the active cycle contributes its live actuals.
  let projectedToDate = 0;
  let actualToDate = 0;
  for (const c of cycles) {
    projectedToDate = round2(projectedToDate + (c.projected_total ?? 0));
    if (c.status === "closed") actualToDate = round2(actualToDate + (c.actual_total ?? 0));
    else if (c.live_actuals) actualToDate = round2(actualToDate + c.live_actuals.total);
  }

  return json({
    ok: true,
    portal_type: "cost_plus",
    on_hold: (job.conversion_reversed ?? 0) === 1,
    cycles,
    reconciliations,
    unattributed_actuals: list.unattributed_actuals ?? { amount: 0, has_unattributed: false },
    totals: {
      projected_to_date: projectedToDate,
      actual_to_date: actualToDate,
      variance_to_date: round2(projectedToDate - actualToDate),
    },
  });
}

// ─── Messages (rule #5: auto-logs to the communication timeline) ───────────────

const MESSAGE_MAX_LEN = 2000;
const MESSAGE_RATE_WINDOW_SECONDS = 60;
const MESSAGE_RATE_MAX = 5; // ≤5 inbound portal messages per job per minute

async function handleMessagesGet(env: Env, token: string): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token", "This portal link is invalid or no longer available.");

  const rows = (
    await env.DB.prepare(
      `SELECT id, direction, summary, body, created_at
         FROM communications
        WHERE job_id = ? AND channel = 'portal_message'
        ORDER BY created_at ASC`,
    )
      .bind(job.id)
      .all<{ id: string; direction: string; summary: string; body: string | null; created_at: string }>()
  ).results ?? [];

  return json({
    ok: true,
    messages: rows.map((m) => ({
      id: m.id,
      // inbound = client → contractor; outbound = contractor → client.
      from: m.direction === "inbound" ? "client" : "contractor",
      body: m.body ?? m.summary,
      created_at: m.created_at,
    })),
  });
}

async function handleMessagesPost(request: Request, env: Env, token: string): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token", "This portal link is invalid or no longer available.");
  if (!job.client_id) return err(409, "no_client", "This project has no client on file.");

  let body: { body?: unknown } = {};
  try {
    body = (await request.json()) as { body?: unknown };
  } catch {
    return err(400, "bad_request", "Body must be JSON.");
  }
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) return err(422, "empty_message", "Please enter a message.");
  if (text.length > MESSAGE_MAX_LEN) {
    return err(422, "message_too_long", `Messages are limited to ${MESSAGE_MAX_LEN} characters.`);
  }

  // Simple per-job rate limit on the PUBLIC endpoint (Open Question 3).
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM communications
      WHERE job_id = ? AND channel = 'portal_message' AND direction = 'inbound'
        AND created_at >= datetime('now', ?)`,
  )
    .bind(job.id, `-${MESSAGE_RATE_WINDOW_SECONDS} seconds`)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MESSAGE_RATE_MAX) {
    return err(429, "rate_limited", "You're sending messages too quickly. Please try again in a moment.");
  }

  const name = (await clientName(env, job.client_id)) || "Client";
  const commId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO communications (
        id, client_id, job_id, channel, direction, summary, body, sent_via, logged_by, created_at
     ) VALUES (?, ?, ?, 'portal_message', 'inbound', ?, ?, 'portal', 'client', datetime('now'))`,
  )
    .bind(commId, job.client_id, job.id, `Portal message from ${name}`, text)
    .run();

  // Sprint 7 in-app owner bell (notification_logs, channel='in_app'). Dispatch
  // stays SIMULATE — no SMS/email. The message is already on the comm timeline.
  await createOwnerInApp(env, {
    message: `New portal message from ${name}: ${text.slice(0, 120)}`,
    linkPath: `/app/jobs/${job.id}`,
    clientId: job.client_id,
    dedupe: `portal_msg:${commId}`,
  });

  return json(
    {
      ok: true,
      message: { id: commId, from: "client", body: text, created_at: new Date().toISOString() },
    },
    { status: 201 },
  );
}

// ─── GET /api/portal/:token/schedule — read-only client schedule (S13) ─────────
// Clients see upcoming/scheduled work (date, trade/work, status, times) but have
// NO write path (rule #6). Sub identity is intentionally not exposed to clients.

async function handleSchedule(env: Env, token: string): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token", "This portal link is invalid or no longer available.");
  const rows = (
    await env.DB.prepare(
      `SELECT id, scheduled_date, trade_or_work, start_time, end_time, status
         FROM schedule_entries WHERE job_id = ?
        ORDER BY scheduled_date ASC, start_time ASC`,
    )
      .bind(job.id)
      .all<{
        id: string;
        scheduled_date: string | null;
        trade_or_work: string | null;
        start_time: string | null;
        end_time: string | null;
        status: string | null;
      }>()
  ).results ?? [];
  return json({
    ok: true,
    entries: rows.map((e) => ({
      id: e.id,
      scheduled_date: e.scheduled_date,
      trade_or_work: e.trade_or_work,
      start_time: e.start_time,
      end_time: e.end_time,
      status: e.status ?? "scheduled",
    })),
  });
}

// ─── GET /api/portal/:token/change-orders — client CO list + sign view (S13) ───

async function handleChangeOrders(env: Env, token: string): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token", "This portal link is invalid or no longer available.");
  const rows = (
    await env.DB.prepare(
      `SELECT id, change_order_number, title, description, amount, status,
              requested_date, approved_date, applied_at, end_date_extension_days, signed_name
         FROM change_orders
        WHERE job_id = ? AND status != 'draft'
        ORDER BY change_order_number ASC`,
    )
      .bind(job.id)
      .all<{
        id: string;
        change_order_number: number;
        title: string | null;
        description: string | null;
        amount: number | null;
        status: string | null;
        requested_date: string | null;
        approved_date: string | null;
        applied_at: string | null;
        end_date_extension_days: number | null;
        signed_name: string | null;
      }>()
  ).results ?? [];
  return json({
    ok: true,
    on_hold: (job.conversion_reversed ?? 0) === 1,
    change_orders: rows.map((c) => ({
      id: c.id,
      change_order_number: c.change_order_number,
      display: `CO-${c.change_order_number}`,
      title: c.title,
      description: c.description,
      amount: round2(c.amount ?? 0),
      is_credit: (c.amount ?? 0) < 0,
      status: c.status,
      requested_date: c.requested_date,
      approved_date: c.approved_date,
      end_date_extension_days: c.end_date_extension_days ?? 0,
      signed_name: c.signed_name,
      // The client can sign a 'sent' CO. Approved/rejected render read-only.
      can_sign: c.status === "sent" && (job.conversion_reversed ?? 0) !== 1,
    })),
  });
}

// ─── POST /api/portal/:token/change-orders/:id/sign — capture + auto-apply (S13)
// The client signs inside the portal under the job portal_token (resolved open
// question). Idempotent: a double-submit / refresh stores the signature once and
// applies the CO exactly once (applyChangeOrder claims the apply atomically).

async function handleChangeOrderSign(
  request: Request,
  env: Env,
  token: string,
  coId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token", "This portal link is invalid or no longer available.");
  if ((job.conversion_reversed ?? 0) === 1) {
    return err(422, "job_on_hold", "This project is on hold — please contact us before signing.");
  }

  const co = await env.DB.prepare(
    "SELECT id, job_id, status, applied_at, client_signature FROM change_orders WHERE id = ?",
  )
    .bind(coId)
    .first<{ id: string; job_id: string | null; status: string | null; applied_at: string | null; client_signature: string | null }>();
  if (!co || co.job_id !== job.id) return err(404, "not_found", "Change order not found for this project.");

  // Already signed/approved → idempotent no-op; return the applied result.
  if (co.status === "approved" || co.applied_at) {
    const res = await applyChangeOrder(env, coId, ctx); // fast no-op path
    return json({ ok: true, already_applied: true, change_order: res?.change_order ?? null });
  }
  if (co.status !== "sent") {
    return err(409, "invalid_state", `This change order can't be signed from status '${co.status}'.`);
  }

  let body: { signature?: unknown; signed_name?: unknown } = {};
  try {
    body = (await request.json()) as { signature?: unknown; signed_name?: unknown };
  } catch {
    return err(400, "bad_request", "Body must be JSON.");
  }
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  if (!signature) return err(400, "signature_required", "A typed signature (your full name) is required.");
  const signedName = typeof body.signed_name === "string" && body.signed_name.trim() ? body.signed_name.trim() : signature;
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("x-forwarded-for") ?? "";

  // Store the signature (only while still 'sent' and unapplied). Safe to repeat.
  await env.DB.prepare(
    `UPDATE change_orders SET client_signature = ?, signed_name = ?, signed_ip = ?
      WHERE id = ? AND status = 'sent' AND applied_at IS NULL`,
  )
    .bind(signature, signedName, ip, coId)
    .run();

  // Auto-apply exactly once. Fires change_order_approved (SIMULATE) inside.
  console.log(`[AUTOTRIGGER] portal change-order sign — coId=${coId}`);
  try {
    const res = await applyChangeOrder(env, coId, ctx);
    return json({ ok: true, already_applied: res?.already_applied ?? false, change_order: res?.change_order ?? null });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "signature_required") return err(400, "signature_required", "Signature could not be recorded.");
    return err(500, "apply_failed", "We couldn't record your signature. Please try again.");
  }
}

// ─── GET /api/portal/:token/documents — client-visible job documents (S15) ────
// Read-only, token-gated, grouped by category. Visibility filter mirrors the
// S12 photo pattern: is_active=1, and exclude internal-only categories
// (receipt, sop, insurance, license) AND the completion_package (it has its own
// tab and only appears once SENT). Documents are never editable here.

const PORTAL_HIDDEN_DOC_CATEGORIES = ["receipt", "sop", "insurance", "license", "completion_package"];

async function handleDocuments(env: Env, token: string): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token", "This portal link is invalid or no longer available.");
  const placeholders = PORTAL_HIDDEN_DOC_CATEGORIES.map(() => "?").join(",");
  const rows = (
    await env.DB.prepare(
      `SELECT id, title, file_type, document_category, is_signed, signed_date, created_at
         FROM documents
        WHERE job_id = ? AND COALESCE(is_active, 1) = 1
          AND document_category NOT IN (${placeholders})
        ORDER BY document_category ASC, created_at DESC`,
    )
      .bind(job.id, ...PORTAL_HIDDEN_DOC_CATEGORIES)
      .all<Record<string, unknown> & { document_category: string }>()
  ).results ?? [];
  const groups: Record<string, unknown[]> = {};
  for (const d of rows) (groups[d.document_category] ??= []).push(d);
  return json({ ok: true, documents: rows, groups });
}

// ─── GET /api/portal/:token/completion-package — sent package only (S15) ──────
// Renders the branded HTML package, but ONLY once the owner has SENT it
// (is_signed=1). Draft packages are invisible to the client (review gate,
// business rule 6). Returns 404 until sent so the portal tab stays hidden.

async function handleCompletionPackage(env: Env, token: string): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token", "This portal link is invalid or no longer available.");

  const jobRow = await env.DB.prepare(
    "SELECT completion_package_sent_at FROM jobs WHERE id = ?",
  )
    .bind(job.id)
    .first<{ completion_package_sent_at: string | null }>();

  if (!jobRow?.completion_package_sent_at) {
    return err(404, "not_sent", "The completion package is not available yet.");
  }

  const pkg = await env.DB.prepare(
    `SELECT id, r2_key, file_type, title, signed_date
       FROM documents
      WHERE job_id = ? AND document_category='completion_package'
        AND COALESCE(is_active,1)=1 AND COALESCE(is_signed,0)=1
      ORDER BY datetime(signed_date) DESC LIMIT 1`,
  )
    .bind(job.id)
    .first<{ id: string; r2_key: string; file_type: string; title: string; signed_date: string | null }>();
  if (!pkg) return err(404, "not_sent", "The completion package is not available yet.");

  const obj = await env.FILES.get(pkg.r2_key);
  if (!obj) return err(404, "not_sent", "The completion package is not available yet.");
  // Render inline so the client can view + browser-print to PDF.
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": pkg.file_type || "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// ─── GET /api/portal/:token/documents/:doc_id/file — signed PDF download ──────
// Token-gated, no CF Access. Only streams documents that:
//   1. Belong to the job identified by the portal token.
//   2. Are is_signed = 1 (completed signed docs created by the BoldSign webhook).
//   3. Are not from category lien_waiver (sub-facing; blocked from client portal).
async function handlePortalDocFile(env: Env, token: string, docId: string): Promise<Response> {
  const job = await resolveJob(env, token);
  if (!job) return err(404, "invalid_token", "This portal link is invalid or no longer available.");

  const doc = await env.DB.prepare(
    `SELECT title, r2_key, file_type, document_category, is_signed
       FROM documents
      WHERE id = ? AND job_id = ? AND COALESCE(is_active, 1) = 1`,
  )
    .bind(docId, job.id)
    .first<{ title: string | null; r2_key: string; file_type: string | null; document_category: string; is_signed: number | null }>();

  if (!doc) return err(404, "not_found", "Document not found.");
  if (!doc.is_signed) return err(403, "not_signed", "Only signed documents are downloadable from the portal.");
  if (doc.document_category === "lien_waiver") {
    return err(403, "not_available", "This document is not available in the client portal.");
  }

  const obj = await env.FILES.get(doc.r2_key);
  if (!obj) return err(404, "file_not_found", "Document file not available.");

  const contentType = doc.file_type ?? "application/octet-stream";
  const filename = doc.title ?? "signed-document.pdf";
  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-cache",
    },
  });
}

// ─── dispatcher ────────────────────────────────────────────────────────────────

/**
 * Route every /api/portal/* request. Returns null when the path/method is not a
 * portal route so the caller (src/index.ts) can fall through. The estimate token
 * routes (/api/portal/estimate/...) are NOT handled here.
 */
export async function handlePortalApi(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const { method } = request;
  const p = url.pathname;

  // Photo image proxy (most specific first).
  const img = p.match(/^\/api\/portal\/([^/]+)\/photos\/([^/]+)\/(image|thumb)$/);
  if (img) {
    if (method !== "GET") return err(405, "method_not_allowed");
    return handlePhotoImage(
      env,
      decodeURIComponent(img[1]),
      decodeURIComponent(img[2]),
      img[3] === "thumb" ? "thumb" : "original",
    );
  }

  const coSign = p.match(/^\/api\/portal\/([^/]+)\/change-orders\/([^/]+)\/sign$/);
  if (coSign && method === "POST") {
    return handleChangeOrderSign(request, env, decodeURIComponent(coSign[1]), decodeURIComponent(coSign[2]), ctx);
  }

  const pay = p.match(/^\/api\/portal\/([^/]+)\/pay\/([^/]+)$/);
  if (pay && method === "POST") {
    return handlePay(request, env, decodeURIComponent(pay[1]), decodeURIComponent(pay[2]));
  }

  const photos = p.match(/^\/api\/portal\/([^/]+)\/photos$/);
  if (photos && method === "GET") return handlePhotos(env, decodeURIComponent(photos[1]));

  const invoices = p.match(/^\/api\/portal\/([^/]+)\/invoices$/);
  if (invoices && method === "GET") return handleInvoices(env, decodeURIComponent(invoices[1]));

  const budget = p.match(/^\/api\/portal\/([^/]+)\/budget$/);
  if (budget && method === "GET") return handleBudget(env, decodeURIComponent(budget[1]));

  const messages = p.match(/^\/api\/portal\/([^/]+)\/messages$/);
  if (messages) {
    if (method === "GET") return handleMessagesGet(env, decodeURIComponent(messages[1]));
    if (method === "POST") return handleMessagesPost(request, env, decodeURIComponent(messages[1]));
  }

  const schedule = p.match(/^\/api\/portal\/([^/]+)\/schedule$/);
  if (schedule && method === "GET") return handleSchedule(env, decodeURIComponent(schedule[1]));

  const changeOrders = p.match(/^\/api\/portal\/([^/]+)\/change-orders$/);
  if (changeOrders && method === "GET") {
    return handleChangeOrders(env, decodeURIComponent(changeOrders[1]));
  }

  const documents = p.match(/^\/api\/portal\/([^/]+)\/documents$/);
  if (documents && method === "GET") return handleDocuments(env, decodeURIComponent(documents[1]));

  // Signed document file download (Sprint 21: BoldSign completed PDFs).
  const docFile = p.match(/^\/api\/portal\/([^/]+)\/documents\/([^/]+)\/file$/);
  if (docFile && (method === "GET" || method === "HEAD")) {
    return handlePortalDocFile(env, decodeURIComponent(docFile[1]), decodeURIComponent(docFile[2]));
  }

  const completion = p.match(/^\/api\/portal\/([^/]+)\/completion-package$/);
  if (completion && method === "GET") return handleCompletionPackage(env, decodeURIComponent(completion[1]));

  // Landing — match LAST so it never shadows the sub-routes above.
  const landing = p.match(/^\/api\/portal\/([^/]+)$/);
  if (landing && method === "GET") {
    const tok = decodeURIComponent(landing[1]);
    if (tok === "estimate") return null; // reserved for the estimate token namespace
    return handleLanding(env, tok);
  }

  return null;
}
