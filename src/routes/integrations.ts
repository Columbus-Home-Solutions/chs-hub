/**
 * Integrations API — Sprint 14 (QuickBooks Online).
 *
 *   GET  /api/integrations                              (O) list connections
 *   GET  /api/integrations/:service                     (O) one connection
 *   POST /api/integrations/quickbooks/connect           (O) start OAuth
 *   GET  /api/integrations/quickbooks/callback          (O via Access) finish OAuth
 *   POST /api/integrations/quickbooks/disconnect        (O)
 *   POST /api/integrations/quickbooks/test              (O) CompanyInfo ping
 *   GET  /api/integrations/quickbooks/reference         (O) accounts + match suggestions
 *   POST /api/integrations/quickbooks/mapping           (O) persist client/vendor/account map
 *   GET  /api/quickbooks/status                         (O)
 *   POST /api/quickbooks/sync                           (O) manual sweep
 *
 * Owner-only. Token lifecycle lives in src/lib/qbo-auth.ts; push/pull in
 * src/lib/qbo-sync.ts. QBO stays sandbox this sprint.
 */

import type { Env } from "../env.js";
import { authenticateRequest, AuthError } from "../middleware/auth.js";
import { requireRole, RoleError } from "../middleware/roles.js";
import { writeAudit } from "../lib/audit.js";
import {
  buildAuthorizeUrl,
  disconnect,
  exchangeAuthCode,
  getValidAccessToken,
  loadConnection,
  makeState,
  qboApiBase,
  saveConfiguration,
  verifyState,
  QBO_SERVICE,
} from "../lib/qbo-auth.js";
import {
  fetchAccounts,
  fetchCustomers,
  fetchVendors,
  getQboStatus,
  runQboSweep,
  setAccountMap,
  setClientMapping,
  setVendorMapping,
  suggestClientMatches,
  suggestVendorMatches,
} from "../lib/qbo-sync.js";
import { resolveGoogleServiceAccount } from "../lib/image-gen.js";
import { getSetting, SETTING_IMAGE_GEN_ENABLED } from "../lib/social.js";
import { GCAL_SERVICE } from "../lib/google-calendar-auth.js";
import {
  handleGcalConnect,
  handleGcalDisconnect,
} from "./google-calendar.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
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

// ─── List / detail ──────────────────────────────────────────────────────────

export async function handleIntegrationsList(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  const { results } = await env.DB.prepare(
    `SELECT service, status, account_id, last_sync, last_error, connected_at, updated_at
       FROM integration_connections ORDER BY service`,
  ).all<Record<string, unknown>>();
  return json({ integrations: results ?? [] });
}

/** GET /api/integrations/image-gen/status — Imagen credentials + toggle state (O). */
export async function handleImageGenStatus(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;

  const credentialsPresent = resolveGoogleServiceAccount(env) !== null;
  const raw = (await getSetting(env, SETTING_IMAGE_GEN_ENABLED))?.trim().toLowerCase();
  const enabled = raw !== "false" && raw !== "0";

  return json({
    credentials_present: credentialsPresent,
    enabled,
    configured: credentialsPresent,
  });
}

export async function handleIntegrationDetail(
  request: Request,
  env: Env,
  service: string,
): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  if (service === QBO_SERVICE) {
    return json({ integration: await getQboStatus(env) });
  }
  const row = await env.DB.prepare(
    `SELECT service, status, account_id, last_sync, last_error, connected_at, updated_at
       FROM integration_connections WHERE service = ?`,
  )
    .bind(service)
    .first();
  if (!row) return json({ error: "not_found", service }, { status: 404 });
  return json({ integration: row });
}

// ─── QBO OAuth ───────────────────────────────────────────────────────────────

export async function handleQboConnect(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  if (!env.QBO_CLIENT_ID || !env.QBO_CLIENT_SECRET || !env.QBO_REDIRECT_URI) {
    return json(
      { error: "config_error", message: "QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REDIRECT_URI not set" },
      { status: 500 },
    );
  }
  const state = await makeState(env);
  // Stash state in configuration so the (Access-gated) callback can double-check.
  const conn = await loadConnection(env);
  await saveConfiguration(env, { environment: "sandbox", ...(conn?.configuration ?? {}), state });
  const authorize_url = buildAuthorizeUrl(env, state);
  return json({ authorize_url });
}

export async function handleQboCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return htmlPage("QuickBooks authorization failed", `<p>${escapeHtml(errorParam)}</p>`, false, 400);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const realmId = url.searchParams.get("realmId");
  if (!code || !state || !realmId) {
    return htmlPage("Bad request", `<p>Callback missing code, state, or realmId.</p>`, false, 400);
  }
  if (!(await verifyState(env, state))) {
    return htmlPage("Invalid state", `<p>The anti-CSRF state token failed verification or expired.</p>`, false, 400);
  }
  try {
    await exchangeAuthCode(env, code, realmId, "sandbox");
  } catch (err) {
    return htmlPage("Token exchange failed", `<p>${escapeHtml((err as Error).message)}</p>`, false, 502);
  }
  // Best-effort company name fetch so the UI can show it.
  try {
    const conn = await loadConnection(env);
    if (conn?.account_id) {
      const token = await getValidAccessToken(env);
      const base = qboApiBase(conn.configuration.environment, conn.account_id);
      const resp = await fetch(`${base}/companyinfo/${conn.account_id}?minorversion=70`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (resp.ok) {
        const data = (await resp.json()) as { CompanyInfo?: { CompanyName?: string } };
        const name = data.CompanyInfo?.CompanyName;
        if (name) await saveConfiguration(env, { ...conn.configuration, company_name: name, state: undefined });
      }
    }
  } catch {
    /* non-fatal */
  }
  return htmlPage(
    "QuickBooks connected ✓",
    `<p>CHS is now connected to your QuickBooks <strong>sandbox</strong> company (realmId ${escapeHtml(realmId)}).</p>
     <p>Next: map your expense categories and confirm customer/vendor matches in System Settings → Integrations.</p>
     <p>You can close this tab.</p>`,
    true,
  );
}

export async function handleQboDisconnect(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  await disconnect(env);
  return json({ ok: true, status: "disconnected" });
}

export async function handleQboTest(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  const conn = await loadConnection(env);
  if (!conn || conn.status === "disconnected" || !conn.account_id) {
    return json({ ok: false, error: "not_connected" }, { status: 400 });
  }
  try {
    const token = await getValidAccessToken(env);
    const base = qboApiBase(conn.configuration.environment, conn.account_id);
    const resp = await fetch(`${base}/companyinfo/${conn.account_id}?minorversion=70`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!resp.ok) {
      const text = await resp.text();
      await env.DB.prepare(
        `UPDATE integration_connections SET last_error = ?, updated_at = datetime('now') WHERE service = ?`,
      )
        .bind(`test failed (${resp.status}): ${text.slice(0, 300)}`, QBO_SERVICE)
        .run();
      return json({ ok: false, status: resp.status, error: text.slice(0, 300) }, { status: 502 });
    }
    const data = (await resp.json()) as { CompanyInfo?: { CompanyName?: string } };
    await env.DB.prepare(
      `UPDATE integration_connections SET last_sync = datetime('now'), last_error = NULL, updated_at = datetime('now') WHERE service = ?`,
    )
      .bind(QBO_SERVICE)
      .run();
    return json({ ok: true, company_name: data.CompanyInfo?.CompanyName ?? null });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}

// ─── Reference pull + mapping ─────────────────────────────────────────────────

export async function handleQboReference(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  const conn = await loadConnection(env);
  if (!conn || conn.status !== "connected") {
    return json({ error: "not_connected" }, { status: 400 });
  }
  try {
    const [accounts, allCustomers, allVendors, clients, vendors] = await Promise.all([
      fetchAccounts(env, conn),
      fetchCustomers(env, conn),
      fetchVendors(env, conn),
      suggestClientMatches(env, conn),
      suggestVendorMatches(env, conn),
    ]);
    // Distinct expense_type values present in CHS, so the UI can map each.
    const et = await env.DB.prepare(
      `SELECT DISTINCT expense_type FROM expenses WHERE expense_type IS NOT NULL AND expense_type <> '' ORDER BY expense_type`,
    ).all<{ expense_type: string }>();
    return json({
      accounts,
      all_customers: allCustomers,
      all_vendors: allVendors,
      clients,
      vendors,
      expense_types: (et.results ?? []).map((r) => r.expense_type),
      account_map: conn.configuration.account_map ?? {},
      payment_account_ref: conn.configuration.payment_account_ref ?? null,
    });
  } catch (err) {
    return json({ error: "qbo_fetch_failed", message: (err as Error).message }, { status: 502 });
  }
}

export async function handleQboMapping(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  const conn = await loadConnection(env);
  if (!conn) return json({ error: "not_connected" }, { status: 400 });

  let body: {
    clients?: Record<string, string | null>;
    vendors?: Record<string, string | null>;
    account_map?: Record<string, string>;
    payment_account_ref?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "bad_request", message: "Body must be JSON" }, { status: 400 });
  }

  if (body.clients) {
    for (const [clientId, qboId] of Object.entries(body.clients)) {
      await setClientMapping(env, clientId, qboId);
    }
  }
  if (body.vendors) {
    for (const [subId, qboId] of Object.entries(body.vendors)) {
      await setVendorMapping(env, subId, qboId);
    }
  }
  if (body.account_map || body.payment_account_ref !== undefined) {
    const fresh = await loadConnection(env);
    const config = { ...(fresh?.configuration ?? conn.configuration) };
    if (body.account_map) config.account_map = body.account_map;
    if (body.payment_account_ref !== undefined) config.payment_account_ref = body.payment_account_ref;
    await saveConfiguration(env, config);
  }
  return json({ ok: true });
}

// ─── Status + manual sweep ─────────────────────────────────────────────────────

export async function handleQboStatus(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  return json(await getQboStatus(env));
}

export async function handleQboSync(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  const result = await runQboSweep(env);
  return json(result, { status: result.ran ? 200 : 409 });
}

// ─── Generic per-service management (Sprint 17) ───────────────────────────────
//
// QBO keeps its dedicated OAuth routes above. These manage ANY existing
// integration_connections row (test/connect/disconnect) without wiring a new
// live service. Owner-only is enforced by the central RBAC gate. Tokens are
// NEVER read or returned here (business rule 5).

/** Services whose "connection" is config-based (no OAuth) and SIMULATE/sandbox. */
const SIMULATE_SERVICES: Record<string, string> = {
  twilio: "SMS sends are SIMULATE unless NOTIFICATIONS_DISPATCH_MODE=live",
  resend: "Email sends honor the notification dispatch mode",
  facebook: "Social publishing is SIMULATE unless social_publish_mode=live",
  instagram: "Social publishing is SIMULATE unless social_publish_mode=live",
  stripe: "Stripe runs in TEST mode this sprint",
  wc_spreadsheet: "WC sync targets the TEST sheet this sprint",
  google_drive: "Drive mirror runs against the configured Shared Drive",
};

function actorOf(request: Request): string {
  const u = (request as Request & { user?: { email?: string } }).user;
  return u?.email ?? request.headers.get("Cf-Access-Authenticated-User-Email") ?? "owner";
}

export async function handleIntegrationTest(
  request: Request,
  env: Env,
  service: string,
): Promise<Response> {
  // QBO has a live CompanyInfo ping; route there for parity.
  if (service === QBO_SERVICE) return handleQboTest(request, env);

  const row = await env.DB.prepare(
    `SELECT service, status, last_sync, last_error FROM integration_connections WHERE service = ?`,
  )
    .bind(service)
    .first<{ service: string; status: string; last_sync: string | null; last_error: string | null }>();

  if (!row) {
    return json({ ok: false, service, status: "not_configured" }, { status: 404 });
  }

  const note = SIMULATE_SERVICES[service] ?? "Connection record present; no live test wired this sprint.";
  // Honest report: we don't fake a live ping for SIMULATE/sandbox services.
  return json({
    ok: row.status === "connected",
    service,
    status: row.status,
    last_sync: row.last_sync,
    last_error: row.last_error,
    mode: "simulate_or_sandbox",
    note,
  });
}

export async function handleIntegrationConnect(
  request: Request,
  env: Env,
  service: string,
): Promise<Response> {
  if (service === QBO_SERVICE) return handleQboConnect(request, env);
  if (service === GCAL_SERVICE) return handleGcalConnect(request, env);

  let body: { configuration?: Record<string, unknown> } = {};
  try {
    body = (await request.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }

  const now = new Date().toISOString();
  const config = body.configuration ? JSON.stringify(body.configuration) : null;
  await env.DB.prepare(
    `INSERT INTO integration_connections (id, service, status, configuration, connected_at, connected_by, created_at, updated_at)
     VALUES (?, ?, 'connected', ?, ?, ?, ?, ?)
     ON CONFLICT(service) DO UPDATE SET
       status = 'connected',
       configuration = COALESCE(excluded.configuration, integration_connections.configuration),
       connected_at = excluded.connected_at,
       connected_by = excluded.connected_by,
       updated_at = excluded.updated_at`,
  )
    .bind(crypto.randomUUID(), service, config, now, actorOf(request), now, now)
    .run();

  await writeAudit(env, {
    userEmail: actorOf(request),
    action: "integration.connect",
    entityType: "integration_connection",
    entityId: service,
    details: { service },
    ipAddress: request.headers.get("cf-connecting-ip"),
  });

  return json({ ok: true, service, status: "connected" });
}

export async function handleIntegrationDisconnect(
  request: Request,
  env: Env,
  service: string,
): Promise<Response> {
  if (service === QBO_SERVICE) return handleQboDisconnect(request, env);
  if (service === GCAL_SERVICE) return handleGcalDisconnect(request, env);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE integration_connections SET status = 'disconnected', updated_at = ? WHERE service = ?`,
  )
    .bind(now, service)
    .run();

  await writeAudit(env, {
    userEmail: actorOf(request),
    action: "integration.disconnect",
    entityType: "integration_connection",
    entityId: service,
    details: { service },
    ipAddress: request.headers.get("cf-connecting-ip"),
  });

  return json({ ok: true, service, status: "disconnected" });
}

// ─── HTML callback page ───────────────────────────────────────────────────────

function htmlPage(title: string, bodyHtml: string, ok: boolean, status = 200): Response {
  const accent = ok ? "#10b981" : "#ef4444";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — chs-hub</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#0b0f17;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#11161f;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:32px;max-width:640px;width:100%}h1{margin:0 0 16px;font-size:22px;color:${accent}}p{margin:8px 0;line-height:1.55;color:#cdd6df}code{background:rgba(255,255,255,.06);padding:2px 6px;border-radius:4px}</style>
</head><body><main class="card"><h1>${escapeHtml(title)}</h1>${bodyHtml}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
