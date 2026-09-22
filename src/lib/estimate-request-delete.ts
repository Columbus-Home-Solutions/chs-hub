/**
 * Hard-delete helpers for estimate_requests.
 *
 * Singular DELETE (existing pre-conversion cleanup) stays more permissive —
 * won/converted/approved are blocked in the route. Bulk-delete is New Request
 * only: junk that piled up before anyone looked at it.
 *
 * Orphan client cleanup is automatic on every successful request delete: if
 * the client has no remaining estimate_requests, estimates, or jobs, the
 * client row is removed too (Unknown Lead / phone-only spam records).
 */

import type { Env } from "../env.js";
import { cascadeDeleteClient, cascadeDeleteEstimateRequest } from "./cascade-delete.js";

export const CANNOT_DELETE_ACTIVE_LEAD = {
  error: "cannot_delete_active_lead",
  message:
    "Only New Request leads can be deleted this way. This lead has progressed in the pipeline.",
} as const;

export interface EstimateRequestDeleteRow {
  id: string;
  request_number: number;
  status: string;
  client_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  lead_source: string | null;
  source: string | null;
  estimate_id: string | null;
  converted_job_id: string | null;
  client_first: string | null;
  client_last: string | null;
  client_display_name: string | null;
  client_phone: string | null;
}

export interface DeleteLeadSuccess {
  ok: true;
  id: string;
  client_deleted: boolean;
  client_id: string | null;
  estimates_removed: number;
}

export interface DeleteLeadFailure {
  ok: false;
  id: string;
  status: number;
  error: string;
  message: string;
}

export type DeleteLeadResult = DeleteLeadSuccess | DeleteLeadFailure;

export function activeLeadDeleteError(status: string): { error: string; message: string } | null {
  if (status === "new_request") return null;
  return { error: CANNOT_DELETE_ACTIVE_LEAD.error, message: CANNOT_DELETE_ACTIVE_LEAD.message };
}

export function shouldDeleteOrphanClient(counts: {
  requests: number;
  estimates: number;
  jobs: number;
}): boolean {
  return counts.requests === 0 && counts.estimates === 0 && counts.jobs === 0;
}

function displayName(row: EstimateRequestDeleteRow): string {
  const parts = [row.client_first, row.client_last].filter(Boolean).join(" ").trim();
  if (parts) return parts;
  if (row.client_display_name?.trim()) return row.client_display_name.trim();
  if (row.contact_name?.trim()) return row.contact_name.trim();
  if (row.contact_phone?.trim()) return row.contact_phone.trim();
  return "(unnamed)";
}

function snapshotPhone(row: EstimateRequestDeleteRow): string | null {
  return row.client_phone ?? row.contact_phone ?? null;
}

async function writeAudit(
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

export async function loadEstimateRequestForDelete(
  env: Env,
  id: string,
): Promise<EstimateRequestDeleteRow | null> {
  const row = await env.DB.prepare(
    `SELECT er.*,
            c.first_name AS client_first, c.last_name AS client_last,
            c.name AS client_display_name, c.phone AS client_phone
       FROM estimate_requests er
       LEFT JOIN clients c ON c.id = er.client_id
      WHERE er.id = ?`,
  )
    .bind(id)
    .first<EstimateRequestDeleteRow & Record<string, unknown>>();
  if (!row) return null;
  return {
    id: String(row.id),
    request_number: Number(row.request_number),
    status: String(row.status),
    client_id: (row.client_id as string | null) ?? null,
    contact_name: (row.contact_name as string | null) ?? null,
    contact_phone: (row.contact_phone as string | null) ?? null,
    lead_source: (row.lead_source as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    estimate_id: (row.estimate_id as string | null) ?? null,
    converted_job_id: (row.converted_job_id as string | null) ?? null,
    client_first: (row.client_first as string | null) ?? null,
    client_last: (row.client_last as string | null) ?? null,
    client_display_name: (row.client_display_name as string | null) ?? null,
    client_phone: (row.client_phone as string | null) ?? null,
  };
}

export async function countClientAttachedRecords(
  env: Env,
  clientId: string,
): Promise<{ requests: number; estimates: number; jobs: number }> {
  const requests = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM estimate_requests WHERE client_id = ?",
  )
    .bind(clientId)
    .first<{ n: number }>();
  const estimates = await env.DB.prepare("SELECT COUNT(*) AS n FROM estimates WHERE client_id = ?")
    .bind(clientId)
    .first<{ n: number }>();
  const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE client_id = ?")
    .bind(clientId)
    .first<{ n: number }>();
  return {
    requests: Number(requests?.n ?? 0),
    estimates: Number(estimates?.n ?? 0),
    jobs: Number(jobs?.n ?? 0),
  };
}

/** Delete the client when nothing real remains attached. Caller already deleted the request. */
export async function maybeDeleteOrphanClient(
  env: Env,
  clientId: string,
  userEmail: string,
): Promise<boolean> {
  const counts = await countClientAttachedRecords(env, clientId);
  if (!shouldDeleteOrphanClient(counts)) return false;

  const client = await env.DB.prepare(
    "SELECT id, name, first_name, last_name, email, phone FROM clients WHERE id = ?",
  )
    .bind(clientId)
    .first<{
      id: string;
      name: string | null;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
    }>();
  if (!client) return false;

  const name =
    [client.first_name, client.last_name].filter(Boolean).join(" ").trim() ||
    client.name ||
    "(unnamed)";

  const { jobs_removed, estimates_removed } = await cascadeDeleteClient(env, clientId);

  await writeAudit(env, userEmail, "client_deleted", "client", clientId, {
    name,
    email: client.email,
    phone: client.phone,
    jobs_removed,
    estimates_removed,
    via: "orphan_after_estimate_request_delete",
  });

  return true;
}

/** Hard-delete one request (guards already applied) and clean up an orphaned client. */
export async function performEstimateRequestDelete(
  env: Env,
  row: EstimateRequestDeleteRow,
  userEmail: string,
): Promise<{ client_deleted: boolean; estimates_removed: number }> {
  const { estimates_removed } = await cascadeDeleteEstimateRequest(env, row.id);
  await env.DB.prepare("DELETE FROM estimate_requests WHERE id = ?").bind(row.id).run();

  await writeAudit(env, userEmail, "estimate_request_deleted", "estimate_request", row.id, {
    request_number: row.request_number,
    status: row.status,
    client_id: row.client_id,
    estimate_id: row.estimate_id,
    estimates_removed,
    name: displayName(row),
    phone: snapshotPhone(row),
    source: row.source ?? row.lead_source ?? null,
    lead_source: row.lead_source,
  });

  let client_deleted = false;
  if (row.client_id) {
    client_deleted = await maybeDeleteOrphanClient(env, row.client_id, userEmail);
  }

  return { client_deleted, estimates_removed };
}

/** Bulk path: every id is independently guarded to new_request. Failures skip, not abort. */
export async function deleteNewRequestLeads(
  env: Env,
  ids: string[],
  userEmail: string,
): Promise<{ deleted: DeleteLeadSuccess[]; skipped: DeleteLeadFailure[] }> {
  const deleted: DeleteLeadSuccess[] = [];
  const skipped: DeleteLeadFailure[] = [];

  for (const rawId of ids) {
    const id = String(rawId ?? "").trim();
    if (!id) {
      skipped.push({
        ok: false,
        id: rawId,
        status: 400,
        error: "bad_request",
        message: "Missing estimate request id",
      });
      continue;
    }

    const row = await loadEstimateRequestForDelete(env, id);
    if (!row) {
      skipped.push({
        ok: false,
        id,
        status: 404,
        error: "not_found",
        message: "Estimate request not found",
      });
      continue;
    }

    const blocked = activeLeadDeleteError(row.status);
    if (blocked) {
      skipped.push({
        ok: false,
        id,
        status: 409,
        error: blocked.error,
        message: blocked.message,
      });
      continue;
    }

    const result = await performEstimateRequestDelete(env, row, userEmail);
    deleted.push({
      ok: true,
      id,
      client_deleted: result.client_deleted,
      client_id: row.client_id,
      estimates_removed: result.estimates_removed,
    });
  }

  return { deleted, skipped };
}
