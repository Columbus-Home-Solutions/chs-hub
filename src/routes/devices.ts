/**
 * Push device-token registration (Sprint 18 — Capacitor App & Polish, deliv. E).
 *
 *   POST /api/devices/register     {platform, token}  upsert (keyed on token)
 *   POST /api/devices/unregister   {token}            deactivate
 *   GET  /api/devices                                 caller's own devices (masked)
 *
 * RBAC: ALL authenticated roles — every user registers their OWN device(s). The
 * route is intentionally NOT in the rbac.ts ROUTE_RULES table so it defaults to
 * ALL; the handlers below still resolve the actor via guard() and scope every
 * write/read to req.user.id.
 *
 * Business rules (mirrors the S17 token-handling rule):
 *   • Tokens are NEVER returned in plaintext and NEVER logged in plaintext —
 *     masked to the last 4 chars everywhere (responses + audit details).
 *   • Re-registering the same token is idempotent (UNIQUE(token) upsert): it
 *     re-homes the token to the current user, re-activates it, refreshes
 *     last_seen_at. A device that changes hands never duplicates a row.
 *
 * This sprint is SIMULATE-only: registration stores the token; the notification
 * dispatcher's push branch (src/lib/notification-engine.ts) logs the intended
 * push exactly as SMS/email simulate today. No live FCM/APNS call is made.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { writeAudit } from "../lib/audit.js";
import { ALL_ROLES } from "../lib/rbac.js";

const PLATFORMS = new Set(["ios", "android", "web"]);

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
function err(status: number, error: string, message?: string): Response {
  return json({ error, message: message ?? error }, { status });
}

/** Mask a device token to its last 4 chars — never expose/log the raw token. */
export function maskToken(token: string): string {
  if (!token) return "";
  const tail = token.slice(-4);
  return `••••${tail}`;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// ─── POST /api/devices/register ─────────────────────────────────────────────

export async function handleDeviceRegister(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...ALL_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return err(400, "invalid_json");
  }

  const platform = (str(body.platform) ?? "").toLowerCase();
  const token = str(body.token);
  if (!PLATFORMS.has(platform)) {
    return err(400, "invalid_platform", "platform must be one of ios|android|web");
  }
  if (!token) return err(400, "token_required");

  const now = new Date().toISOString();
  // Upsert keyed on the UNIQUE(token) index: re-home to the current user,
  // re-activate, refresh last_seen_at. Insert a fresh row otherwise.
  const existing = await env.DB.prepare("SELECT id, user_id FROM device_tokens WHERE token = ?")
    .bind(token)
    .first<{ id: string; user_id: string }>();

  let id: string;
  let created: boolean;
  if (existing) {
    id = existing.id;
    created = false;
    await env.DB.prepare(
      "UPDATE device_tokens SET user_id = ?, platform = ?, is_active = 1, last_seen_at = ? WHERE id = ?",
    )
      .bind(user.id, platform, now, id)
      .run();
  } else {
    id = crypto.randomUUID();
    created = true;
    await env.DB.prepare(
      `INSERT INTO device_tokens (id, user_id, platform, token, is_active, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(id, user.id, platform, token, now, now)
      .run();
  }

  // Audit with a MASKED token only — never persist the raw token in the log.
  await writeAudit(env, {
    userEmail: user.email,
    action: created ? "device.register" : "device.reactivate",
    entityType: "device_token",
    entityId: id,
    details: { platform, token: maskToken(token) },
  });

  return json(
    { ok: true, id, platform, token: maskToken(token), is_active: true, created },
    { status: created ? 201 : 200 },
  );
}

// ─── POST /api/devices/unregister ───────────────────────────────────────────

export async function handleDeviceUnregister(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...ALL_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return err(400, "invalid_json");
  }
  const token = str(body.token);
  if (!token) return err(400, "token_required");

  // Scope the deactivate to the caller's own token (a user can only retire their
  // own device). Owner may retire any token.
  const row = await env.DB.prepare("SELECT id, user_id FROM device_tokens WHERE token = ?")
    .bind(token)
    .first<{ id: string; user_id: string }>();
  if (!row) return json({ ok: true, found: false });
  if (row.user_id !== user.id && user.role !== "owner") {
    return err(403, "forbidden", "Cannot unregister another user's device.");
  }

  await env.DB.prepare("UPDATE device_tokens SET is_active = 0 WHERE id = ?").bind(row.id).run();
  await writeAudit(env, {
    userEmail: user.email,
    action: "device.unregister",
    entityType: "device_token",
    entityId: row.id,
    details: { token: maskToken(token) },
  });
  return json({ ok: true, found: true, id: row.id, is_active: false });
}

// ─── GET /api/devices (caller's own, masked) ────────────────────────────────

export async function handleDeviceList(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...ALL_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const rows = (
    await env.DB.prepare(
      `SELECT id, platform, token, is_active, created_at, last_seen_at
         FROM device_tokens WHERE user_id = ? ORDER BY datetime(created_at) DESC`,
    )
      .bind(user.id)
      .all<{
        id: string;
        platform: string;
        token: string;
        is_active: number;
        created_at: string;
        last_seen_at: string | null;
      }>()
  ).results ?? [];

  const devices = rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    token: maskToken(r.token), // never return the raw token
    is_active: Boolean(r.is_active),
    created_at: r.created_at,
    last_seen_at: r.last_seen_at,
  }));
  return json({ total: devices.length, devices });
}
