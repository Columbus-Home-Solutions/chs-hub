/**
 * Manual trigger + introspection routes for the reliability subsystem.
 *
 * All write/trigger endpoints require ?secret=<SYNC_TRIGGER_SECRET> or the
 * x-sync-token header. Read endpoints (DLQ summary, heartbeat status) are
 * gated the same way to keep the workers.dev URL safe — the dashboard
 * itself is behind Cloudflare Access so we don't need to worry about that.
 */

import type { Env } from "../env.js";
import { runBackup, getLatestBackup } from "../lib/ops/backup.js";
import { sendDailySummary } from "../lib/ops/daily-summary.js";
import { getDlqSummary, replayDeadLetters } from "../lib/ops/dlq.js";
import { checkHeartbeat } from "../lib/ops/heartbeat.js";
import { notify } from "../lib/ops/notify.js";

function requireSecret(request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  const secret =
    url.searchParams.get("secret") ?? request.headers.get("x-sync-token") ?? "";
  if (secret !== env.SYNC_TRIGGER_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  return null;
}

function jsonOk(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleHeartbeatCheck(
  request: Request,
  env: Env,
): Promise<Response> {
  const guard = requireSecret(request, env);
  if (guard) return guard;
  const status = await checkHeartbeat(env);
  return jsonOk(status);
}

export async function handleDlqSummary(
  request: Request,
  env: Env,
): Promise<Response> {
  const guard = requireSecret(request, env);
  if (guard) return guard;
  const summary = await getDlqSummary(env);
  return jsonOk(summary);
}

export async function handleDlqReplay(
  request: Request,
  env: Env,
): Promise<Response> {
  const guard = requireSecret(request, env);
  if (guard) return guard;
  const result = await replayDeadLetters(env);
  return jsonOk(result);
}

export async function handleBackupRun(
  request: Request,
  env: Env,
): Promise<Response> {
  const guard = requireSecret(request, env);
  if (guard) return guard;
  const result = await runBackup(env);
  return jsonOk(result, result.ok ? 200 : 500);
}

export async function handleBackupLatest(
  request: Request,
  env: Env,
): Promise<Response> {
  const guard = requireSecret(request, env);
  if (guard) return guard;
  const latest = await getLatestBackup(env);
  return jsonOk(latest ?? { latest: null });
}

export async function handleSummarySend(
  request: Request,
  env: Env,
): Promise<Response> {
  const guard = requireSecret(request, env);
  if (guard) return guard;
  const result = await sendDailySummary(env);
  return jsonOk(result);
}

export async function handleAlertTest(
  request: Request,
  env: Env,
): Promise<Response> {
  const guard = requireSecret(request, env);
  if (guard) return guard;
  const result = await notify(env, {
    severity: "info",
    subject: "Test notification",
    text: `Hello from chs-hub at ${new Date().toISOString()}.\n\nIf you're reading this, the notify pipeline is working.`,
  });
  return jsonOk(result);
}
