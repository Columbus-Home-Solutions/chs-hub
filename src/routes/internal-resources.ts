/**
 * Internal Resources — owner-only links stored in system_settings.
 *
 *   GET    /api/settings/internal-resources
 *   POST   /api/settings/internal-resources/drive-url
 *   POST   /api/settings/internal-resources/links
 *   DELETE /api/settings/internal-resources/links/:id
 */

import type { Env } from "../env.js";
import { authenticateRequest, AuthError } from "../middleware/auth.js";
import { requireRole, RoleError } from "../middleware/roles.js";

const DRIVE_KEY = "internal_drive_url";
const LINKS_KEY = "internal_resource_links";

interface ResourceLink {
  id: string;
  label: string;
  url: string;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function err(status: number, error: string, details?: string): Response {
  return json({ error, ...(details ? { details } : {}) }, { status });
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

async function ownerGuard(request: Request, env: Env) {
  try {
    const authed = await authenticateRequest(request, env);
    requireRole(authed, ["owner"]);
    return authed;
  } catch (e) {
    if (e instanceof AuthError) return err(401, "unauthorized", e.message);
    if (e instanceof RoleError) return err(403, "forbidden", e.message);
    throw e;
  }
}

async function getSettingValue(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string | null }>();
  return row?.value ?? null;
}

function parseLinks(raw: string | null): ResourceLink[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is ResourceLink =>
        !!v &&
        typeof v === "object" &&
        typeof (v as ResourceLink).id === "string" &&
        typeof (v as ResourceLink).label === "string" &&
        typeof (v as ResourceLink).url === "string",
    );
  } catch {
    return [];
  }
}

async function saveSetting(env: Env, key: string, value: string, updatedBy: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE system_settings SET value = ?, updated_at = datetime('now'), updated_by = ? WHERE key = ?",
  )
    .bind(value, updatedBy, key)
    .run();
}

/** GET /api/settings/internal-resources — owner only */
export async function handleInternalResourcesGet(request: Request, env: Env): Promise<Response> {
  const guarded = await ownerGuard(request, env);
  if (guarded instanceof Response) return guarded;

  const driveUrl = str(await getSettingValue(env, DRIVE_KEY));
  const links = parseLinks(await getSettingValue(env, LINKS_KEY));
  return json({ drive_url: driveUrl, links });
}

/** POST /api/settings/internal-resources/drive-url */
export async function handleInternalResourcesDriveUrl(
  request: Request,
  env: Env,
): Promise<Response> {
  const guarded = await ownerGuard(request, env);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const url = str(body.url);
  if (!url) return err(400, "bad_request", "url is required");

  await saveSetting(env, DRIVE_KEY, url, user.email);
  return json({ ok: true, drive_url: url });
}

/** POST /api/settings/internal-resources/links */
export async function handleInternalResourcesLinkCreate(
  request: Request,
  env: Env,
): Promise<Response> {
  const guarded = await ownerGuard(request, env);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const label = str(body.label);
  const url = str(body.url);
  if (!label) return err(400, "bad_request", "label is required");
  if (!url) return err(400, "bad_request", "url is required");

  const links = parseLinks(await getSettingValue(env, LINKS_KEY));
  const link: ResourceLink = { id: crypto.randomUUID(), label, url };
  links.push(link);
  await saveSetting(env, LINKS_KEY, JSON.stringify(links), user.email);
  return json({ ok: true, link });
}

/** DELETE /api/settings/internal-resources/links/:id */
export async function handleInternalResourcesLinkDelete(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await ownerGuard(request, env);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const links = parseLinks(await getSettingValue(env, LINKS_KEY));
  const next = links.filter((l) => l.id !== id);
  if (next.length === links.length) return err(404, "not_found", "Link not found");

  await saveSetting(env, LINKS_KEY, JSON.stringify(next), user.email);
  return json({ ok: true });
}
