/**
 * Notifications API (Sprint 7) — templates (owner-only), logs (owner-only), and
 * the per-user in-app inbox (all roles). Thin handlers over D1, matching the
 * clients.ts / estimate-requests.ts conventions (guard() for writes, audit
 * logging, parameterized queries).
 *
 *   GET  /api/notification-templates             list, grouped by phase
 *   GET  /api/notification-templates/:id         detail
 *   PUT  /api/notification-templates/:id         edit body/subject/timing/channel/is_active
 *   POST /api/notification-templates/:id/test    send a test to the owner
 *   POST /api/notification-templates/:id/preview render sample (no send/log)
 *   GET  /api/notification-logs                  list + filters
 *   POST /api/notification-logs/:id/retry        re-queue a failed/bounced row
 *   GET  /api/notifications/inbox                current user's in_app rows
 *   PUT  /api/notifications/:id/read             mark one read
 *   PUT  /api/notifications/read-all             mark all read
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { authenticateRequest, AuthError } from "../middleware/auth.js";
import { previewTemplate, sendOwnerTest } from "../lib/notification-engine.js";

const OWNER_ONLY = ["owner"] as const;

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
async function logAudit(env: Env, email: string, action: string, entityId: string, details: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, 'notification_template', ?, ?, datetime('now'))",
  )
    .bind(crypto.randomUUID(), email, action, entityId, JSON.stringify(details))
    .run();
}

// ─── Templates ────────────────────────────────────────────────────────────────

export async function handleTemplateList(env: Env, request: Request): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;

  const { results } = await env.DB.prepare(
    `SELECT id, trigger_event, name, recipient_type, channel, subject, body_template,
            merge_fields, is_active, delay_minutes, send_time, phase, sort_order
       FROM notification_templates
      WHERE COALESCE(phase, '') <> 'system'
      ORDER BY phase, sort_order, name`,
  ).all<Record<string, unknown>>();

  const grouped: Record<string, unknown[]> = {};
  for (const t of results ?? []) {
    const phase = (t.phase as string) ?? "other";
    (grouped[phase] ??= []).push(shapeTemplate(t));
  }
  return json({ phases: grouped, total: (results ?? []).length });
}

function shapeTemplate(t: Record<string, unknown>) {
  let mergeFields: string[] = [];
  try {
    const parsed = JSON.parse((t.merge_fields as string) ?? "[]");
    if (Array.isArray(parsed)) mergeFields = parsed.map(String);
  } catch {
    mergeFields = [];
  }
  return {
    id: t.id,
    trigger_event: t.trigger_event,
    name: t.name,
    recipient_type: t.recipient_type,
    channel: t.channel,
    subject: t.subject,
    body_template: t.body_template,
    merge_fields: mergeFields,
    is_active: (t.is_active as number) === 1,
    delay_minutes: t.delay_minutes,
    send_time: t.send_time,
    phase: t.phase,
    sort_order: t.sort_order,
  };
}

export async function handleTemplateGet(env: Env, request: Request, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const t = await env.DB.prepare("SELECT * FROM notification_templates WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (!t) return err(404, "not_found", "Template not found");
  return json({ template: shapeTemplate(t) });
}

const TEMPLATE_TEXT = ["subject", "body_template"] as const;
const VALID_CHANNELS = ["sms", "email", "push", "in_app"];

export async function handleTemplateUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare("SELECT id FROM notification_templates WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return err(404, "not_found", "Template not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const updates: string[] = [];
  const binds: unknown[] = [];

  for (const col of TEMPLATE_TEXT) {
    if (col in body) {
      updates.push(`${col} = ?`);
      binds.push(str(body[col]));
    }
  }
  if ("channel" in body) {
    const ch = str(body.channel);
    if (!ch || !VALID_CHANNELS.includes(ch)) {
      return err(422, "validation_error", `channel must be one of: ${VALID_CHANNELS.join(", ")}`);
    }
    updates.push("channel = ?");
    binds.push(ch);
  }
  if ("is_active" in body) {
    updates.push("is_active = ?");
    binds.push(body.is_active === true || body.is_active === 1 || body.is_active === "1" ? 1 : 0);
  }
  if ("delay_minutes" in body) {
    const n = Number(body.delay_minutes);
    updates.push("delay_minutes = ?");
    binds.push(Number.isFinite(n) ? Math.trunc(n) : 0);
  }
  if ("send_time" in body) {
    updates.push("send_time = ?");
    binds.push(str(body.send_time));
  }

  if (updates.length === 0) return err(400, "bad_request", "No updatable fields supplied");

  updates.push("updated_at = ?");
  binds.push(new Date().toISOString());
  binds.push(id);

  await env.DB.prepare(`UPDATE notification_templates SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  await logAudit(env, user.email, "notification_template_updated", id, { fields: Object.keys(body) });

  const t = await env.DB.prepare("SELECT * FROM notification_templates WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  return json({ template: t ? shapeTemplate(t) : null });
}

export async function handleTemplatePreview(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const preview = await previewTemplate(env, id);
  if (!preview) return err(404, "not_found", "Template not found");
  return json({ preview });
}

export async function handleTemplateTest(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;
  const result = await sendOwnerTest(env, id);
  if (!result) return err(404, "not_found", "Template not found");
  await logAudit(env, user.email, "notification_template_tested", id, { simulated: result.simulated });
  return json(result);
}

// ─── Logs ───────────────────────────────────────────────────────────────────

export async function handleLogList(env: Env, request: Request, url: URL): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;

  const where: string[] = ["COALESCE(trigger_event,'') <> 'system_alert'"];
  const binds: unknown[] = [];
  const status = str(url.searchParams.get("status"));
  const channel = str(url.searchParams.get("channel"));
  const trigger = str(url.searchParams.get("trigger"));
  const jobId = str(url.searchParams.get("job_id"));
  const from = str(url.searchParams.get("from"));
  const to = str(url.searchParams.get("to"));
  if (status) {
    where.push("status = ?");
    binds.push(status);
  }
  if (channel) {
    where.push("channel = ?");
    binds.push(channel);
  }
  if (trigger) {
    where.push("trigger_event = ?");
    binds.push(trigger);
  }
  if (jobId) {
    where.push("job_id = ?");
    binds.push(jobId);
  }
  if (from) {
    where.push("created_at >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("created_at <= ?");
    binds.push(to);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, template_id, trigger_event, recipient_type, recipient_name, recipient_contact,
            channel, subject, body, status, error_message, retry_count, scheduled_for, sent_at,
            delivered_at, external_id, job_id, client_id, estimate_request_id, communication_id,
            created_at
       FROM notification_logs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC LIMIT 500`,
  )
    .bind(...binds)
    .all();
  return json({ logs: results ?? [] });
}

export async function handleLogRetry(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await env.DB.prepare("SELECT id, status FROM notification_logs WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!row) return err(404, "not_found", "Notification not found");

  // Re-queue: reset to queued, due now, clear retry counters so the processor
  // picks it up on the next */15 tick.
  await env.DB.prepare(
    "UPDATE notification_logs SET status = 'queued', scheduled_for = datetime('now'), next_retry_at = NULL, retry_count = 0, error_message = NULL WHERE id = ?",
  )
    .bind(id)
    .run();
  await logAudit(env, user.email, "notification_retried", id, { from_status: row.status });
  return json({ ok: true, id, status: "queued" });
}

// ─── In-app inbox (per-user; all roles) ───────────────────────────────────────

export async function handleInbox(request: Request, env: Env): Promise<Response> {
  let user;
  try {
    user = (await authenticateRequest(request, env)).user;
  } catch (e) {
    if (e instanceof AuthError) return err(401, "unauthorized", e.message);
    throw e;
  }

  const unread = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM notification_logs WHERE recipient_user_id = ? AND channel = 'in_app' AND is_read = 0",
  )
    .bind(user.id)
    .first<{ n: number }>();

  // Inbox dropdown shows unread only so Clear All empties the panel while
  // preserving notification_logs rows (audit trail via is_read/read_at).
  const { results } = await env.DB.prepare(
    `SELECT id, trigger_event, body, subject, link_path, is_read, read_at, created_at
       FROM notification_logs
      WHERE recipient_user_id = ? AND channel = 'in_app' AND is_read = 0
      ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(user.id)
    .all();

  return json({
    unread_count: unread?.n ?? 0,
    notifications: (results ?? []).map((r) => ({ ...r, is_read: (r.is_read as number) === 1 })),
  });
}

export async function handleInboxRead(request: Request, env: Env, id: string): Promise<Response> {
  let user;
  try {
    user = (await authenticateRequest(request, env)).user;
  } catch (e) {
    if (e instanceof AuthError) return err(401, "unauthorized", e.message);
    throw e;
  }
  const res = await env.DB.prepare(
    "UPDATE notification_logs SET is_read = 1, read_at = datetime('now') WHERE id = ? AND recipient_user_id = ? AND channel = 'in_app'",
  )
    .bind(id, user.id)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return err(404, "not_found", "Notification not found");
  return json({ ok: true, id });
}

export async function handleInboxReadAll(request: Request, env: Env): Promise<Response> {
  let user;
  try {
    user = (await authenticateRequest(request, env)).user;
  } catch (e) {
    if (e instanceof AuthError) return err(401, "unauthorized", e.message);
    throw e;
  }
  await env.DB.prepare(
    "UPDATE notification_logs SET is_read = 1, read_at = datetime('now') WHERE recipient_user_id = ? AND channel = 'in_app' AND is_read = 0",
  )
    .bind(user.id)
    .run();
  return json({ ok: true });
}
