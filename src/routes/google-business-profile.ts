/**
 * Google Business Profile OAuth + sync routes (Reviews Phase B).
 *
 *   POST /api/integrations/google-business-profile/connect
 *   GET  /api/integrations/google-business-profile/callback
 *   POST /api/integrations/google-business-profile/disconnect
 *   POST /api/integrations/google-business-profile/test
 *   GET  /api/google-business-profile/status
 *   POST /api/google-business-profile/sync
 */

import type { Env } from "../env.js";
import { authenticateRequest, AuthError } from "../middleware/auth.js";
import { requireRole, RoleError } from "../middleware/roles.js";
import {
  buildGbpAuthorizeUrl,
  disconnectGbp,
  exchangeGbpAuthCode,
  gbpCredentialsConfigured,
  getGbpStatus,
  listGbpAccounts,
  makeGbpState,
  saveGbpState,
  verifyGbpState,
} from "../lib/gbp-auth.js";
import { syncGbpReviews } from "../lib/google-reviews-sync.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function htmlPage(title: string, body: string, ok: boolean, status = 200): Response {
  const color = ok ? "#059669" : "#dc2626";
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>
     <body style="font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px">
       <h1 style="color:${color}">${title}</h1>${body}
     </body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function requireOwner(request: Request, env: Env): Promise<Response | null> {
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

export async function handleGbpStatus(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  return json(await getGbpStatus(env));
}

export async function handleGbpConnect(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  if (!gbpCredentialsConfigured(env)) {
    return json(
      {
        error: "not_configured",
        message: "Set GBP_CLIENT_ID and GBP_CLIENT_SECRET Worker secrets.",
      },
      { status: 503 },
    );
  }
  const state = makeGbpState();
  await saveGbpState(env, state);
  return json({ authorize_url: buildGbpAuthorizeUrl(env, state) });
}

export async function handleGbpCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return htmlPage(
      "Google Business Profile authorization failed",
      `<p>${escapeHtml(errorParam)}</p>`,
      false,
      400,
    );
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return htmlPage("Bad request", "<p>Callback missing code or state.</p>", false, 400);
  }
  if (!(await verifyGbpState(env, state))) {
    return htmlPage("Invalid state", "<p>The anti-CSRF state token failed verification.</p>", false, 400);
  }
  try {
    await exchangeGbpAuthCode(env, code);
  } catch (err) {
    return htmlPage("Token exchange failed", `<p>${escapeHtml((err as Error).message)}</p>`, false, 502);
  }
  return htmlPage(
    "Google Business Profile connected ✓",
    `<p>CHS can now sync Google reviews and post replies.</p>
     <p>Reviews sync every 30 minutes once <code>gbp_reviews_live</code> is true. You can close this tab.</p>`,
    true,
  );
}

export async function handleGbpDisconnect(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  await disconnectGbp(env);
  return json({ ok: true, status: "disconnected" });
}

export async function handleGbpTest(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  try {
    const accounts = await listGbpAccounts(env);
    const status = await getGbpStatus(env);
    return json({
      ok: true,
      note: accounts[0]
        ? `OK — ${accounts.length} account(s); location: ${status.location_title ?? status.location_name ?? "not set"}`
        : "OK — no accounts returned",
      accounts: accounts.map((a) => a.name),
      location_name: status.location_name,
    });
  } catch (err) {
    return json({ ok: false, note: (err as Error).message }, { status: 502 });
  }
}

export async function handleGbpSync(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  try {
    const stats = await syncGbpReviews(env);
    return json({ ok: !stats.skipped || stats.skipped === "gbp_reviews_live=false", ...stats });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
