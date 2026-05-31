/**
 * Estimating Pipeline API — estimate requests (Sprint 3). The front door of the
 * platform: a lead comes in, gets an appointment, an estimate visit, and flows
 * toward a quote. Mirrors the clients.ts pattern: thin handlers, parameterized
 * D1 queries, audit logging on every write, role enforcement via guard().
 *
 *   GET  /api/estimate-requests                 list + filters
 *   GET  /api/estimate-requests/pipeline        grouped by status (Kanban data)
 *   GET  /api/estimate-requests/:id             detail (+ client + activity log)
 *   POST /api/estimate-requests                 create (lead WC hook, repeat check)
 *   PUT  /api/estimate-requests/:id             update (status state machine)
 *   PUT  /api/estimate-requests/:id/appointment set/clear appointment
 *   PUT  /api/estimate-requests/:id/lost        mark lost (+ reason/notes)
 *
 * Schema: see migrations/0026_estimate_requests.sql (request_number is a plain
 * UNIQUE integer, not AUTOINCREMENT, so create computes MAX(request_number)+1).
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { triggerLeadCreated, triggerAppointmentSet, triggerDealWon } from "../lib/wc/triggers.js";
import { convertQuoteToJob, type DepositMethod } from "../lib/quote-to-job.js";
import { triggerNotification, triggerJobConversionNotifications } from "../lib/notification-engine.js";

// Write roles match the app-wide convention (clients/subs): owner, PM, and
// office_admin — office_admin managing the pipeline is the realistic workflow.
// Read endpoints stay open behind the edge Access gate.
const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;

// Linear forward-only pipeline. won/lost are terminal and handled specially:
//   - lost is always reachable from any non-terminal stage
//   - won can be set manually from sent/follow_up (deposit-paid quote→job
//     conversion will set it automatically via the same path in Sprint 5)
const PROGRESSION = [
  "new_request",
  "appointment_set",
  "visit_done",
  "building",
  "sent",
  "follow_up",
] as const;
const ALL_STATUSES = [...PROGRESSION, "won", "lost"] as const;
type Status = (typeof ALL_STATUSES)[number];

// ─── shared helpers (match clients.ts) ──────────────────────────────────────

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

async function logAudit(
  env: Env,
  userEmail: string,
  action: string,
  entityId: string,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
  )
    .bind(crypto.randomUUID(), userEmail, action, "estimate_request", entityId, JSON.stringify(details))
    .run();
}

interface RequestRow {
  id: string;
  request_number: number;
  status: string;
  client_id: string;
  property_address: string;
  property_city: string;
  property_state: string | null;
  property_zip: string;
  job_type: string;
  lead_source: string;
  lead_source_detail: string | null;
  high_level_opportunity_id: string | null;
  appointment_date: string | null;
  appointment_completed: number | null;
  visit_notes: string | null;
  visit_photo_ids: string | null;
  estimate_id: string | null;
  sent_date: string | null;
  follow_up_count: number | null;
  last_follow_up_date: string | null;
  lost_reason: string | null;
  lost_notes: string | null;
  converted_job_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  created_by: string | null;
  // joined client fields
  c_first: string | null;
  c_last: string | null;
  c_name: string | null;
  c_phone: string | null;
  c_email: string | null;
  c_is_repeat: number | null;
  // joined estimate fields
  e_status: string | null;
  e_sent_at: string | null;
  e_deposit: number | null;
}

const SELECT = `
  SELECT er.*,
    c.first_name AS c_first, c.last_name AS c_last, c.name AS c_name,
    c.phone AS c_phone, c.email AS c_email,
    COALESCE(c.is_repeat_client, 0) AS c_is_repeat,
    e.status AS e_status, e.sent_at AS e_sent_at, e.deposit_amount AS e_deposit
  FROM estimate_requests er
  LEFT JOIN clients c ON c.id = er.client_id
  LEFT JOIN estimates e ON e.id = er.estimate_id
`;

function clientName(row: RequestRow): string {
  const parts = [row.c_first, row.c_last].filter(Boolean).join(" ").trim();
  return parts || row.c_name || "(unnamed)";
}

function daysSince(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime();
  if (isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function shape(row: RequestRow) {
  return {
    id: row.id,
    request_number: row.request_number,
    status: row.status,
    client_id: row.client_id,
    client_name: clientName(row),
    client_phone: row.c_phone,
    client_email: row.c_email,
    is_repeat_client: (row.c_is_repeat ?? 0) === 1,
    property_address: row.property_address,
    property_city: row.property_city,
    property_state: row.property_state,
    property_zip: row.property_zip,
    job_type: row.job_type,
    lead_source: row.lead_source,
    lead_source_detail: row.lead_source_detail,
    high_level_opportunity_id: row.high_level_opportunity_id,
    appointment_date: row.appointment_date,
    appointment_completed: (row.appointment_completed ?? 0) === 1,
    visit_notes: row.visit_notes,
    visit_photo_ids: row.visit_photo_ids,
    estimate_id: row.estimate_id,
    estimate_status: row.e_status,
    estimate_sent: !!row.e_sent_at || (row.e_status != null && row.e_status !== "draft"),
    estimate_deposit: row.e_deposit,
    sent_date: row.sent_date,
    follow_up_count: row.follow_up_count ?? 0,
    last_follow_up_date: row.last_follow_up_date,
    lost_reason: row.lost_reason,
    lost_notes: row.lost_notes,
    converted_job_id: row.converted_job_id,
    days_in_stage: daysSince(row.updated_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
  };
}

async function loadShaped(env: Env, id: string) {
  const row = await env.DB.prepare(`${SELECT} WHERE er.id = ?`).bind(id).first<RequestRow>();
  return row ? shape(row) : null;
}

/**
 * Validate a status transition. Returns an error message string if the move is
 * illegal, or null if allowed. `next === current` is treated as a no-op (legal).
 */
function validateTransition(current: string, next: string): string | null {
  if (next === current) return null;
  if (!ALL_STATUSES.includes(next as Status)) {
    return `Unknown status "${next}"`;
  }
  // Terminal states cannot transition onward (won and lost are both final).
  if (current === "won" || current === "lost") {
    return `Cannot move a '${current}' request to '${next}'.`;
  }
  // Won can be set manually, but only once a quote has actually gone out — you
  // can't win a job you never sent. Once the Sprint 5 quote-to-job conversion
  // (deposit paid) lands, it will set won automatically via the same path.
  if (next === "won") {
    if (current === "sent" || current === "follow_up") return null;
    return "A request can only be marked 'won' from 'Estimate Sent' or 'Follow-Up'.";
  }
  if (next === "lost") return null; // always allowed from any active stage
  const ci = PROGRESSION.indexOf(current as (typeof PROGRESSION)[number]);
  const ni = PROGRESSION.indexOf(next as (typeof PROGRESSION)[number]);
  if (ci === -1 || ni === -1) return `Illegal status transition ${current} → ${next}.`;
  if (ni < ci) return `Backward status moves are not allowed (${current} → ${next}).`;
  return null;
}


// ─── GET /api/estimate-requests ──────────────────────────────────────────────

export async function handleEstimateRequestList(env: Env, url: URL): Promise<Response> {
  const where: string[] = [];
  const binds: unknown[] = [];

  const status = str(url.searchParams.get("status"));
  const jobType = str(url.searchParams.get("job_type"));
  const leadSource = str(url.searchParams.get("lead_source"));
  const from = str(url.searchParams.get("from"));
  const to = str(url.searchParams.get("to"));

  if (status) {
    where.push("er.status = ?");
    binds.push(status);
  }
  if (jobType) {
    where.push("er.job_type = ?");
    binds.push(jobType);
  }
  if (leadSource) {
    where.push("er.lead_source = ?");
    binds.push(leadSource);
  }
  if (from) {
    where.push("er.created_at >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("er.created_at <= ?");
    binds.push(to);
  }

  const sql = `${SELECT}
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY er.created_at DESC
    LIMIT 1000`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all<RequestRow>();
  const rows = (results ?? []).map(shape);
  return json({ as_of: new Date().toISOString(), total: rows.length, requests: rows });
}

// ─── GET /api/estimate-requests/pipeline ─────────────────────────────────────

export async function handleEstimateRequestPipeline(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `${SELECT} ORDER BY er.updated_at DESC`,
  ).all<RequestRow>();
  const rows = (results ?? []).map(shape);

  // Always emit every stage key (even empty) so the board renders all columns.
  const pipeline: Record<string, ReturnType<typeof shape>[]> = {};
  for (const s of ALL_STATUSES) pipeline[s] = [];
  for (const r of rows) {
    (pipeline[r.status] ?? (pipeline[r.status] = [])).push(r);
  }

  return json({
    as_of: new Date().toISOString(),
    stages: ALL_STATUSES,
    counts: Object.fromEntries(ALL_STATUSES.map((s) => [s, pipeline[s].length])),
    pipeline,
  });
}

// ─── GET /api/estimate-requests/:id ──────────────────────────────────────────

export async function handleEstimateRequestGet(env: Env, id: string): Promise<Response> {
  const row = await loadShaped(env, id);
  if (!row) return err(404, "not_found", "Estimate request not found");

  const activity = await env.DB.prepare(
    `SELECT id, user_email, action, details, created_at
     FROM audit_logs
     WHERE entity_type = 'estimate_request' AND entity_id = ?
     ORDER BY created_at DESC
     LIMIT 200`,
  )
    .bind(id)
    .all();

  return json({ request: row, activity: activity.results ?? [] });
}

// ─── POST /api/estimate-requests ─────────────────────────────────────────────

export async function handleEstimateRequestCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const clientId = str(body.client_id);
  const propertyAddress = str(body.property_address);
  const propertyCity = str(body.property_city);
  const propertyZip = str(body.property_zip);
  const jobType = str(body.job_type);
  const leadSource = str(body.lead_source);

  const missing: string[] = [];
  if (!clientId) missing.push("client_id");
  if (!propertyAddress) missing.push("property_address");
  if (!propertyCity) missing.push("property_city");
  if (!propertyZip) missing.push("property_zip");
  if (!jobType) missing.push("job_type");
  if (!leadSource) missing.push("lead_source");
  if (missing.length > 0) {
    return err(400, "bad_request", `Missing required field(s): ${missing.join(", ")}`);
  }

  const client = await env.DB.prepare(
    "SELECT id, COALESCE(is_repeat_client, 0) AS is_repeat FROM clients WHERE id = ?",
  )
    .bind(clientId)
    .first<{ id: string; is_repeat: number }>();
  if (!client) return err(404, "not_found", "Client not found");

  // request_number is UNIQUE but not AUTOINCREMENT — compute the next value.
  const max = await env.DB.prepare(
    "SELECT COALESCE(MAX(request_number), 0) AS n FROM estimate_requests",
  ).first<{ n: number }>();
  const requestNumber = (max?.n ?? 0) + 1;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO estimate_requests (
      id, request_number, status, client_id,
      property_address, property_city, property_state, property_zip,
      job_type, lead_source, lead_source_detail, high_level_opportunity_id,
      visit_notes, created_at, updated_at, created_by
    ) VALUES (?, ?, 'new_request', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      requestNumber,
      clientId,
      propertyAddress,
      propertyCity,
      str(body.property_state) ?? "Arkansas",
      propertyZip,
      jobType,
      leadSource,
      str(body.lead_source_detail),
      str(body.high_level_opportunity_id),
      str(body.notes) ?? str(body.visit_notes),
      now,
      now,
      user.email,
    )
    .run();

  await logAudit(env, user.email, "estimate_request_created", id, {
    request_number: requestNumber,
    client_id: clientId,
    job_type: jobType,
    lead_source: leadSource,
  });

  // WC lead-count hook (recomputed from D1 on next cron tick).
  triggerLeadCreated(env, id);

  // Notification: client lead acknowledgment (sms+email, immediate). Enqueues
  // only — the */15 processor sends. Idempotent on the request id.
  await triggerNotification(env, "lead_created", {
    clientId,
    estimateRequestId: id,
    instanceKey: "lead",
  });

  const created = await loadShaped(env, id);
  return json({ request: created }, { status: 201 });
}

// ─── PUT /api/estimate-requests/:id ──────────────────────────────────────────

const UPDATABLE_TEXT = [
  "property_address",
  "property_city",
  "property_state",
  "property_zip",
  "job_type",
  "lead_source",
  "lead_source_detail",
  "high_level_opportunity_id",
  "visit_notes",
  "sent_date",
  "last_follow_up_date",
] as const;

export async function handleEstimateRequestUpdate(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare(
    "SELECT id, status, estimate_id FROM estimate_requests WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; status: string; estimate_id: string | null }>();
  if (!existing) return err(404, "not_found", "Estimate request not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const updates: string[] = [];
  const binds: unknown[] = [];

  let triggerAppointment = false;
  let nextStatus: string | null = null;

  // Status transition (validated state machine).
  if ("status" in body) {
    const target = str(body.status) ?? "";
    // Won is never set through the generic update — it must run the quote-to-job
    // conversion, which records the deposit payment (Module-Spec §4.10). A direct
    // PATCH/PUT status=won (no payment record) is rejected with 400.
    if (target === "won" && target !== existing.status) {
      return err(
        400,
        "won_requires_conversion",
        "Marking a request won requires recording the deposit payment. Use the Mark as Won action (POST /api/estimate-requests/:id/win).",
      );
    }
    const problem = validateTransition(existing.status, target);
    if (problem) return err(400, "bad_request", problem);
    if (target !== existing.status) {
      nextStatus = target;
      if (target === "appointment_set") triggerAppointment = true;
    }
  }

  // Appointment date set via the generic PUT → bump new_request to appointment_set.
  if ("appointment_date" in body) {
    const appt = str(body.appointment_date);
    updates.push("appointment_date = ?");
    binds.push(appt);
    if (appt && existing.status === "new_request" && nextStatus === null) {
      nextStatus = "appointment_set";
      triggerAppointment = true;
    }
  }
  if ("appointment_completed" in body) {
    updates.push("appointment_completed = ?");
    binds.push(body.appointment_completed === true || body.appointment_completed === 1 ? 1 : 0);
  }
  if ("follow_up_count" in body) {
    const n = Number(body.follow_up_count);
    updates.push("follow_up_count = ?");
    binds.push(Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
  }

  for (const col of UPDATABLE_TEXT) {
    if (col in body) {
      updates.push(`${col} = ?`);
      // property_state has a NOT NULL DEFAULT — never null it.
      binds.push(col === "property_state" ? str(body[col]) ?? "Arkansas" : str(body[col]));
    }
  }

  if (nextStatus) {
    updates.push("status = ?");
    binds.push(nextStatus);
  }

  if (updates.length === 0) return err(400, "bad_request", "No updatable fields supplied");

  updates.push("updated_at = ?");
  binds.push(new Date().toISOString());
  binds.push(id);

  await env.DB.prepare(`UPDATE estimate_requests SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  await logAudit(env, user.email, "estimate_request_updated", id, {
    fields: Object.keys(body),
    ...(nextStatus ? { status_from: existing.status, status_to: nextStatus } : {}),
  });

  if (triggerAppointment) triggerAppointmentSet(env, id);

  const updated = await loadShaped(env, id);
  // Notification: appointment confirmed (sms+email, immediate). Keyed on the
  // appointment date so re-saving the same date won't re-message the client,
  // but rescheduling to a new date sends a fresh confirmation.
  if (triggerAppointment && updated?.appointment_date) {
    await triggerNotification(env, "appointment_confirmed", {
      clientId: updated.client_id,
      estimateRequestId: id,
      instanceKey: updated.appointment_date,
    });
  }
  return json({ request: updated });
}

// ─── PUT /api/estimate-requests/:id/appointment ──────────────────────────────

export async function handleEstimateRequestAppointment(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare(
    "SELECT id, status FROM estimate_requests WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!existing) return err(404, "not_found", "Estimate request not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const updates: string[] = [];
  const binds: unknown[] = [];
  let triggerAppointment = false;

  if ("appointment_date" in body) {
    const appt = str(body.appointment_date);
    updates.push("appointment_date = ?");
    binds.push(appt);
    if (appt && existing.status === "new_request") {
      updates.push("status = ?");
      binds.push("appointment_set");
      triggerAppointment = true;
    }
  }
  if ("appointment_completed" in body) {
    updates.push("appointment_completed = ?");
    binds.push(body.appointment_completed === true || body.appointment_completed === 1 ? 1 : 0);
  }

  if (updates.length === 0) {
    return err(400, "bad_request", "Provide appointment_date and/or appointment_completed");
  }

  updates.push("updated_at = ?");
  binds.push(new Date().toISOString());
  binds.push(id);

  await env.DB.prepare(`UPDATE estimate_requests SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  await logAudit(env, user.email, "estimate_request_appointment_set", id, {
    appointment_date: str(body.appointment_date),
    appointment_completed: body.appointment_completed === true || body.appointment_completed === 1,
  });

  if (triggerAppointment) triggerAppointmentSet(env, id);

  const updated = await loadShaped(env, id);
  if (triggerAppointment && updated?.appointment_date) {
    await triggerNotification(env, "appointment_confirmed", {
      clientId: updated.client_id,
      estimateRequestId: id,
      instanceKey: updated.appointment_date,
    });
  }
  return json({ request: updated });
}

// ─── PUT /api/estimate-requests/:id/lost ─────────────────────────────────────

export async function handleEstimateRequestLost(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare(
    "SELECT id, status FROM estimate_requests WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!existing) return err(404, "not_found", "Estimate request not found");
  if (existing.status === "won") {
    return err(400, "bad_request", "Cannot mark a 'won' request as lost.");
  }

  const body = (await readJson(request)) ?? {};

  await env.DB.prepare(
    `UPDATE estimate_requests
     SET status = 'lost', lost_reason = ?, lost_notes = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(str(body.lost_reason), str(body.lost_notes), new Date().toISOString(), id)
    .run();

  await logAudit(env, user.email, "estimate_request_lost", id, {
    status_from: existing.status,
    lost_reason: str(body.lost_reason),
  });

  const updated = await loadShaped(env, id);
  return json({ request: updated });
}

// ─── POST /api/estimate-requests/:id/win ─────────────────────────────────────
// Manual "Mark as Won" (Module-Spec §4.10). The modal posts the deposit payment;
// this runs the quote-to-job conversion. Won is set ONLY through this path.

const MANUAL_PAYMENT_METHODS: ReadonlySet<DepositMethod> = new Set([
  "check",
  "cash",
  "venmo",
  "zelle",
  "other",
]);

export async function handleEstimateRequestWin(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const method = (str(body.payment_method) ?? "").toLowerCase() as DepositMethod;
  if (!MANUAL_PAYMENT_METHODS.has(method)) {
    return err(
      400,
      "bad_request",
      "A payment method is required: check, cash, venmo, zelle, or other.",
    );
  }
  const amount = Number(body.deposit_amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return err(400, "bad_request", "A deposit amount greater than zero is required.");
  }
  const reference = str(body.reference);

  const outcome = await convertQuoteToJob(env, id, { amount, method, reference }, user.id);
  if (!outcome.ok) return err(outcome.status, outcome.error, outcome.details);

  // Idempotent: a request that's already fully converted returns the existing
  // job unchanged (no second job, no second payment).
  if (outcome.idempotent) {
    const updated = await loadShaped(env, id);
    return json({
      request: updated,
      job_id: outcome.jobId,
      job_number: outcome.jobNumber,
      idempotent: true,
    });
  }

  await logAudit(env, user.email, "estimate_request_won", id, {
    job_id: outcome.jobId,
    job_number: outcome.jobNumber,
    payment_id: outcome.paymentId,
    payment_method: method,
    deposit_amount: amount,
    conversion: "completed",
  });

  // Job-scoped audit entry so the Job Detail Activity tab shows the conversion.
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, 'job', ?, ?, datetime('now'))",
  )
    .bind(
      crypto.randomUUID(),
      user.email,
      "job_created",
      outcome.jobId,
      JSON.stringify({ from_request: id, job_number: outcome.jobNumber, deposit_method: method }),
    )
    .run();

  // WC closed-deal count + New Sales value track the contract total, not deposit.
  triggerDealWon(env, outcome.jobId, outcome.total);

  // Notifications: deposit receipt + welcome-portal emails (immediate, idempotent).
  await triggerJobConversionNotifications(env, outcome.jobId);

  const updated = await loadShaped(env, id);
  return json({
    request: updated,
    job_id: outcome.jobId,
    job_number: outcome.jobNumber,
    payment_id: outcome.paymentId,
  });
}
