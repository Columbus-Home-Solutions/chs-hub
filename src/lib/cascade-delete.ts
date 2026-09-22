/**
 * Hard-delete cascades for estimates, jobs, and clients (pre-launch cleanup).
 * Child rows are removed in FK-safe order.
 *
 * Job deletes use required steps that surface the failing table instead of
 * swallowing errors and then 500-ing on DELETE FROM jobs.
 */

import type { Env } from "../env.js";

/** Native in-progress job statuses — matches clients.ts ACTIVE_JOB_STATUSES. */
export const NATIVE_ACTIVE_JOB_STATUSES = [
  "deposit_paid",
  "scheduled",
  "in_progress",
  "punch_list",
] as const;

/** Job statuses that may be hard-deleted via DELETE /api/jobs/:id. */
export const DELETABLE_JOB_STATUSES = new Set(["closed", "cancelled"]);

/** Thrown when a required cascade step fails — includes the table name. */
export class CascadeStepError extends Error {
  readonly table: string;
  constructor(table: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Cascade delete failed on ${table}: ${detail}`);
    this.name = "CascadeStepError";
    this.table = table;
  }
}

async function runDelete(env: Env, sql: string, ...binds: unknown[]): Promise<void> {
  try {
    await env.DB.prepare(sql).bind(...binds).run();
  } catch {
    // Table may not exist in older local DBs — skip gracefully.
  }
}

async function runUpdate(env: Env, sql: string, ...binds: unknown[]): Promise<void> {
  try {
    await env.DB.prepare(sql).bind(...binds).run();
  } catch {
    // Column/table may not exist in older local DBs — skip gracefully.
  }
}

/** Required delete for the job cascade path — never swallows real FK failures. */
async function runDeleteRequired(
  env: Env,
  table: string,
  sql: string,
  ...binds: unknown[]
): Promise<void> {
  try {
    await env.DB.prepare(sql).bind(...binds).run();
  } catch (e) {
    throw new CascadeStepError(table, e);
  }
}

async function runUpdateRequired(
  env: Env,
  table: string,
  sql: string,
  ...binds: unknown[]
): Promise<void> {
  try {
    await env.DB.prepare(sql).bind(...binds).run();
  } catch (e) {
    throw new CascadeStepError(table, e);
  }
}

/** Audit rows keyed by entity_id (job, client, estimate, etc.). */
export async function deleteAuditLogsForEntity(env: Env, entityId: string): Promise<void> {
  await runDelete(env, "DELETE FROM audit_logs WHERE entity_id = ?", entityId);
}

/** Break circular / user FK references before DELETE FROM jobs. */
export async function unlinkJobForDelete(env: Env, jobId: string): Promise<void> {
  await runUpdateRequired(
    env,
    "estimate_requests",
    "UPDATE estimate_requests SET converted_job_id = NULL WHERE converted_job_id = ?",
    jobId,
  );
  await runUpdateRequired(env, "users", "UPDATE users SET current_job_id = NULL WHERE current_job_id = ?", jobId);
  await runUpdateRequired(env, "jobs", "UPDATE jobs SET created_by = NULL WHERE id = ?", jobId);
  // Nullable estimate-scoped FKs — clear rather than delete the parent row.
  await runUpdateRequired(env, "bid_requests", "UPDATE bid_requests SET job_id = NULL WHERE job_id = ?", jobId);
  await runUpdateRequired(env, "selections", "UPDATE selections SET job_id = NULL WHERE job_id = ?", jobId);
  await runUpdateRequired(env, "quotes", "UPDATE quotes SET job_id = NULL WHERE job_id = ?", jobId);
}

/** notification_logs → communications for a job (required). */
async function deleteJobCommunicationsRequired(env: Env, jobId: string): Promise<void> {
  await runDeleteRequired(
    env,
    "notification_logs",
    `DELETE FROM notification_logs
     WHERE communication_id IN (SELECT id FROM communications WHERE job_id = ?)`,
    jobId,
  );
  await runDeleteRequired(env, "notification_logs", "DELETE FROM notification_logs WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "communications", "DELETE FROM communications WHERE job_id = ?", jobId);
}

/** notification_logs → communications for a client. */
async function deleteClientCommunications(env: Env, clientId: string): Promise<void> {
  await runDelete(
    env,
    `DELETE FROM notification_logs
     WHERE communication_id IN (SELECT id FROM communications WHERE client_id = ?)`,
    clientId,
  );
  await runDelete(env, "DELETE FROM notification_logs WHERE client_id = ?", clientId);
  await runDelete(env, "DELETE FROM communications WHERE client_id = ?", clientId);
}

/**
 * Remove all dependent rows for a job (does not delete the job row).
 * Order is FK-safe for remote sqlite_master REFERENCES jobs + non-FK job_id cols.
 */
export async function cascadeDeleteJobChildren(env: Env, jobId: string): Promise<void> {
  // Messages first (notification_logs FK → communications + jobs).
  await deleteJobCommunicationsRequired(env, jobId);

  // Punch list items before punch lists / tasks.
  await runDeleteRequired(env, "punch_list_items", "DELETE FROM punch_list_items WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "punch_lists", "DELETE FROM punch_lists WHERE job_id = ?", jobId);

  // signature_events → job_documents (must precede job_documents).
  await runDeleteRequired(
    env,
    "signature_events",
    `DELETE FROM signature_events
     WHERE job_document_id IN (SELECT id FROM job_documents WHERE job_id = ?)`,
    jobId,
  );

  await runDeleteRequired(env, "time_entries", "DELETE FROM time_entries WHERE job_id = ?", jobId);

  // Soft-clear expense children that may block expense deletes (ignore missing tables).
  try {
    await env.DB.prepare(
      `UPDATE receipt_photos SET expense_id = NULL
       WHERE expense_id IN (SELECT id FROM expenses WHERE job_id = ?)`,
    )
      .bind(jobId)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/no such table/i.test(msg)) throw new CascadeStepError("receipt_photos", e);
  }
  try {
    await env.DB.prepare(
      `UPDATE expense_line_items SET expense_id = NULL
       WHERE expense_id IN (SELECT id FROM expenses WHERE job_id = ?)`,
    )
      .bind(jobId)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/no such table/i.test(msg)) throw new CascadeStepError("expense_line_items", e);
  }
  await runDeleteRequired(env, "expenses", "DELETE FROM expenses WHERE job_id = ?", jobId);

  await runDeleteRequired(env, "payments", "DELETE FROM payments WHERE job_id = ?", jobId);
  await runDeleteRequired(
    env,
    "client_lien_waivers",
    "DELETE FROM client_lien_waivers WHERE job_id = ?",
    jobId,
  );
  await runDeleteRequired(env, "invoices", "DELETE FROM invoices WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "change_orders", "DELETE FROM change_orders WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "schedule_entries", "DELETE FROM schedule_entries WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "tasks", "DELETE FROM tasks WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "daily_logs", "DELETE FROM daily_logs WHERE job_id = ?", jobId);

  // Non-FK job_id columns (notes, job_files, photos).
  await runDeleteRequired(env, "job_files", "DELETE FROM job_files WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "photos", "DELETE FROM photos WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "notes", "DELETE FROM notes WHERE job_id = ?", jobId);

  await runDeleteRequired(env, "lien_waivers", "DELETE FROM lien_waivers WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "warranties", "DELETE FROM warranties WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "job_documents", "DELETE FROM job_documents WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "billing_cycles", "DELETE FROM billing_cycles WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "billing_schedule", "DELETE FROM billing_schedule WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "permits", "DELETE FROM permits WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "warranty_calls", "DELETE FROM warranty_calls WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "smart_notes", "DELETE FROM smart_notes WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "mileage", "DELETE FROM mileage WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "documents", "DELETE FROM documents WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "social_posts", "DELETE FROM social_posts WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "line_items", "DELETE FROM line_items WHERE job_id = ?", jobId);
  await runDeleteRequired(env, "files", "DELETE FROM files WHERE job_id = ?", jobId);
}

/**
 * Real clients with live money cannot be hard-deleted.
 * Returns the 409 message, or null when the delete may proceed.
 * Test clients (is_test = 1) always proceed, including invoices and payments.
 * Void invoices alone do not block. Any payment does.
 */
export async function jobFinancialDeleteBlock(
  env: Env,
  jobId: string,
  clientId: string | null,
): Promise<string | null> {
  if (clientId) {
    const client = await env.DB.prepare(
      "SELECT COALESCE(is_test, 0) AS is_test FROM clients WHERE id = ?",
    )
      .bind(clientId)
      .first<{ is_test: number }>();
    if (client && Number(client.is_test) === 1) return null;
  }

  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM invoices
         WHERE job_id = ? AND COALESCE(status, '') != 'void') AS open_invoices,
       (SELECT COUNT(*) FROM payments
         WHERE job_id = ?
            OR invoice_id IN (SELECT id FROM invoices WHERE job_id = ?)) AS payments`,
  )
    .bind(jobId, jobId, jobId)
    .first<{ open_invoices: number; payments: number }>();

  if ((row?.open_invoices ?? 0) > 0 || (row?.payments ?? 0) > 0) {
    return "Job has invoices/payments; void them first or keep the job";
  }
  return null;
}

/** Full job cascade: children and unlink FKs. Does not touch audit_logs. Caller deletes the job row and writes job_deleted. */
export async function cascadeDeleteJob(env: Env, jobId: string): Promise<void> {
  await cascadeDeleteJobChildren(env, jobId);
  await unlinkJobForDelete(env, jobId);
}

/** Notification + comms rows that reference a client — run before estimate_requests. */
export async function cascadeDeleteClientPreRequestRecords(env: Env, clientId: string): Promise<void> {
  await deleteClientCommunications(env, clientId);
}

/** Per-request notification logs — run before estimate_requests row delete. */
export async function cascadeDeleteEstimateRequestRecords(env: Env, requestId: string): Promise<void> {
  await runDelete(env, "DELETE FROM notification_logs WHERE estimate_request_id = ?", requestId);
}

/** Remove all estimates + dependent rows for a request (does not delete the request). */
export async function cascadeDeleteEstimatesForRequest(
  env: Env,
  requestId: string,
): Promise<number> {
  const estimates = (
    await env.DB.prepare("SELECT id FROM estimates WHERE request_id = ?")
      .bind(requestId)
      .all<{ id: string }>()
  ).results ?? [];

  for (const est of estimates) {
    await runUpdate(env, "UPDATE jobs SET estimate_id = NULL WHERE estimate_id = ?", est.id);
    await cascadeDeleteEstimateChildren(env, est.id);
    await runDelete(env, "DELETE FROM estimates WHERE id = ?", est.id);
  }

  return estimates.length;
}

/** Full estimate-request cascade — caller deletes the estimate_requests row. */
export async function cascadeDeleteEstimateRequest(
  env: Env,
  requestId: string,
): Promise<{ estimates_removed: number }> {
  const estimates_removed = await cascadeDeleteEstimatesForRequest(env, requestId);
  await cascadeDeleteEstimateRequestRecords(env, requestId);
  await runDelete(env, "DELETE FROM photos WHERE estimate_request_id = ?", requestId);
  await deleteAuditLogsForEntity(env, requestId);
  return { estimates_removed };
}

/** Remove estimate children (line items, sub-items, payment schedule, docs). */
export async function cascadeDeleteEstimateChildren(env: Env, estimateId: string): Promise<void> {
  await runDelete(
    env,
    `DELETE FROM estimate_sub_items
     WHERE parent_line_item_id IN (SELECT id FROM estimate_line_items WHERE estimate_id = ?)`,
    estimateId,
  );
  await runDelete(env, "DELETE FROM estimate_line_items WHERE estimate_id = ?", estimateId);
  await runDelete(env, "DELETE FROM payment_schedules WHERE estimate_id = ?", estimateId);
  await runDelete(env, "DELETE FROM payments WHERE estimate_id = ?", estimateId);
  await runDelete(env, "DELETE FROM documents WHERE estimate_id = ?", estimateId);
  await deleteAuditLogsForEntity(env, estimateId);
}

/** Full client cascade (hard delete). Caller writes the audit log entry. */
export async function cascadeDeleteClient(
  env: Env,
  clientId: string,
): Promise<{ jobs_removed: number; estimates_removed: number }> {
  const jobs = (
    await env.DB.prepare("SELECT id, estimate_id FROM jobs WHERE client_id = ?")
      .bind(clientId)
      .all<{ id: string; estimate_id: string | null }>()
  ).results ?? [];

  for (const job of jobs) {
    await cascadeDeleteJob(env, job.id);
    await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(job.id).run();
    if (job.estimate_id) {
      await runUpdate(env, "UPDATE estimates SET status = 'archived' WHERE id = ?", job.estimate_id);
    }
  }

  const estimates = (
    await env.DB.prepare("SELECT id FROM estimates WHERE client_id = ?")
      .bind(clientId)
      .all<{ id: string }>()
  ).results ?? [];

  for (const est of estimates) {
    await cascadeDeleteEstimateChildren(env, est.id);
    await runUpdate(env, "UPDATE estimate_requests SET estimate_id = NULL WHERE estimate_id = ?", est.id);
    await env.DB.prepare("DELETE FROM estimates WHERE id = ?").bind(est.id).run();
  }

  const requests = (
    await env.DB.prepare("SELECT id FROM estimate_requests WHERE client_id = ?")
      .bind(clientId)
      .all<{ id: string }>()
  ).results ?? [];

  for (const req of requests) {
    await cascadeDeleteEstimateRequestRecords(env, req.id);
  }

  await cascadeDeleteClientPreRequestRecords(env, clientId);
  await env.DB.prepare("DELETE FROM estimate_requests WHERE client_id = ?").bind(clientId).run();
  await env.DB.prepare("DELETE FROM properties WHERE client_id = ?").bind(clientId).run();
  await deleteAuditLogsForEntity(env, clientId);
  await env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(clientId).run();

  return { jobs_removed: jobs.length, estimates_removed: estimates.length };
}
