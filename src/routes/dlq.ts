/**
 * Dead-letter queue viewer — Sprint 17 (Owner-only via RBAC gate).
 *
 *   GET  /api/dlq                list (filter ?status=open|resolved|all)
 *   POST /api/dlq/:id/retry      re-run the failed op through its real handler
 *   POST /api/dlq/:id/dismiss    mark resolved without re-running
 *   POST /api/dlq/dismiss        bulk dismiss { ids: [...] }
 *
 * Reads/writes the EXISTING `sync_dead_letters` store (S7/S14/S16 publish,
 * QBO, notification, and social failures route here). The Route Map calls the
 * surface /api/dlq; the physical table stays sync_dead_letters — no second
 * failure store. There is no `status` column: open = resolved_at IS NULL.
 */

import type { Env } from "../env.js";
import { retryDeadLetter, dismissDeadLetter } from "../lib/ops/dlq.js";
import { writeAudit } from "../lib/audit.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

interface DlqRow {
  id: number;
  job_name: string;
  entity_type: string;
  entity_id: string | null;
  payload: string | null;
  error_message: string;
  first_seen_at: string;
  last_seen_at: string;
  attempts: number;
  resolved_at: string | null;
  last_attempt_status: string | null;
  alerted_at: string | null;
}

function actor(request: Request): string {
  const u = (request as Request & { user?: { email?: string } }).user;
  return u?.email ?? request.headers.get("Cf-Access-Authenticated-User-Email") ?? "owner";
}

// ─── GET /api/dlq ────────────────────────────────────────────────────────────

export async function handleDlqList(env: Env, url: URL): Promise<Response> {
  const status = (url.searchParams.get("status") ?? "open").toLowerCase();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);

  let where = "";
  if (status === "open") where = "WHERE resolved_at IS NULL";
  else if (status === "resolved") where = "WHERE resolved_at IS NOT NULL";
  // "all" → no filter.

  const { results } = await env.DB.prepare(
    `SELECT id, job_name, entity_type, entity_id, payload, error_message,
            first_seen_at, last_seen_at, attempts, resolved_at, last_attempt_status, alerted_at
       FROM sync_dead_letters ${where}
      ORDER BY (resolved_at IS NULL) DESC, last_seen_at DESC
      LIMIT ?`,
  )
    .bind(limit)
    .all<DlqRow>();

  const items = (results ?? []).map((r) => {
    let payload: unknown = r.payload;
    if (r.payload) {
      try {
        payload = JSON.parse(r.payload);
      } catch {
        payload = r.payload;
      }
    }
    return {
      id: r.id,
      job_name: r.job_name,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      error_message: r.error_message,
      attempts: r.attempts,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at,
      resolved_at: r.resolved_at,
      status: r.resolved_at ? r.last_attempt_status ?? "resolved" : "open",
      alerted_at: r.alerted_at,
      payload,
    };
  });

  const openCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sync_dead_letters WHERE resolved_at IS NULL",
  ).first<{ n: number }>();

  return json({ items, open_count: openCount?.n ?? 0 });
}

// ─── POST /api/dlq/:id/retry ─────────────────────────────────────────────────

export async function handleDlqRetry(env: Env, id: string): Promise<Response> {
  const numId = Number(id);
  if (!Number.isInteger(numId)) {
    return json({ error: "bad_request", message: "id must be an integer" }, { status: 400 });
  }
  const result = await retryDeadLetter(env, numId);
  return json(result, { status: result.ok ? 200 : result.error === "not_found_or_resolved" ? 404 : 502 });
}

// ─── POST /api/dlq/:id/dismiss ───────────────────────────────────────────────

export async function handleDlqDismiss(env: Env, id: string): Promise<Response> {
  const numId = Number(id);
  if (!Number.isInteger(numId)) {
    return json({ error: "bad_request", message: "id must be an integer" }, { status: 400 });
  }
  const ok = await dismissDeadLetter(env, numId);
  return json({ ok, id: numId }, { status: ok ? 200 : 404 });
}

// ─── POST /api/dlq/dismiss (bulk) ────────────────────────────────────────────

export async function handleDlqDismissBulk(request: Request, env: Env): Promise<Response> {
  let body: { ids?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "bad_request", message: "Body must be JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
  if (ids.length === 0) {
    return json({ error: "bad_request", message: "ids must be a non-empty integer array" }, { status: 400 });
  }

  let dismissed = 0;
  for (const id of ids) {
    if (await dismissDeadLetter(env, id)) dismissed++;
  }

  await writeAudit(env, {
    userEmail: actor(request),
    action: "dlq.bulk_dismiss",
    entityType: "sync_dead_letter",
    entityId: ids.join(","),
    details: { requested: ids.length, dismissed },
    ipAddress: request.headers.get("cf-connecting-ip"),
  });

  return json({ ok: true, requested: ids.length, dismissed });
}
