/**
 * Backup status + manual trigger — Sprint 17 (Owner-only via RBAC gate).
 *
 *   GET  /api/backup/status    last backup key/date/size from the existing
 *                              nightly D1 → R2 routine (backups/d1/*).
 *   POST /api/backup/trigger   synchronous, on-demand D1 → R2 export reusing
 *                              the SAME runBackup() the nightly cron calls.
 *                              This is NOT a new cron (Free-plan 5-cap is full).
 *
 * The backup subsystem (lib/ops/backup.ts) already runs nightly and alerts on
 * two consecutive failures (business rule 9) — this only surfaces it.
 */

import type { Env } from "../env.js";
import { getLatestBackup, runBackup } from "../lib/ops/backup.js";
import { writeAudit } from "../lib/audit.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

// ─── GET /api/backup/status ──────────────────────────────────────────────────

export async function handleBackupStatus(env: Env): Promise<Response> {
  const latest = await getLatestBackup(env);
  if (!latest) {
    return json({
      status: "none",
      last_backup: null,
      retention_days: 30,
      note: "No backup objects found under backups/d1/. The nightly cron writes one at 02:15 Central.",
    });
  }
  const ageMs = Date.now() - new Date(latest.uploaded_at).getTime();
  const ageHours = ageMs / (60 * 60 * 1000);
  return json({
    status: ageHours <= 26 ? "healthy" : "stale",
    last_backup: {
      key: latest.key,
      uploaded_at: latest.uploaded_at,
      size_bytes: latest.size_bytes,
      size_kb: Math.round(latest.size_bytes / 1024),
      age_hours: Math.round(ageHours * 10) / 10,
    },
    retention_days: 30,
  });
}

// ─── POST /api/backup/trigger ────────────────────────────────────────────────

export async function handleBackupTrigger(request: Request, env: Env): Promise<Response> {
  const result = await runBackup(env);

  const u = (request as Request & { user?: { email?: string } }).user;
  await writeAudit(env, {
    userEmail: u?.email ?? request.headers.get("Cf-Access-Authenticated-User-Email") ?? "owner",
    action: "backup.manual_trigger",
    entityType: "backup",
    entityId: result.key,
    details: { ok: result.ok, total_rows: result.total_rows, size_bytes: result.size_bytes, error: result.error ?? null },
    ipAddress: request.headers.get("cf-connecting-ip"),
  });

  return json(
    {
      ok: result.ok,
      key: result.key,
      total_rows: result.total_rows,
      size_bytes: result.size_bytes,
      size_kb: Math.round(result.size_bytes / 1024),
      retention_deleted: result.retention_deleted,
      duration_ms: result.duration_ms,
      error: result.error ?? null,
    },
    { status: result.ok ? 200 : 500 },
  );
}
