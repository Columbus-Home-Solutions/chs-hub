/**
 * Google Calendar integration routes (read-only sync).
 *
 *   GET  /api/google-calendar/events
 *   POST /api/google-calendar/sync
 *   GET  /api/google-calendar/status
 *   POST /api/integrations/google-calendar/connect
 *   GET  /api/integrations/google-calendar/callback
 *   POST /api/integrations/google-calendar/disconnect
 */

import type { Env } from "../env.js";
import { authenticateRequest, AuthError } from "../middleware/auth.js";
import { requireRole, RoleError } from "../middleware/roles.js";
import {
  buildAuthorizeUrl,
  disconnectGcal,
  exchangeAuthCode,
  getGcalStatus,
  makeState,
  saveGcalState,
  verifyGcalState,
} from "../lib/google-calendar-auth.js";
import { listUpcomingMeetings, syncGoogleCalendarEvents } from "../lib/google-calendar-sync.js";

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

export async function handleGcalStatus(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  return json(await getGcalStatus(env));
}

export async function handleGcalEvents(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100);
  const meetings = await listUpcomingMeetings(env, limit);
  return json({ events: meetings });
}

export async function handleGcalSync(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  try {
    const stats = await syncGoogleCalendarEvents(env);
    return json({ ok: true, ...stats });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}

export async function handleGcalConnect(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  const status = await getGcalStatus(env);
  if (!status.credentials_present) {
    return json(
      {
        error: "not_configured",
        message: "Set DASHBOARD_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET on the Worker.",
      },
      { status: 503 },
    );
  }
  const state = makeState();
  await saveGcalState(env, state);
  return json({ authorize_url: buildAuthorizeUrl(env, state) });
}

export async function handleGcalCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return htmlPage("Google Calendar authorization failed", `<p>${escapeHtml(errorParam)}</p>`, false, 400);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return htmlPage("Bad request", "<p>Callback missing code or state.</p>", false, 400);
  }
  if (!(await verifyGcalState(env, state))) {
    return htmlPage("Invalid state", "<p>The anti-CSRF state token failed verification.</p>", false, 400);
  }
  try {
    await exchangeAuthCode(env, code);
  } catch (err) {
    return htmlPage("Token exchange failed", `<p>${escapeHtml((err as Error).message)}</p>`, false, 502);
  }
  return htmlPage(
    "Google Calendar connected ✓",
    `<p>CHS can now read your Google Calendar (Meet events only).</p>
     <p>Events sync every 15 minutes. You can close this tab.</p>`,
    true,
  );
}

export async function handleGcalDisconnect(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  await disconnectGcal(env);
  return json({ ok: true, status: "disconnected" });
}

export async function handleDashboardMeetings(env: Env): Promise<Response> {
  const status = await getGcalStatus(env);
  const meetings = status.connected ? await listUpcomingMeetings(env, 5) : [];
  return json({ connected: status.connected, meetings });
}
