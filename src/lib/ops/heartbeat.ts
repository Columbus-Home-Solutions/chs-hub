/**
 * Sync heartbeat — fires an alert when the Jobber sync stops being healthy.
 *
 * "Healthy" = a `sync_log` row with status='success' and started_at within
 * the last 4 hours. Anything older means the every-30-min cron is either
 * failing silently or not running at all.
 *
 * Hourly cron calls checkHeartbeat(); if the latest success is too old we
 * call notify() with a 4-hour dedupe window so we don't email every hour
 * once the alarm trips.
 */

import type { Env } from "../../env.js";
import { getDlqSummary } from "./dlq.js";
import { notify } from "./notify.js";

const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

export interface HeartbeatStatus {
  healthy: boolean;
  last_success_at: string | null;
  age_ms: number | null;
  last_status: string | null;
  last_error: string | null;
  alerted: boolean;
}

export async function checkHeartbeat(env: Env): Promise<HeartbeatStatus> {
  const status: HeartbeatStatus = {
    healthy: false,
    last_success_at: null,
    age_ms: null,
    last_status: null,
    last_error: null,
    alerted: false,
  };

  const lastSuccess = await env.DB.prepare(
    `SELECT started_at FROM sync_log
     WHERE job_name = 'jobber_full' AND status = 'success'
     ORDER BY started_at DESC LIMIT 1`,
  ).first<{ started_at: string }>();

  const lastAny = await env.DB.prepare(
    `SELECT status, started_at, error_message FROM sync_log
     WHERE job_name = 'jobber_full'
     ORDER BY started_at DESC LIMIT 1`,
  ).first<{ status: string; started_at: string; error_message: string | null }>();

  status.last_success_at = lastSuccess?.started_at ?? null;
  status.last_status = lastAny?.status ?? null;
  status.last_error = lastAny?.error_message ?? null;

  if (!status.last_success_at) {
    // No success in the entire sync_log → almost certainly a fresh DB or
    // a totally broken sync. Either way, alert.
    status.healthy = false;
    status.age_ms = null;
    const sent = await notify(env, {
      severity: "error",
      subject: "Jobber sync has never completed successfully",
      text:
        `No successful jobber_full row exists in sync_log.\n` +
        `Last attempt: ${status.last_status ?? "(none)"} @ ${lastAny?.started_at ?? "(never)"}\n` +
        `Last error: ${status.last_error ?? "(none)"}\n`,
      dedupeKey: "heartbeat:no-success",
      dedupeWindowMs: STALE_AFTER_MS,
    });
    status.alerted = sent.sent;
    return status;
  }

  const lastTs = new Date(status.last_success_at).getTime();
  status.age_ms = Date.now() - lastTs;
  status.healthy = status.age_ms < STALE_AFTER_MS;

  if (!status.healthy) {
    const ageHours = (status.age_ms / (60 * 60 * 1000)).toFixed(1);
    const dlq = await getDlqSummary(env).catch(() => null);

    const sent = await notify(env, {
      severity: "error",
      subject: `Jobber sync stale (${ageHours}h since last success)`,
      text:
        `The Jobber → D1 sync has not had a successful run in ${ageHours} hours.\n\n` +
        `Last success: ${status.last_success_at}\n` +
        `Most recent attempt: ${status.last_status} @ ${lastAny?.started_at}\n` +
        `Most recent error: ${status.last_error ?? "(none)"}\n\n` +
        (dlq
          ? `Dead-letter queue: ${dlq.open} open / ${dlq.resolved_24h} resolved (24h)\n`
          : "") +
        `\nNext step: check Worker logs (\`npm run tail\`) and the most recent ` +
        `sync_log rows in D1.`,
      dedupeKey: "heartbeat:stale",
      dedupeWindowMs: STALE_AFTER_MS,
    });
    status.alerted = sent.sent;
  }

  return status;
}
