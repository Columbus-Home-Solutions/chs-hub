/**
 * Jobber OAuth re-authorization flow.
 *
 * Why this exists:
 *   Jobber refresh tokens carry a fixed set of scopes — minted at the
 *   moment the user clicks "Allow Access". When we add a new scope in the
 *   Developer Center (e.g. `write_expenses`), every existing refresh
 *   token is still missing that scope and the API rejects the call with
 *   "An object of type X was hidden due to permissions".
 *
 *   Rather than juggling curl + `wrangler secret put` every time, this
 *   route exposes a self-serve flow:
 *
 *     1. Tony visits  GET /oauth/jobber/start
 *        → we redirect to Jobber's authorization page.
 *     2. Jobber redirects back to /oauth/jobber/callback?code=...&state=...
 *        → we exchange the code for fresh access + refresh tokens and
 *          UPSERT them into the integrations row that src/lib/jobber/auth.ts
 *          already reads from (id='jobber'). After this, every Jobber
 *          API call automatically uses the new token with the new scopes.
 *     3. /api/jobber/status returns a small JSON snapshot for sanity
 *        checking from the dashboard.
 *
 * Security:
 *   These routes live on the dashboard.homesolutionsar.com host, which
 *   is gated by Cloudflare Access — only authenticated operators can
 *   reach them. We additionally HMAC-sign the OAuth `state` parameter
 *   with JOBBER_CLIENT_SECRET so callbacks can't be replayed across
 *   environments or forged. State payload includes a 10-min timestamp.
 *
 * Configuration prerequisites (one-time, in Jobber Developer Center):
 *   - Add OAuth Callback URL exactly:
 *       https://dashboard.homesolutionsar.com/oauth/jobber/callback
 *   - Enable the desired scopes (e.g. write_expenses) under "Scopes".
 *   - Save. Then visit /oauth/jobber/start to mint a new token.
 */

import type { Env } from "../env.js";

const REDIRECT_URI =
  "https://dashboard.homesolutionsar.com/oauth/jobber/callback";
const AUTHORIZE_URL = "https://api.getjobber.com/api/oauth/authorize";
const TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface JobberTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

// ─── State signing ───────────────────────────────────────────────────
// Stateless HMAC over `${nonce}.${ts}` keyed by the OAuth client secret.
// We don't need server-side state storage — Cloudflare Access already
// authenticates the caller, so this is belt-and-suspenders against
// callback replay/forgery rather than the primary defence.

async function hmacSign(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return b64url(new Uint8Array(sig));
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeState(env: Env): Promise<string> {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const ts = Date.now().toString();
  const payload = `${nonce}.${ts}`;
  const sig = await hmacSign(env.JOBBER_CLIENT_SECRET, payload);
  return `${payload}.${sig}`;
}

async function verifyState(
  env: Env,
  state: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parts = state.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_state" };
  const [nonce, ts, sig] = parts;
  if (!nonce || !ts || !sig) return { ok: false, reason: "malformed_state" };

  const expected = await hmacSign(env.JOBBER_CLIENT_SECRET, `${nonce}.${ts}`);
  if (sig !== expected) return { ok: false, reason: "bad_signature" };

  const issuedAt = Number.parseInt(ts, 10);
  if (!Number.isFinite(issuedAt))
    return { ok: false, reason: "bad_timestamp" };
  if (Date.now() - issuedAt > STATE_TTL_MS)
    return { ok: false, reason: "state_expired" };

  return { ok: true };
}

// ─── Persistence ─────────────────────────────────────────────────────
// Mirrors src/lib/jobber/auth.ts → persistTokens(), but we own the
// initial bootstrap so we also stash the `scope` blob in `config` for
// later inspection via /api/jobber/status.

async function persistFreshTokens(
  env: Env,
  tokens: Required<Pick<JobberTokenResponse, "access_token" | "refresh_token">> &
    Pick<JobberTokenResponse, "expires_in" | "scope">,
): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;
  const config = JSON.stringify({
    scope: tokens.scope ?? null,
    last_reauth_at: now,
    redirect_uri: REDIRECT_URI,
  });

  await env.DB.prepare(
    `INSERT INTO integrations
       (id, kind, config, access_token, refresh_token, token_expires_at,
        enabled, created_at, updated_at)
     VALUES ('jobber', 'oauth', ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       config           = excluded.config,
       access_token     = excluded.access_token,
       refresh_token    = excluded.refresh_token,
       token_expires_at = excluded.token_expires_at,
       updated_at       = excluded.updated_at`,
  )
    .bind(
      config,
      tokens.access_token,
      tokens.refresh_token,
      expiresAt,
      now,
      now,
    )
    .run();
}

// ─── Handlers ────────────────────────────────────────────────────────

/**
 * GET /oauth/jobber/start
 *   Generates a signed state and 302s to Jobber's authorize URL.
 */
export async function handleJobberOAuthStart(
  env: Env,
  _request: Request,
): Promise<Response> {
  if (!env.JOBBER_CLIENT_ID || !env.JOBBER_CLIENT_SECRET) {
    return htmlPage(
      "Configuration error",
      `<p>JOBBER_CLIENT_ID or JOBBER_CLIENT_SECRET is not set in Worker secrets.</p>`,
      false,
    );
  }

  const state = await makeState(env);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.JOBBER_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state,
  });

  return Response.redirect(`${AUTHORIZE_URL}?${params.toString()}`, 302);
}

/**
 * GET /oauth/jobber/callback?code=...&state=...
 *   Validates state, exchanges the code, persists tokens, renders a
 *   success page. On any failure, renders a diagnostic page (HTTP 4xx/5xx)
 *   so the operator sees exactly what went wrong without poking the logs.
 */
export async function handleJobberOAuthCallback(
  env: Env,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);

  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    const desc = url.searchParams.get("error_description") || "";
    return htmlPage(
      "Jobber rejected the authorization",
      `<p><strong>${escapeHtml(errorParam)}</strong>${
        desc ? ` — ${escapeHtml(desc)}` : ""
      }</p>
       <p>Common causes: you cancelled the consent screen, or the app's
       OAuth Callback URL in the Developer Center doesn't match
       <code>${REDIRECT_URI}</code>.</p>`,
      false,
      400,
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return htmlPage(
      "Bad request",
      `<p>Callback missing <code>code</code> or <code>state</code>.</p>`,
      false,
      400,
    );
  }

  const stateCheck = await verifyState(env, state);
  if (!stateCheck.ok) {
    return htmlPage(
      "Invalid state",
      `<p>Reason: <code>${escapeHtml(stateCheck.reason)}</code></p>
       <p>State tokens are valid for ${Math.round(STATE_TTL_MS / 60000)} minutes.
       Start over from <a href="/oauth/jobber/start">/oauth/jobber/start</a>.</p>`,
      false,
      400,
    );
  }

  let tokens: JobberTokenResponse;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.JOBBER_CLIENT_ID,
        client_secret: env.JOBBER_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const bodyText = await res.text();
    try {
      tokens = JSON.parse(bodyText) as JobberTokenResponse;
    } catch {
      return htmlPage(
        "Token exchange failed",
        `<p>Jobber returned non-JSON HTTP ${res.status}.</p>
         <pre>${escapeHtml(bodyText.slice(0, 1000))}</pre>`,
        false,
        502,
      );
    }
    if (!res.ok || tokens.error) {
      return htmlPage(
        "Token exchange failed",
        `<p>Jobber returned HTTP ${res.status}.</p>
         <pre>${escapeHtml(JSON.stringify(tokens, null, 2))}</pre>`,
        false,
        502,
      );
    }
  } catch (err) {
    return htmlPage(
      "Token exchange threw",
      `<p>Network/fetch error: <code>${escapeHtml((err as Error).message)}</code></p>`,
      false,
      502,
    );
  }

  if (!tokens.access_token || !tokens.refresh_token) {
    return htmlPage(
      "Invalid Jobber response",
      `<p>Token endpoint returned 200 but didn't include both
       <code>access_token</code> and <code>refresh_token</code>.</p>
       <pre>${escapeHtml(JSON.stringify(tokens, null, 2))}</pre>`,
      false,
      502,
    );
  }

  try {
    await persistFreshTokens(env, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
    });
  } catch (err) {
    return htmlPage(
      "D1 write failed",
      `<p>Got tokens from Jobber but failed to persist them:
       <code>${escapeHtml((err as Error).message)}</code></p>
       <p>The new tokens are <strong>not</strong> saved. Retry the flow.</p>`,
      false,
      500,
    );
  }

  const scopes = (tokens.scope ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .sort();

  return htmlPage(
    "Jobber re-authorized ✓",
    `<p>New refresh token saved to D1 (<code>integrations</code> id='jobber').
     All Jobber API calls will use this token starting now.</p>
     <h3>Scopes granted</h3>
     ${
       scopes.length === 0
         ? `<p><em>(Jobber didn't echo a scope list — that's normal for some app configurations.)</em></p>`
         : `<ul>${scopes.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join("")}</ul>`
     }
     <p>Next steps:</p>
     <ol>
       <li>Visit <a href="/api/jobber/status">/api/jobber/status</a> to confirm.</li>
       <li>Retry any pending PWA expenses from the job drill-down (PENDING JOBBER → RETRY).</li>
       <li>Close this tab.</li>
     </ol>`,
    true,
  );
}

/**
 * GET /api/jobber/status
 *   Returns a small JSON snapshot of the current Jobber integration row,
 *   suitable for the dashboard to surface "last re-auth" + scope info.
 *   Refresh and access tokens are NEVER returned — only their length and
 *   a short prefix so we can eyeball that the value rotated.
 */
export async function handleJobberStatus(env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, kind, config, token_expires_at, last_synced_at,
            last_error, enabled, updated_at,
            access_token, refresh_token
       FROM integrations WHERE id = 'jobber'`,
  ).first<{
    id: string;
    kind: string;
    config: string | null;
    token_expires_at: string | null;
    last_synced_at: string | null;
    last_error: string | null;
    enabled: number;
    updated_at: string;
    access_token: string | null;
    refresh_token: string | null;
  }>();

  let configParsed: unknown = null;
  if (row?.config) {
    try {
      configParsed = JSON.parse(row.config);
    } catch {
      configParsed = { raw: row.config };
    }
  }

  const body = {
    bootstrapped: !!row,
    integration: row
      ? {
          id: row.id,
          kind: row.kind,
          enabled: !!row.enabled,
          token_expires_at: row.token_expires_at,
          last_synced_at: row.last_synced_at,
          last_error: row.last_error,
          updated_at: row.updated_at,
          config: configParsed,
          access_token_preview: maskToken(row.access_token),
          refresh_token_preview: maskToken(row.refresh_token),
        }
      : null,
    reauth_url: "/oauth/jobber/start",
    callback_url: REDIRECT_URI,
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function maskToken(token: string | null): string | null {
  if (!token) return null;
  if (token.length <= 12) return `len=${token.length}`;
  return `${token.slice(0, 6)}…${token.slice(-4)} (len=${token.length})`;
}

// ─── HTML helpers ────────────────────────────────────────────────────

function htmlPage(
  title: string,
  bodyHtml: string,
  ok: boolean,
  status = 200,
): Response {
  const accent = ok ? "#10b981" : "#ef4444";
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} — chs-hub</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #0b0f17;
      color: #e6edf3;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      background: #11161f;
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 16px;
      padding: 32px;
      max-width: 640px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,.4);
    }
    h1 { margin: 0 0 16px; font-size: 22px; color: ${accent}; }
    h3 { margin: 20px 0 8px; font-size: 14px; color: #8b96a7; text-transform: uppercase; letter-spacing: .5px; }
    p { margin: 8px 0; line-height: 1.55; color: #cdd6df; }
    code { background: rgba(255,255,255,.06); padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; }
    pre { background: rgba(255,255,255,.04); padding: 12px; border-radius: 8px; overflow: auto; font-size: 12px; max-height: 280px; }
    a { color: #60a5fa; }
    ul, ol { color: #cdd6df; }
    li { margin: 4px 0; }
  </style>
</head>
<body>
  <main class="card">
    <h1>${escapeHtml(title)}</h1>
    ${bodyHtml}
  </main>
</body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
