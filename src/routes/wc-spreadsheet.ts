/**
 * WC Spreadsheet routes — Sprint 14 (rebuilt module).
 *
 *   POST /api/wc-spreadsheet/sync   (O) manual trigger
 *   GET  /api/wc-spreadsheet/status (O) last sync status
 *
 * Owner-only via Cloudflare Access identity; the manual trigger also accepts
 * the SYNC_TRIGGER_SECRET (header `x-sync-token` or `?secret=`) so the sync can
 * be exercised locally / from tooling without an Access session.
 */

import type { Env } from "../env.js";
import { authenticateRequest, AuthError } from "../middleware/auth.js";
import { requireRole, RoleError } from "../middleware/roles.js";
import { getWcStatus, listWcSheetTabs, runWcSpreadsheetSync } from "../services/wc-spreadsheet.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

function hasSyncSecret(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") ?? request.headers.get("x-sync-token") ?? "";
  return !!env.SYNC_TRIGGER_SECRET && secret === env.SYNC_TRIGGER_SECRET;
}

async function requireOwnerOrSecret(request: Request, env: Env): Promise<Response | null> {
  if (hasSyncSecret(request, env)) return null;
  try {
    const authed = await authenticateRequest(request, env);
    requireRole(authed, ["owner"]);
    return null;
  } catch (err) {
    if (err instanceof AuthError) return json({ error: "unauthorized", message: err.message }, { status: 401 });
    if (err instanceof RoleError) return json({ error: "forbidden", message: err.message }, { status: 403 });
    throw err;
  }
}

export async function handleWcSpreadsheetSync(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwnerOrSecret(request, env);
  if (denied) return denied;
  const result = await runWcSpreadsheetSync(env);
  const ok = result.status === "success" || result.status === "skipped";
  return json(result, { status: ok ? 200 : 500 });
}

export async function handleWcSpreadsheetStatus(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwnerOrSecret(request, env);
  if (denied) return denied;
  const status = await getWcStatus(env);
  let sheet_tabs: string[] | string = [];
  try {
    sheet_tabs = await listWcSheetTabs(env);
  } catch (e) {
    sheet_tabs = `error: ${(e as Error).message}`;
  }
  return json({ ...status, sheet_tabs });
}
