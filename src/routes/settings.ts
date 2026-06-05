/**
 * System settings API.
 *
 *   GET /api/settings        — all settings (grouped is left to the client)
 *   GET /api/settings/:key   — a single setting
 *   PUT /api/settings/:key   — update a setting's value (owner only)
 *
 * Reads are open to any authenticated dashboard user (Cloudflare Access gates
 * the host). Writes require the `owner` role and are recorded in audit_logs.
 */

import type { Env } from "../env.js";
import { authenticateRequest, AuthError } from "../middleware/auth.js";
import { requireRole, RoleError } from "../middleware/roles.js";

interface SettingRow {
  key: string;
  value: string;
  value_type: "string" | "number" | "boolean" | "json";
  category: string;
  label: string;
  description: string | null;
  updated_at: string;
  updated_by: string | null;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

const REDACTED_SETTING_KEYS = new Set([
  "social_facebook_page_token",
  "stripe_secret_key",
  "stripe_webhook_secret",
  "social_gemini_api_key",
]);

function isRedactedSettingKey(key: string): boolean {
  if (REDACTED_SETTING_KEYS.has(key)) return true;
  const k = key.toLowerCase();
  return k.includes("token") || k.includes("secret") || k.endsWith("_key");
}

/** Map a stored setting row to a typed `value` alongside the raw string. */
function shape(row: SettingRow) {
  if (isRedactedSettingKey(row.key)) {
    return { ...row, value: "", typed_value: null, redacted: true as const };
  }
  let typed: unknown = row.value;
  try {
    if (row.value_type === "number") typed = Number(row.value);
    else if (row.value_type === "boolean") typed = row.value === "true" || row.value === "1";
    else if (row.value_type === "json") typed = JSON.parse(row.value);
  } catch {
    typed = row.value;
  }
  return { ...row, typed_value: typed };
}

/** GET /api/settings */
export async function handleSettingsList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT key, value, value_type, category, label, description, updated_at, updated_by FROM system_settings ORDER BY category, key",
  ).all<SettingRow>();
  return json({ settings: (results ?? []).map(shape) });
}

/** GET /api/settings/:key */
export async function handleSettingGet(env: Env, key: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT key, value, value_type, category, label, description, updated_at, updated_by FROM system_settings WHERE key = ?",
  )
    .bind(key)
    .first<SettingRow>();

  if (!row) {
    return json({ error: "not_found", key }, { status: 404 });
  }
  return json({ setting: shape(row) });
}

/** Coerce an incoming JSON value to the string form stored for a value_type. */
function serializeValue(value: unknown, valueType: SettingRow["value_type"]): string | null {
  if (value === null || value === undefined) return null;
  if (valueType === "json") {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  if (valueType === "boolean") {
    return value === true || value === "true" || value === 1 || value === "1" ? "true" : "false";
  }
  if (valueType === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? String(n) : null;
  }
  return String(value);
}

/** PUT /api/settings/:key — owner only. */
export async function handleSettingUpdate(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  let authed;
  try {
    authed = await authenticateRequest(request, env);
    requireRole(authed, ["owner"]);
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: "unauthorized", message: err.message }, { status: 401 });
    }
    if (err instanceof RoleError) {
      return json({ error: "forbidden", message: err.message }, { status: 403 });
    }
    throw err;
  }

  const existing = await env.DB.prepare(
    "SELECT key, value, value_type, category, label, description, updated_at, updated_by FROM system_settings WHERE key = ?",
  )
    .bind(key)
    .first<SettingRow>();

  if (!existing) {
    return json({ error: "not_found", key }, { status: 404 });
  }

  let payload: { value?: unknown };
  try {
    payload = (await request.json()) as { value?: unknown };
  } catch {
    return json({ error: "bad_request", message: "Body must be JSON" }, { status: 400 });
  }

  if (!("value" in payload)) {
    return json({ error: "bad_request", message: "Missing 'value'" }, { status: 400 });
  }

  const serialized = serializeValue(payload.value, existing.value_type);
  if (serialized === null) {
    return json(
      { error: "bad_request", message: `Invalid value for type ${existing.value_type}` },
      { status: 400 },
    );
  }

  await env.DB.prepare(
    "UPDATE system_settings SET value = ?, updated_at = datetime('now'), updated_by = ? WHERE key = ?",
  )
    .bind(serialized, authed.user.email, key)
    .run();

  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
  )
    .bind(
      crypto.randomUUID(),
      authed.user.email,
      "setting_updated",
      "system_setting",
      key,
      JSON.stringify({ old: existing.value, new: serialized }),
    )
    .run();

  const updated = await env.DB.prepare(
    "SELECT key, value, value_type, category, label, description, updated_at, updated_by FROM system_settings WHERE key = ?",
  )
    .bind(key)
    .first<SettingRow>();

  return json({ setting: shape(updated as SettingRow) });
}
