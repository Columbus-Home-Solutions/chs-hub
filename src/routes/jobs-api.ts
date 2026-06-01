/**
 * Native Job Management API — Sprint 6 (CHS-API-Route-Map §Jobs, §Tasks).
 *
 * Jobs are NEVER created here: the only way a job exists is the shared
 * convertQuoteToJob() (manual Won modal + Stripe webhook). So there is no POST
 * /api/jobs. This module owns:
 *
 *   GET  /api/jobs                  list + filters (?status=&job_type=&client_id=&billing_model=)
 *   GET  /api/jobs/pipeline         jobs grouped by status (all 6 keys, empty arrays ok)
 *   GET  /api/jobs/:id              detail (overview + tasks + activity tabs)
 *   PUT  /api/jobs/:id              update editable fields (title, dates, notes)
 *   PUT  /api/jobs/:id/status       dedicated status change (validates transitions, side effects)
 *   GET  /api/jobs/:id/tasks        tasks grouped by task_group, ordered
 *   POST /api/jobs/:id/tasks        create a task in a group
 *   PUT  /api/tasks/:id             update a task
 *   PUT  /api/tasks/:id/complete    mark complete (completed_date + completed_by)
 *
 * Native jobs are distinguished from legacy Jobber-synced rows by source =
 * 'estimate' (set by the conversion). The legacy Jobber jobs view lives at
 * /api/legacy/jobs (src/routes/jobs.ts) so this namespace is purely native.
 *
 * Conventions mirror estimate-requests.ts: thin handlers, parameterized D1,
 * audit logging on every write, role enforcement via guard().
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { triggerJobStatusChanged } from "../lib/wc/triggers.js";
import { reverseJobConversion } from "../lib/quote-to-job.js";

const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;
const REVERSE_ROLES = ["owner"] as const;

// Forward-only lifecycle (Job Management §2). Two backward exceptions only.
export const JOB_STATUSES = [
  "deposit_paid",
  "scheduled",
  "in_progress",
  "punch_list",
  "complete",
  "closed",
] as const;
type JobStatus = (typeof JOB_STATUSES)[number];

const STATUS_INDEX: Record<string, number> = Object.fromEntries(
  JOB_STATUSES.map((s, i) => [s, i]),
);

// Allowed backward moves (pause/weather; new punch items found).
const BACKWARD_EXCEPTIONS = new Set(["in_progress>scheduled", "complete>punch_list"]);

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

// ─── row shaping ────────────────────────────────────────────────────────────

interface JobListRow {
  id: string;
  job_number: number | null;
  title: string | null;
  status: string | null;
  client_id: string | null;
  client_name: string | null;
  billing_model: string | null;
  job_type: string | null;
  lead_source: string | null;
  property_address: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
  contract_total: number | null;
  deposit_amount: number | null;
  deposit_paid: number | null;
  start_date: string | null;
  target_end_date: string | null;
  actual_end_date: string | null;
  portal_token: string | null;
  portal_type: string | null;
  conversion_complete: number | null;
  estimate_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  status_since: string | null; // last status-change timestamp (or created_at)
}

const JOB_SELECT = `
  SELECT j.id, j.job_number, j.title, j.status, j.client_id, c.name AS client_name,
         j.billing_model, j.job_type, j.lead_source,
         j.property_address, j.property_city, j.property_state, j.property_zip,
         j.contract_total, j.deposit_amount, j.deposit_paid,
         j.start_date, j.target_end_date, j.actual_end_date,
         j.portal_token, j.portal_type, j.conversion_complete, j.estimate_id,
         j.created_at, j.updated_at,
         COALESCE((
           SELECT MAX(a.created_at) FROM audit_logs a
           WHERE a.entity_type = 'job' AND a.entity_id = j.id
             AND a.action = 'job_status_changed'
         ), j.created_at) AS status_since
  FROM jobs j
  LEFT JOIN clients c ON c.id = j.client_id
  WHERE j.source = 'estimate'`;

function daysSince(iso: string | null): number {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

function shapeJobCard(r: JobListRow) {
  const today = new Date().toISOString().slice(0, 10);
  const terminal = r.status === "complete" || r.status === "closed";
  const overdue = !!r.target_end_date && r.target_end_date < today && !terminal;
  return {
    id: r.id,
    job_number: r.job_number,
    job_display: r.job_number != null ? `JOB-${String(r.job_number).padStart(3, "0")}` : null,
    title: r.title,
    status: r.status,
    client_id: r.client_id,
    client_name: r.client_name,
    billing_model: r.billing_model,
    job_type: r.job_type,
    lead_source: r.lead_source,
    property_address: r.property_address,
    property_city: r.property_city,
    property_state: r.property_state,
    property_zip: r.property_zip,
    contract_total: r.contract_total,
    deposit_amount: r.deposit_amount,
    deposit_paid: (r.deposit_paid ?? 0) === 1,
    start_date: r.start_date,
    target_end_date: r.target_end_date,
    actual_end_date: r.actual_end_date,
    portal_token: r.portal_token,
    portal_type: r.portal_type,
    // The post-sale client portal view (/portal/:token) is later-sprint work and
    // has no route yet, so we surface no link. portal_token stays on the row
    // (selected above) for that future portal; we just don't advertise a path.
    portal_path: null,
    conversion_complete: (r.conversion_complete ?? 0) === 1,
    estimate_id: r.estimate_id,
    days_in_status: daysSince(r.status_since),
    photo_count: 0, // stub until Sprint 8
    overdue,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ─── GET /api/jobs ──────────────────────────────────────────────────────────

export async function handleJobList(env: Env, url: URL): Promise<Response> {
  const status = url.searchParams.get("status");
  const jobType = url.searchParams.get("job_type");
  const clientId = url.searchParams.get("client_id");
  const billingModel = url.searchParams.get("billing_model");

  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    where.push("j.status = ?");
    binds.push(status);
  }
  if (jobType) {
    where.push("j.job_type = ?");
    binds.push(jobType);
  }
  if (clientId) {
    where.push("j.client_id = ?");
    binds.push(clientId);
  }
  if (billingModel) {
    where.push("j.billing_model = ?");
    binds.push(billingModel);
  }

  const sql = `${JOB_SELECT}${where.length ? " AND " + where.join(" AND ") : ""} ORDER BY j.created_at DESC`;
  const rows = (await env.DB.prepare(sql).bind(...binds).all<JobListRow>()).results ?? [];

  return json({ as_of: new Date().toISOString(), total: rows.length, jobs: rows.map(shapeJobCard) });
}

// ─── GET /api/jobs/pipeline ───────────────────────────────────────────────────

export async function handleJobPipeline(env: Env): Promise<Response> {
  const rows = (await env.DB.prepare(`${JOB_SELECT} ORDER BY j.created_at DESC`).all<JobListRow>())
    .results ?? [];
  const cards = rows.map(shapeJobCard);

  const pipeline: Record<string, ReturnType<typeof shapeJobCard>[]> = {};
  const counts: Record<string, number> = {};
  for (const s of JOB_STATUSES) {
    pipeline[s] = [];
    counts[s] = 0;
  }
  for (const card of cards) {
    const s = String(card.status ?? "");
    if (s in pipeline) {
      pipeline[s].push(card);
      counts[s]++;
    }
  }

  return json({
    as_of: new Date().toISOString(),
    statuses: JOB_STATUSES,
    counts,
    pipeline,
  });
}

// ─── GET /api/jobs/:id ────────────────────────────────────────────────────────

export async function handleJobDetail(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    `${JOB_SELECT.replace("WHERE j.source = 'estimate'", "WHERE j.id = ? AND j.source = 'estimate'")}`,
  )
    .bind(id)
    .first<JobListRow & { client_name: string | null }>();
  if (!row) return err(404, "not_found", "Job not found.");

  // Client contact (for the Overview tab).
  const client = row.client_id
    ? await env.DB.prepare(
        "SELECT name, first_name, last_name, phone, email FROM clients WHERE id = ?",
      )
        .bind(row.client_id)
        .first<{
          name: string | null;
          first_name: string | null;
          last_name: string | null;
          phone: string | null;
          email: string | null;
        }>()
    : null;

  // Deposit paid to date (fee-excluded contract-applicable amount per decision (b)).
  const depositRow = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE job_id = ?",
  )
    .bind(id)
    .first<{ paid: number }>();

  const tasks = await loadTasksGrouped(env, id, null, null);
  const billing = (
    await env.DB.prepare(
      "SELECT id, billing_model, sequence, label, trigger_type, trigger_ref, percentage, amount, period_start, period_end, status FROM billing_schedule WHERE job_id = ? ORDER BY sequence ASC",
    )
      .bind(id)
      .all<Record<string, unknown>>()
  ).results ?? [];

  const activity = (
    await env.DB.prepare(
      `SELECT id, user_email, action, details, created_at FROM audit_logs
       WHERE entity_type = 'job' AND entity_id = ?
       ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(id)
      .all<Record<string, unknown>>()
  ).results ?? [];

  const card = shapeJobCard(row);
  const clientName =
    [client?.first_name, client?.last_name].filter(Boolean).join(" ").trim() ||
    client?.name ||
    card.client_name;

  // Surface conversion_reversed (carry-forward: not previously returned here) so
  // the owner UI can flag a reversed/on-hold job, and build the client portal URL
  // (Sprint 12) from the SAME public origin pay/quote links use.
  const reversal = await env.DB.prepare(
    "SELECT conversion_reversed, reversal_reason FROM jobs WHERE id = ?",
  )
    .bind(id)
    .first<{ conversion_reversed: number | null; reversal_reason: string | null }>();
  const origin = (env.APP_PUBLIC_ORIGIN ?? "https://client.homesolutionsar.com").replace(/\/$/, "");
  const portalUrl = card.portal_token ? `${origin}/portal/${card.portal_token}` : null;

  return json({
    job: {
      ...card,
      client_name: clientName,
      client_phone: client?.phone ?? null,
      client_email: client?.email ?? null,
      conversion_reversed: (reversal?.conversion_reversed ?? 0) === 1,
      reversal_reason: reversal?.reversal_reason ?? null,
      portal_url: portalUrl,
    },
    financial: {
      contract_total: card.contract_total,
      deposit_amount: card.deposit_amount,
      deposit_paid_to_date: round2(depositRow?.paid ?? 0),
    },
    task_groups: tasks,
    billing_schedule: billing,
    activity,
  });
}

// ─── PUT /api/jobs/:id ────────────────────────────────────────────────────────

export async function handleJobUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  if ("status" in body) {
    return err(
      400,
      "use_status_endpoint",
      "Status changes go through PUT /api/jobs/:id/status, which validates transitions.",
    );
  }

  const job = await env.DB.prepare(
    "SELECT id FROM jobs WHERE id = ? AND source = 'estimate'",
  )
    .bind(id)
    .first<{ id: string }>();
  if (!job) return err(404, "not_found", "Job not found.");

  const sets: string[] = [];
  const binds: unknown[] = [];
  const editable: Record<string, "str"> = {
    title: "str",
    notes: "str",
    start_date: "str",
    target_end_date: "str",
    actual_end_date: "str",
  };
  for (const [field] of Object.entries(editable)) {
    if (field in body) {
      sets.push(`${field} = ?`);
      binds.push(str(body[field]));
    }
  }
  if (sets.length === 0) return err(400, "bad_request", "No editable fields provided.");

  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());
  binds.push(id);

  await env.DB.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  await logAudit(env, user.email, "job_updated", "job", id, {
    fields: Object.keys(editable).filter((f) => f in body),
  });

  return handleJobDetail(env, id);
}

// ─── PUT /api/jobs/:id/status ─────────────────────────────────────────────────

export async function handleJobStatus(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");
  const target = str(body.status);
  if (!target || !(target in STATUS_INDEX)) {
    return err(400, "bad_request", `status must be one of: ${JOB_STATUSES.join(", ")}`);
  }

  const job = await env.DB.prepare(
    "SELECT id, status FROM jobs WHERE id = ? AND source = 'estimate'",
  )
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!job) return err(404, "not_found", "Job not found.");

  const from = job.status;
  if (from === target) return err(400, "no_change", "Job is already in that status.");

  const fromIdx = STATUS_INDEX[from] ?? -1;
  const toIdx = STATUS_INDEX[target];
  const isForward = fromIdx >= 0 && toIdx > fromIdx;
  const isAllowedBackward = BACKWARD_EXCEPTIONS.has(`${from}>${target}`);
  if (!isForward && !isAllowedBackward) {
    return err(
      400,
      "illegal_transition",
      `Cannot move from ${from} to ${target}. Jobs move forward only (allowed backward: in_progress→scheduled, complete→punch_list).`,
    );
  }

  // Gate → complete: all punch-list items must be complete (§6.9).
  if (target === "complete") {
    const open = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE job_id = ? AND is_punch_list = 1 AND status != 'complete'",
    )
      .bind(id)
      .first<{ n: number }>();
    if ((open?.n ?? 0) > 0) {
      return err(
        409,
        "open_punch_list",
        `Cannot complete: ${open!.n} punch-list item(s) still open.`,
      );
    }
  }

  // Gate → closed: no invoice with an outstanding balance (§6.10 / Sprint 9).
  // Outstanding = an ISSUED, non-void invoice whose collected payments are less
  // than its total_due. Void invoices are settled-or-dead (preserved, no balance)
  // and drafts are not yet real obligations, so neither blocks the close.
  if (target === "closed") {
    const unpaid = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM invoices i
        WHERE i.job_id = ?
          AND i.status NOT IN ('void', 'draft')
          AND COALESCE(i.total_due, i.amount, 0)
              > COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) + 0.005`,
    )
      .bind(id)
      .first<{ n: number }>();
    if ((unpaid?.n ?? 0) > 0) {
      return err(
        409,
        "unpaid_invoices",
        `Cannot close: ${unpaid!.n} invoice(s) still have an outstanding balance.`,
      );
    }
  }

  const nowIso = new Date().toISOString();
  // actual_end_date is stamped when the job first reaches complete.
  const setActualEnd = target === "complete";
  await env.DB.prepare(
    `UPDATE jobs SET status = ?, updated_at = ?${setActualEnd ? ", actual_end_date = COALESCE(actual_end_date, ?)" : ""} WHERE id = ?`,
  )
    .bind(...(setActualEnd ? [target, nowIso, nowIso.slice(0, 10), id] : [target, nowIso, id]))
    .run();

  await logAudit(env, user.email, "job_status_changed", "job", id, { from, to: target });
  triggerJobStatusChanged(env, id, from, target);

  return handleJobDetail(env, id);
}

/**
 * Reverse a job conversion (un-win) — owner only. The manual counterpart to the
 * Stripe refund/dispute webhook branch; both call the SAME reverseJobConversion()
 * (src/lib/quote-to-job.ts), which FLAGS-AND-PRESERVES: the job is kept and
 * flagged, its open invoices are voided (preserved), payments are untouched.
 */
export async function handleJobReverseConversion(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...REVERSE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  const reason = (body ? str(body.reason) : null) ?? "manual_reversal";

  const outcome = await reverseJobConversion(env, id, reason, user.email);
  if (!outcome.ok) return err(outcome.status, outcome.error, outcome.details);

  return handleJobDetail(env, id);
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  job_id: string;
  task_group: string;
  task_group_order: number;
  title: string;
  status: string;
  assigned_to: string | null;
  scheduled_date: string | null;
  completed_date: string | null;
  completed_by: string | null;
  notes: string | null;
  sort_order: number;
  is_punch_list: number | null;
  created_at: string | null;
}

function shapeTask(r: TaskRow) {
  return {
    id: r.id,
    job_id: r.job_id,
    task_group: r.task_group,
    task_group_order: r.task_group_order,
    title: r.title,
    status: r.status,
    assigned_to: r.assigned_to,
    scheduled_date: r.scheduled_date,
    completed_date: r.completed_date,
    completed_by: r.completed_by,
    notes: r.notes,
    sort_order: r.sort_order,
    is_punch_list: (r.is_punch_list ?? 0) === 1,
    created_at: r.created_at,
  };
}

/** Tasks grouped by task_group, ordered by task_group_order then sort_order. */
async function loadTasksGrouped(
  env: Env,
  jobId: string,
  status: string | null,
  taskGroup: string | null,
): Promise<{ group: string; group_order: number; tasks: ReturnType<typeof shapeTask>[] }[]> {
  const where = ["job_id = ?"];
  const binds: unknown[] = [jobId];
  if (status) {
    where.push("status = ?");
    binds.push(status);
  }
  if (taskGroup) {
    where.push("task_group = ?");
    binds.push(taskGroup);
  }
  const rows =
    (
      await env.DB.prepare(
        `SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY task_group_order ASC, sort_order ASC, created_at ASC`,
      )
        .bind(...binds)
        .all<TaskRow>()
    ).results ?? [];

  const groups = new Map<string, { group: string; group_order: number; tasks: ReturnType<typeof shapeTask>[] }>();
  for (const r of rows) {
    let g = groups.get(r.task_group);
    if (!g) {
      g = { group: r.task_group, group_order: r.task_group_order, tasks: [] };
      groups.set(r.task_group, g);
    }
    g.tasks.push(shapeTask(r));
  }
  return [...groups.values()].sort((a, b) => a.group_order - b.group_order);
}

export async function handleTaskList(env: Env, jobId: string, url: URL): Promise<Response> {
  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
  if (!job) return err(404, "not_found", "Job not found.");
  const groups = await loadTasksGrouped(
    env,
    jobId,
    url.searchParams.get("status"),
    url.searchParams.get("task_group"),
  );
  return json({ job_id: jobId, task_groups: groups });
}

export async function handleTaskCreate(request: Request, env: Env, jobId: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
  if (!job) return err(404, "not_found", "Job not found.");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");
  const title = str(body.title);
  const taskGroup = str(body.task_group);
  if (!title || !taskGroup) return err(400, "bad_request", "title and task_group are required.");

  // New group inherits the next group_order; existing group reuses its order.
  const existing = await env.DB.prepare(
    "SELECT task_group_order FROM tasks WHERE job_id = ? AND task_group = ? LIMIT 1",
  )
    .bind(jobId, taskGroup)
    .first<{ task_group_order: number }>();
  let groupOrder: number;
  if (existing) {
    groupOrder = existing.task_group_order;
  } else {
    const maxRow = await env.DB.prepare(
      "SELECT COALESCE(MAX(task_group_order), -1) AS m FROM tasks WHERE job_id = ?",
    )
      .bind(jobId)
      .first<{ m: number }>();
    groupOrder = (maxRow?.m ?? -1) + 1;
  }

  const sortOrder =
    body.sort_order != null && Number.isFinite(Number(body.sort_order))
      ? Number(body.sort_order)
      : await nextSortOrder(env, jobId, taskGroup);

  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO tasks (id, job_id, task_group, task_group_order, title, status, assigned_to, scheduled_date, notes, sort_order, is_punch_list, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      jobId,
      taskGroup,
      groupOrder,
      title,
      str(body.assigned_to),
      str(body.scheduled_date),
      str(body.notes),
      sortOrder,
      body.is_punch_list ? 1 : 0,
      nowIso,
    )
    .run();

  await logAudit(env, user.email, "task_created", "job", jobId, { task_id: id, task_group: taskGroup, title });
  return json({ task: await loadTask(env, id) }, { status: 201 });
}

export async function handleTaskUpdate(request: Request, env: Env, taskId: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await loadTask(env, taskId);
  if (!existing) return err(404, "not_found", "Task not found.");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const sets: string[] = [];
  const binds: unknown[] = [];
  const strFields = ["title", "task_group", "assigned_to", "scheduled_date", "notes"];
  for (const f of strFields) {
    if (f in body) {
      sets.push(`${f} = ?`);
      binds.push(str(body[f]));
    }
  }
  if ("sort_order" in body && Number.isFinite(Number(body.sort_order))) {
    sets.push("sort_order = ?");
    binds.push(Number(body.sort_order));
  }
  if ("is_punch_list" in body) {
    sets.push("is_punch_list = ?");
    binds.push(body.is_punch_list ? 1 : 0);
  }
  if ("status" in body) {
    const s = str(body.status);
    const valid = new Set(["pending", "in_progress", "complete", "skipped"]);
    if (!s || !valid.has(s)) return err(400, "bad_request", "Invalid task status.");
    sets.push("status = ?");
    binds.push(s);
    // Keep completion stamps consistent when status is set directly.
    if (s === "complete") {
      sets.push("completed_date = COALESCE(completed_date, ?)", "completed_by = COALESCE(completed_by, ?)");
      binds.push(new Date().toISOString(), user.email);
    } else {
      sets.push("completed_date = NULL", "completed_by = NULL");
    }
  }
  // If task_group changes to a brand-new group, give it the next group order.
  if ("task_group" in body) {
    const newGroup = str(body.task_group);
    if (newGroup) {
      const sib = await env.DB.prepare(
        "SELECT task_group_order FROM tasks WHERE job_id = ? AND task_group = ? AND id != ? LIMIT 1",
      )
        .bind(existing.job_id, newGroup, taskId)
        .first<{ task_group_order: number }>();
      let order = sib?.task_group_order;
      if (order == null) {
        const maxRow = await env.DB.prepare(
          "SELECT COALESCE(MAX(task_group_order), -1) AS m FROM tasks WHERE job_id = ?",
        )
          .bind(existing.job_id)
          .first<{ m: number }>();
        order = (maxRow?.m ?? -1) + 1;
      }
      sets.push("task_group_order = ?");
      binds.push(order);
    }
  }

  if (sets.length === 0) return err(400, "bad_request", "No updatable fields provided.");
  binds.push(taskId);
  await env.DB.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  await logAudit(env, user.email, "task_updated", "job", existing.job_id, { task_id: taskId });

  return json({ task: await loadTask(env, taskId) });
}

export async function handleTaskComplete(request: Request, env: Env, taskId: string): Promise<Response> {
  const guarded = await guard(request, env, ["owner", "project_manager", "office_admin", "field_crew"]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await loadTask(env, taskId);
  if (!existing) return err(404, "not_found", "Task not found.");

  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE tasks SET status = 'complete', completed_date = ?, completed_by = ? WHERE id = ?",
  )
    .bind(nowIso, user.email, taskId)
    .run();
  await logAudit(env, user.email, "task_completed", "job", existing.job_id, {
    task_id: taskId,
    task_group: existing.task_group,
  });

  return json({ task: await loadTask(env, taskId) });
}

async function loadTask(env: Env, taskId: string): Promise<ReturnType<typeof shapeTask> | null> {
  const r = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<TaskRow>();
  return r ? shapeTask(r) : null;
}

async function nextSortOrder(env: Env, jobId: string, taskGroup: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) AS m FROM tasks WHERE job_id = ? AND task_group = ?",
  )
    .bind(jobId, taskGroup)
    .first<{ m: number }>();
  return (row?.m ?? -1) + 1;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
