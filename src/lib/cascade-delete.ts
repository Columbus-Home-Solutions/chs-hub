/**
 * Hard-delete cascades for estimates, jobs, and clients (pre-launch cleanup).
 * Child rows are removed in FK-safe order; optional tables are skipped on error.
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

/** Audit rows keyed by entity_id (job, client, estimate, etc.). */
export async function deleteAuditLogsForEntity(env: Env, entityId: string): Promise<void> {
  await runDelete(env, "DELETE FROM audit_logs WHERE entity_id = ?", entityId);
}

/** Break circular / user FK references before DELETE FROM jobs. */
export async function unlinkJobForDelete(env: Env, jobId: string): Promise<void> {
  await runUpdate(
    env,
    "UPDATE estimate_requests SET converted_job_id = NULL WHERE converted_job_id = ?",
    jobId,
  );
  await runUpdate(env, "UPDATE jobs SET created_by = NULL WHERE id = ?", jobId);
}

/** notification_logs → communications for a job. */
async function deleteJobCommunications(env: Env, jobId: string): Promise<void> {
  await runDelete(
    env,
    `DELETE FROM notification_logs
     WHERE communication_id IN (SELECT id FROM communications WHERE job_id = ?)`,
    jobId,
  );
  await runDelete(env, "DELETE FROM notification_logs WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM communications WHERE job_id = ?", jobId);
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

/** Remove all dependent rows for a job (does not delete the job row). */
export async function cascadeDeleteJobChildren(env: Env, jobId: string): Promise<void> {
  await runDelete(env, "DELETE FROM notification_logs WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM time_entries WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM expenses WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM payments WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM invoices WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM change_orders WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM schedule_entries WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM tasks WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM daily_logs WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM job_files WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM photos WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM notes WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM lien_waivers WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM warranties WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM job_documents WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM billing_cycles WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM billing_schedule WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM permits WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM warranty_calls WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM smart_notes WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM mileage WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM documents WHERE job_id = ?", jobId);
  await runDelete(env, "DELETE FROM social_posts WHERE job_id = ?", jobId);
  await deleteJobCommunications(env, jobId);
}

/** Full job cascade: children, unlink FKs, audit log — caller deletes the job row. */
export async function cascadeDeleteJob(env: Env, jobId: string): Promise<void> {
  await cascadeDeleteJobChildren(env, jobId);
  await unlinkJobForDelete(env, jobId);
  await deleteAuditLogsForEntity(env, jobId);
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
