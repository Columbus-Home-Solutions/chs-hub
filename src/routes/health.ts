/**
 * System-health panel — Sprint 17 (Owner-only via RBAC gate, read-only).
 *
 *   GET /api/health   heartbeat status, the 5 real cron triggers + last run,
 *                     integration sync status, DLQ open count, last backup.
 *
 * Surfaces the existing reliability subsystem — it changes nothing. Tokens are
 * NEVER included (business rule 5): integration rows are read without the
 * access_token/refresh_token columns.
 *
 * NOTE: the account is capped at 5 Cloudflare cron triggers (Free plan). The
 * panel reports those 5 — it does NOT add one.
 */

import type { Env } from "../env.js";
import { checkHeartbeat } from "../lib/ops/heartbeat.js";
import { getDlqSummary } from "../lib/ops/dlq.js";
import { getLatestBackup } from "../lib/ops/backup.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

// The 5 physical cron triggers wired in wrangler.toml / src/index.ts. The Route
// Map's longer "logical jobs" list is superseded by this 5-trigger reality —
// several jobs piggyback inside a single trigger (5-cron Free-plan cap).
const CRON_TRIGGERS = [
  { cron: "*/15 * * * *", label: "Notifications + social publisher", jobs: ["notifications", "social_publish"] },
  { cron: "*/30 * * * *", label: "Jobber sync + WC spreadsheet export", jobs: ["jobber_full", "wc_spreadsheet"] },
  { cron: "15 * * * *", label: "Heartbeat + DLQ replay + Drive mirror", jobs: ["heartbeat", "dlq_replay", "drive_mirror"] },
  { cron: "15 7 * * *", label: "Nightly backup + invoice billing + QBO sync", jobs: ["backup", "invoice_billing", "qbo_sync"] },
  { cron: "0 12 * * *", label: "Daily summary email (07:00 Central)", jobs: ["daily_summary"] },
];

interface SyncLogRow {
  job_name: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
}

export async function handleAdminHealth(env: Env): Promise<Response> {
  // D1 + R2 connectivity.
  const subsystems: Record<string, { status: string; detail?: string; latency_ms?: number }> = {};
  try {
    const t0 = Date.now();
    const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    subsystems.d1 = row?.ok === 1 ? { status: "connected", latency_ms: Date.now() - t0 } : { status: "error" };
  } catch (err) {
    subsystems.d1 = { status: "error", detail: (err as Error).message };
  }
  try {
    const t0 = Date.now();
    await env.FILES.head("__healthcheck__");
    subsystems.r2 = { status: "connected", latency_ms: Date.now() - t0 };
  } catch (err) {
    subsystems.r2 = { status: "error", detail: (err as Error).message };
  }

  // Heartbeat (Jobber sync freshness).
  let heartbeat: unknown = null;
  try {
    heartbeat = await checkHeartbeat(env);
  } catch (err) {
    heartbeat = { healthy: false, error: (err as Error).message };
  }

  // Recent per-job runs from sync_log → annotate each cron trigger.
  let recent: SyncLogRow[] = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT job_name, status, started_at, finished_at, error_message
         FROM sync_log
        WHERE started_at >= datetime('now', '-2 days')
        ORDER BY started_at DESC`,
    ).all<SyncLogRow>();
    recent = results ?? [];
  } catch {
    recent = [];
  }
  const lastByJob: Record<string, SyncLogRow> = {};
  for (const r of recent) {
    if (!lastByJob[r.job_name]) lastByJob[r.job_name] = r;
  }
  const crons = CRON_TRIGGERS.map((c) => ({
    ...c,
    last_runs: c.jobs.map((j) => {
      const row = lastByJob[j];
      return {
        job: j,
        status: row?.status ?? "unknown",
        last_run_at: row?.started_at ?? null,
        error: row?.error_message ?? null,
      };
    }),
  }));

  // DLQ open count.
  let dlq: unknown = null;
  try {
    dlq = await getDlqSummary(env);
  } catch (err) {
    dlq = { error: (err as Error).message };
  }

  // Last backup.
  let backup: unknown = null;
  try {
    const latest = await getLatestBackup(env);
    backup = latest
      ? {
          key: latest.key,
          uploaded_at: latest.uploaded_at,
          size_kb: Math.round(latest.size_bytes / 1024),
          age_hours: Math.round(((Date.now() - new Date(latest.uploaded_at).getTime()) / 3.6e6) * 10) / 10,
        }
      : null;
  } catch (err) {
    backup = { error: (err as Error).message };
  }

  // Integration sync status — token columns intentionally NOT selected.
  let integrations: unknown[] = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT service, status, last_sync, last_error, connected_at
         FROM integration_connections ORDER BY service`,
    ).all<Record<string, unknown>>();
    integrations = results ?? [];
  } catch {
    integrations = [];
  }

  return json({
    ok: subsystems.d1?.status === "connected" && subsystems.r2?.status === "connected",
    timestamp: new Date().toISOString(),
    subsystems,
    heartbeat,
    cron_triggers: crons,
    cron_count: CRON_TRIGGERS.length,
    dlq,
    backup,
    integrations,
  });
}
