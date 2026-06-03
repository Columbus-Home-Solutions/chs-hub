/**
 * Audit-log helper (Sprint 17).
 *
 * Prior sprints already write to `audit_logs` on state transitions (settings
 * update, completion-package send, etc.) with ad-hoc inline INSERTs. This is the
 * single shared writer the System-Admin routes use, so the actor + shape stay
 * consistent and the audit viewer can rely on it (business rule 3 / 4).
 *
 * Shape matches the `audit_logs` table (migration 0019):
 *   id, user_email, action, entity_type, entity_id, details(JSON), ip_address, created_at
 */

import type { Env } from "../env.js";

export interface AuditEntry {
  userEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  details?: unknown;
  ipAddress?: string | null;
}

export async function writeAudit(env: Env, entry: AuditEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      entry.userEmail,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.details === undefined ? null : JSON.stringify(entry.details),
      entry.ipAddress ?? null,
    )
    .run();
}

/** Pull the actor email from a request the RBAC gate has already resolved. */
export function actorEmail(request: Request): string {
  const u = (request as Request & { user?: { email?: string } }).user;
  return (
    u?.email ??
    request.headers.get("Cf-Access-Authenticated-User-Email") ??
    "system"
  );
}
