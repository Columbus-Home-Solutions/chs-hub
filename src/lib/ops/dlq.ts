/**
 * Dead-letter queue for sync failures.
 *
 * Capture path:
 *   recordDeadLetter() — called from src/lib/jobber/sync.ts catch blocks
 *                        instead of (or alongside) stats.errors. Stores the
 *                        original Jobber node JSON so we can replay later.
 *
 * Replay path:
 *   replayDeadLetters() — invoked by the hourly cron. Picks up to N
 *                         unresolved rows, calls the appropriate upsert,
 *                         marks resolved on success or bumps attempts on
 *                         failure. Fires a notify() alert when a row hits
 *                         5+ attempts (deduped via alerted_at column).
 *
 * Why store the payload (vs. just the entity_id):
 *   The data may have changed in Jobber by the time we retry. We want to
 *   replay the *exact* state that failed so that "fix the bug, retry" gives
 *   identical behaviour. If you instead want to refetch latest state,
 *   simply trigger a fresh full sync — it'll naturally cover everything.
 */

import type { Env } from "../../env.js";
import { notify } from "./notify.js";

export type DlqEntityType =
  | "job"
  | "invoice"
  | "quote"
  | "expense"
  | "payment"
  | "client"
  | "wc_spreadsheet"
  | "google_review";

export interface RecordDeadLetterArgs {
  jobName: string;            // e.g. 'jobber_full'
  entityType: DlqEntityType;
  entityId: string | null;    // null for page-level failures
  payload: unknown;           // serialized to JSON; pass the raw Jobber node
  errorMessage: string;
}

export async function recordDeadLetter(
  env: Env,
  args: RecordDeadLetterArgs,
): Promise<void> {
  const now = new Date().toISOString();
  const payloadJson = args.payload === undefined ? null : safeStringify(args.payload);

  // Upsert pattern: insert a new row, or bump attempts + last_seen on the
  // existing open row. The partial unique index handles the dedup.
  await env.DB.prepare(
    `INSERT INTO sync_dead_letters
       (job_name, entity_type, entity_id, payload, error_message,
        first_seen_at, last_seen_at, attempts, last_attempt_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'failed')
     ON CONFLICT(job_name, entity_type, entity_id) WHERE resolved_at IS NULL
     DO UPDATE SET
       payload = excluded.payload,
       error_message = excluded.error_message,
       last_seen_at = excluded.last_seen_at,
       attempts = sync_dead_letters.attempts + 1,
       last_attempt_status = 'failed'`,
  )
    .bind(
      args.jobName,
      args.entityType,
      args.entityId,
      payloadJson,
      args.errorMessage,
      now,
      now,
    )
    .run();
}

export interface ReplayResult {
  picked: number;
  succeeded: number;
  failed: number;
  alerted: number;
  errors: string[];
}

const REPLAY_BATCH = 25;
const ALERT_AFTER_ATTEMPTS = 5;

export async function replayDeadLetters(env: Env): Promise<ReplayResult> {
  const result: ReplayResult = {
    picked: 0,
    succeeded: 0,
    failed: 0,
    alerted: 0,
    errors: [],
  };

  const rows = await env.DB.prepare(
    `SELECT id, job_name, entity_type, entity_id, payload, attempts, alerted_at
     FROM sync_dead_letters
     WHERE resolved_at IS NULL
     ORDER BY last_seen_at ASC
     LIMIT ?`,
  )
    .bind(REPLAY_BATCH)
    .all<{
      id: number;
      job_name: string;
      entity_type: DlqEntityType;
      entity_id: string | null;
      payload: string | null;
      attempts: number;
      alerted_at: string | null;
    }>();

  result.picked = rows.results.length;

  // Batch stuck alerts: one email per (entity_type + error) instead of one per
  // row — prevents Resend quota exhaustion when many rows share the same gap.
  const pendingAlerts: Array<{
    id: number;
    job_name: string;
    entity_type: string;
    entity_id: string | null;
    attempts: number;
    error: string;
  }> = [];

  for (const row of rows.results) {
    try {
      await replayOne(env, row);
      await markResolved(env, row.id);
      result.succeeded++;
    } catch (err) {
      const msg = (err as Error).message;
      await markFailed(env, row.id, msg);
      result.failed++;
      result.errors.push(`dlq#${row.id} ${row.entity_type}:${row.entity_id}: ${msg}`);

      const newAttempts = row.attempts + 1;
      if (newAttempts >= ALERT_AFTER_ATTEMPTS && !row.alerted_at) {
        pendingAlerts.push({
          id: row.id,
          job_name: row.job_name,
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          attempts: newAttempts,
          error: msg,
        });
      }
    }
  }

  if (pendingAlerts.length > 0) {
    const groups = new Map<string, typeof pendingAlerts>();
    for (const a of pendingAlerts) {
      const key = `${a.entity_type}\0${a.error}`;
      const list = groups.get(key) ?? [];
      list.push(a);
      groups.set(key, list);
    }
    const now = new Date().toISOString();
    for (const [, group] of groups) {
      const sample = group[0]!;
      const ids = group.map((g) => g.id);
      const sent = await notify(env, {
        severity: "error",
        subject:
          group.length === 1
            ? `DLQ entry stuck: ${sample.entity_type} ${sample.entity_id ?? "(page-level)"}`
            : `DLQ: ${group.length} ${sample.entity_type} rows stuck (same error)`,
        text:
          group.length === 1
            ? `Dead-letter row #${sample.id} has now failed ${sample.attempts} replay attempts.\n` +
              `job=${sample.job_name} type=${sample.entity_type} id=${sample.entity_id}\n` +
              `Last error: ${sample.error}\n\n` +
              `Inspect: SELECT * FROM sync_dead_letters WHERE id = ${sample.id};`
            : `${group.length} dead-letter rows of type=${sample.entity_type} failed replay ` +
              `with the same error (attempts ≥ ${ALERT_AFTER_ATTEMPTS}).\n` +
              `job=${sample.job_name}\n` +
              `ids=${ids.join(",")}\n` +
              `entity_ids=${group.map((g) => g.entity_id).join(", ")}\n` +
              `Last error: ${sample.error}\n\n` +
              `Inspect: SELECT * FROM sync_dead_letters WHERE id IN (${ids.join(",")});`,
        dedupeKey: `dlq:${sample.entity_type}:${sample.error.slice(0, 80)}:stuck`,
        dedupeWindowMs: 24 * 60 * 60 * 1000,
      });
      if (sent.sent || sent.reason === "dry_run") {
        for (const id of ids) {
          await env.DB.prepare(`UPDATE sync_dead_letters SET alerted_at = ? WHERE id = ?`)
            .bind(now, id)
            .run();
        }
        if (sent.sent) result.alerted++;
      }
    }
  }

  return result;
}

// ─── Replay dispatch ──────────────────────────────────────────────

async function replayOne(
  env: Env,
  row: {
    id: number;
    job_name: string;
    entity_type: DlqEntityType;
    entity_id: string | null;
    payload: string | null;
  },
): Promise<void> {
  switch (row.entity_type) {
    case "job":
      // Jobber sync decommissioned — these legacy DLQ entries cannot be replayed.
      throw new Error("Jobber job replay decommissioned; resolve this DLQ entry manually.");

    case "wc_spreadsheet": {
      // Run a full sync cycle. entity_id may be a tab name or "all" — in both
      // cases a fresh full sync is the correct replay (the sync is idempotent).
      // Dynamic import avoids a circular dep at load time (wc-spreadsheet imports dlq).
      const { runWcSpreadsheetSync } = await import("../../services/wc-spreadsheet.js");
      const r = await runWcSpreadsheetSync(env);
      if (r.status === "success" || r.status === "skipped") return;
      throw new Error(r.error_message ?? `wc_spreadsheet sync returned status=${r.status}`);
    }

    case "google_review": {
      // GBP location-level failure (entity_id is the v4 location parent).
      // Re-run the same sync the cron uses; dynamic import avoids load-time
      // cycles (google-reviews-sync imports recordDeadLetter).
      const { syncGbpReviews } = await import("../google-reviews-sync.js");
      const r = await syncGbpReviews(env);
      if (r.skipped) {
        throw new Error(`gbp_reviews_sync skipped: ${r.skipped}`);
      }
      return;
    }

    case "payment": {
      // Push the single payment through the real QBO path (same as nightly sweep).
      // Dynamic import avoids a load-time cycle (qbo-sync imports recordDeadLetter).
      const paymentId = row.entity_id;
      if (!paymentId) throw new Error("payment DLQ row missing entity_id");
      const { isQboPaymentSyncEnabled, pushPaymentById } = await import("../qbo-sync.js");
      if (!(await isQboPaymentSyncEnabled(env))) {
        // Resolve the DLQ row so we don't retry/alert while the go-live gate is off.
        // The payment stays qbo_payment_id=NULL; the nightly sweep will push after enable.
        console.log("[dlq] QBO payment sync disabled — pending go-live; clearing payment DLQ deferral");
        return;
      }
      try {
        await pushPaymentById(env, paymentId);
      } catch (err) {
        // Permanent Jobber exclusion — resolve the DLQ row; do not retry or push.
        const msg = (err as Error).message ?? "";
        if (msg.includes("permanently excluded: Jobber-imported")) {
          console.log(
            `[dlq] QBO payment permanently excluded (Jobber import); clearing DLQ for ${paymentId}`,
          );
          return;
        }
        throw err;
      }
      return;
    }

    // For other types, defer to the next full sync. Recording these still
    // gives us visibility (and an alert if they keep failing); the sync
    // job will retry naturally on its own pass.
    // NOTE: invoice/expense under qbo_sync have the same stub gap — flag only;
    // scoped fix for payment (see CHS-Task-QBO-Payment-DLQ-Replay-Fix).
    case "invoice":
    case "quote":
    case "expense":
    case "client": {
      if (!row.payload) throw new Error("no payload to replay");
      throw new Error(
        `replay not yet implemented for ${row.entity_type}; awaiting next full sync`,
      );
    }

    default:
      throw new Error(`unknown entity_type: ${row.entity_type}`);
  }
}

async function markResolved(env: Env, id: number): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE sync_dead_letters
     SET resolved_at = ?, last_attempt_status = 'success', last_seen_at = ?
     WHERE id = ?`,
  )
    .bind(now, now, id)
    .run();
}

async function markFailed(env: Env, id: number, errorMessage: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE sync_dead_letters
     SET attempts = attempts + 1,
         last_seen_at = ?,
         last_attempt_status = 'failed',
         error_message = ?
     WHERE id = ?`,
  )
    .bind(now, errorMessage, id)
    .run();
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

// ─── Single-row retry / dismiss (Sprint 17 DLQ viewer) ────────────
//
// The owner-facing viewer drives these per-item; they re-run the SAME replay
// path the hourly cron uses, so "retry" is identical to an automatic attempt.

export interface SingleRetryResult {
  ok: boolean;
  id: number;
  error?: string;
}

export async function retryDeadLetter(env: Env, id: number): Promise<SingleRetryResult> {
  const row = await env.DB.prepare(
    `SELECT id, job_name, entity_type, entity_id, payload
       FROM sync_dead_letters WHERE id = ? AND resolved_at IS NULL`,
  )
    .bind(id)
    .first<{
      id: number;
      job_name: string;
      entity_type: DlqEntityType;
      entity_id: string | null;
      payload: string | null;
    }>();

  if (!row) return { ok: false, id, error: "not_found_or_resolved" };

  try {
    await replayOne(env, row);
    await markResolved(env, row.id);
    return { ok: true, id };
  } catch (err) {
    const msg = (err as Error).message;
    await markFailed(env, row.id, msg);
    return { ok: false, id, error: msg };
  }
}

/** Mark an open dead-letter row resolved without re-running it (owner dismiss). */
export async function dismissDeadLetter(env: Env, id: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE sync_dead_letters
        SET resolved_at = ?, last_attempt_status = 'dismissed', last_seen_at = ?
      WHERE id = ? AND resolved_at IS NULL`,
  )
    .bind(new Date().toISOString(), new Date().toISOString(), id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ─── Read API for dashboard / debugging ───────────────────────────

export interface DlqSummary {
  open: number;
  resolved_24h: number;
  oldest_open_at: string | null;
  by_type: Record<string, number>;
  by_job: Record<string, number>;
}

export async function getDlqSummary(env: Env): Promise<DlqSummary> {
  const open = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sync_dead_letters WHERE resolved_at IS NULL`,
  ).first<{ n: number }>();

  const resolved = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sync_dead_letters
     WHERE resolved_at IS NOT NULL AND resolved_at >= datetime('now', '-1 day')`,
  ).first<{ n: number }>();

  const oldest = await env.DB.prepare(
    `SELECT MIN(first_seen_at) AS oldest FROM sync_dead_letters WHERE resolved_at IS NULL`,
  ).first<{ oldest: string | null }>();

  const byType = await env.DB.prepare(
    `SELECT entity_type, COUNT(*) AS n FROM sync_dead_letters
     WHERE resolved_at IS NULL GROUP BY entity_type`,
  ).all<{ entity_type: string; n: number }>();

  const map: Record<string, number> = {};
  for (const r of byType.results) map[r.entity_type] = r.n;

  // Group by job_name too so sync types (jobber_full, qbo_sync, wc_spreadsheet)
  // are distinctly visible in the System-Admin DLQ surface (Sprint 14).
  const byJob = await env.DB.prepare(
    `SELECT job_name, COUNT(*) AS n FROM sync_dead_letters
     WHERE resolved_at IS NULL GROUP BY job_name`,
  ).all<{ job_name: string; n: number }>();
  const jobMap: Record<string, number> = {};
  for (const r of byJob.results) jobMap[r.job_name] = r.n;

  return {
    open: open?.n ?? 0,
    resolved_24h: resolved?.n ?? 0,
    oldest_open_at: oldest?.oldest ?? null,
    by_type: map,
    by_job: jobMap,
  };
}
