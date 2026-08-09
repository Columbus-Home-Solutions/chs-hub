/**
 * QuickBooks Online OAuth 2.0 token lifecycle — Sprint 14 (Opus piece).
 *
 * The single hard part of the QBO integration: the authorization-code
 * exchange and, more importantly, the proactive access-token refresh with
 * **atomic refresh-token rotation**.
 *
 * Intuit rotates the refresh token roughly every 24h and returns a (possibly
 * new) refresh_token on every /token call. The documented #1 failure mode is a
 * refresh that uses the new access token but forgets to persist the new refresh
 * token — the next refresh then presents a stale refresh token and Intuit
 * invalidates the whole connection. So the contract here is:
 *
 *   1. Refresh PROACTIVELY (before expiry, within a safety margin) — never wait
 *      for a 401.
 *   2. Persist the returned refresh_token + access_token + expiry in a SINGLE
 *      write BEFORE the token is handed back to a caller.
 *   3. Single-flight: the manual trigger and the nightly sweep can overlap, so
 *      an in-isolate promise lock collapses concurrent refreshes.
 *   4. A failed/expired refresh sets status='error' + last_error and surfaces a
 *      Reconnect state — it does NOT silently retry forever.
 *
 * Tokens are stored AES-GCM-encrypted at rest in integration_connections
 * (access_token / refresh_token columns). See crypto helpers below — there was
 * no pre-existing encryption scheme in the repo (Jobber stores plaintext in a
 * separate `integrations` table), so this is new and flagged in report-back.
 */

import type { Env } from "../env.js";

export const QBO_SERVICE = "quickbooks";
export const QBO_SCOPE = "com.intuit.quickbooks.accounting";

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

// Refresh when the access token has < 5 min left. Intuit access tokens live
// ~60 min; this margin keeps a sweep from racing an expiry mid-run.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type QboEnvironment = "sandbox" | "production";

export interface QboConfiguration {
  environment: QboEnvironment;
  company_name?: string;
  // expense_type -> QBO Account id (the reference mapping, persisted here)
  account_map?: Record<string, string>;
  /** Bank/credit account money leaves from for non-sub (materials, etc.) Purchases. */
  payment_account_ref?: string;
  /** Optional override for subcontractor Purchases; falls back to payment_account_ref. */
  subcontractor_payment_account_ref?: string;
  state?: string; // transient anti-CSRF token for the in-flight auth handshake
  [k: string]: unknown;
}

export interface QboConnection {
  id: string;
  status: string;
  access_token: string | null; // decrypted
  refresh_token: string | null; // decrypted
  token_expiry: string | null;
  account_id: string | null; // QBO realmId
  configuration: QboConfiguration;
  last_sync: string | null;
  last_error: string | null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  x_refresh_token_expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export class QboReconnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QboReconnectError";
  }
}

export class QboNotConnectedError extends Error {
  constructor(message = "QuickBooks is not connected") {
    super(message);
    this.name = "QboNotConnectedError";
  }
}

// ─── Base URLs (environment + realmId scoped) ────────────────────────────

/** Normalize stored/legacy values to a known QBO environment. */
export function normalizeQboEnvironment(value: unknown): QboEnvironment {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return v === "production" ? "production" : "sandbox";
}

export function qboApiHost(environment: QboEnvironment): string {
  return environment === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

export function qboApiBase(environment: QboEnvironment, realmId: string): string {
  return `${qboApiHost(environment)}/v3/company/${realmId}`;
}

/**
 * Single source of truth for outbound QBO API targeting: always re-reads
 * `integration_connections.configuration.environment` + `account_id` from D1.
 * Auth, reference pull, and push all go through this (via qboFetch / test).
 */
export async function resolveQboApiContext(env: Env): Promise<{
  connection: QboConnection;
  environment: QboEnvironment;
  realmId: string;
  apiHost: string;
  apiBase: string;
}> {
  const connection = await loadConnection(env);
  if (!connection || connection.status === "disconnected" || !connection.account_id) {
    throw new QboNotConnectedError();
  }
  const environment = normalizeQboEnvironment(connection.configuration.environment);
  // Keep the in-memory config aligned with what we will actually call.
  connection.configuration.environment = environment;
  const apiHost = qboApiHost(environment);
  const apiBase = qboApiBase(environment, connection.account_id);
  return { connection, environment, realmId: connection.account_id, apiHost, apiBase };
}

// ─── Connection load / persist ───────────────────────────────────────────

export async function loadConnection(env: Env): Promise<QboConnection | null> {
  const row = await env.DB.prepare(
    `SELECT id, status, access_token, refresh_token, token_expiry, account_id,
            configuration, last_sync, last_error
       FROM integration_connections WHERE service = ?`,
  )
    .bind(QBO_SERVICE)
    .first<{
      id: string;
      status: string;
      access_token: string | null;
      refresh_token: string | null;
      token_expiry: string | null;
      account_id: string | null;
      configuration: string | null;
      last_sync: string | null;
      last_error: string | null;
    }>();
  if (!row) return null;

  let configuration: QboConfiguration = { environment: "sandbox" };
  if (row.configuration) {
    try {
      const parsed = JSON.parse(row.configuration) as Partial<QboConfiguration>;
      configuration = {
        ...parsed,
        environment: normalizeQboEnvironment(parsed.environment ?? "sandbox"),
      };
    } catch {
      /* keep default */
    }
  }

  return {
    id: row.id,
    status: row.status,
    access_token: await decryptToken(env, row.access_token),
    refresh_token: await decryptToken(env, row.refresh_token),
    token_expiry: row.token_expiry,
    account_id: row.account_id,
    configuration,
    last_sync: row.last_sync,
    last_error: row.last_error,
  };
}

async function writeTokens(
  env: Env,
  args: {
    accessToken: string;
    refreshToken: string;
    expiry: string;
    realmId?: string | null;
    configuration?: QboConfiguration;
    status?: string;
  },
): Promise<void> {
  const encAccess = await encryptToken(env, args.accessToken);
  const encRefresh = await encryptToken(env, args.refreshToken);
  const now = new Date().toISOString();

  // Upsert keyed on the PRIMARY KEY `id`. `integration_connections.service` is
  // CHECK-constrained but NOT unique, so the row id is deterministically the
  // service name — one row per service. A single write persists BOTH tokens;
  // this atomicity is the entire point (rotation must never lose the refresh).
  await env.DB.prepare(
    `INSERT INTO integration_connections
       (id, service, status, access_token, refresh_token, token_expiry,
        account_id, configuration, last_error, connected_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status        = excluded.status,
       access_token  = excluded.access_token,
       refresh_token = excluded.refresh_token,
       token_expiry  = excluded.token_expiry,
       account_id    = COALESCE(excluded.account_id, integration_connections.account_id),
       configuration = COALESCE(excluded.configuration, integration_connections.configuration),
       last_error    = NULL,
       updated_at    = excluded.updated_at`,
  )
    .bind(
      QBO_SERVICE,
      QBO_SERVICE,
      args.status ?? "connected",
      encAccess,
      encRefresh,
      args.expiry,
      args.realmId ?? null,
      args.configuration ? JSON.stringify(args.configuration) : null,
      now,
      now,
      now,
    )
    .run();
}

export async function setConnectionError(env: Env, message: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE integration_connections
       SET status = 'error', last_error = ?, updated_at = ?
     WHERE service = ?`,
  )
    .bind(message.slice(0, 1000), new Date().toISOString(), QBO_SERVICE)
    .run();
}

export async function markSynced(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE integration_connections SET last_sync = ?, updated_at = ? WHERE service = ?`,
  )
    .bind(new Date().toISOString(), new Date().toISOString(), QBO_SERVICE)
    .run();
}

export async function saveConfiguration(
  env: Env,
  configuration: QboConfiguration,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE integration_connections SET configuration = ?, updated_at = ? WHERE service = ?`,
  )
    .bind(JSON.stringify(configuration), new Date().toISOString(), QBO_SERVICE)
    .run();
}

// ─── Authorization-code flow ───────────────────────────────────────────────

export function buildAuthorizeUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.QBO_CLIENT_ID ?? "",
    response_type: "code",
    scope: QBO_SCOPE,
    redirect_uri: env.QBO_REDIRECT_URI ?? "",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange the authorization code for tokens and persist them encrypted.
 *
 * Merges into the existing `configuration` JSON — never replaces it wholesale.
 * `environment` defaults to sandbox only when the key is absent (brand-new
 * connection); a prior production cutover / mapping config survives reconnect.
 */
export async function exchangeAuthCode(
  env: Env,
  code: string,
  realmId: string,
): Promise<void> {
  const resp = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.QBO_REDIRECT_URI ?? "",
  });
  if (!resp.access_token || !resp.refresh_token) {
    throw new Error(
      `Token exchange returned no tokens: ${resp.error ?? ""} ${resp.error_description ?? ""}`.trim(),
    );
  }

  const existing = await loadConnection(env);
  const prev: Partial<QboConfiguration> = existing?.configuration ?? {};
  const configuration: QboConfiguration = {
    ...prev,
    environment: prev.environment ?? "sandbox",
  };
  // CSRF state is handshake-only; drop it after a successful exchange.
  delete configuration.state;

  await writeTokens(env, {
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token,
    expiry: expiryIso(resp.expires_in),
    realmId,
    configuration,
    status: "connected",
  });
}

export async function disconnect(env: Env): Promise<void> {
  const conn = await loadConnection(env);
  if (conn?.refresh_token) {
    // Best-effort revoke; never block disconnect on Intuit's response.
    try {
      await fetch(REVOKE_URL, {
        method: "POST",
        headers: {
          authorization: `Basic ${basicAuth(env)}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ token: conn.refresh_token }),
      });
    } catch {
      /* ignore */
    }
  }
  await env.DB.prepare(
    `UPDATE integration_connections
       SET status = 'disconnected', access_token = NULL, refresh_token = NULL,
           token_expiry = NULL, last_error = NULL, updated_at = ?
     WHERE service = ?`,
  )
    .bind(new Date().toISOString(), QBO_SERVICE)
    .run();
}

// ─── getValidAccessToken — proactive refresh + atomic rotation (Opus) ───────

// In-isolate single-flight lock. The nightly sweep is single-threaded but the
// manual trigger can overlap it; collapsing concurrent refreshes prevents two
// requests from each rotating the refresh token (the second would 400).
let inflightRefresh: Promise<string> | null = null;

export async function getValidAccessToken(
  env: Env,
  opts?: { forceRefresh?: boolean },
): Promise<string> {
  const conn = await loadConnection(env);
  if (!conn || conn.status === "disconnected" || !conn.refresh_token) {
    throw new QboNotConnectedError();
  }
  // Self-heal: status=error used to latch forever (same class of bug as GBP).
  // A prior refresh blip must not freeze QBO until a human reconnects — try one
  // refresh; doRefresh clears status to 'connected' on success, or re-latches
  // with a fresh last_error if Intuit still rejects the refresh token.
  if (conn.status === "error") {
    console.warn(
      `[qbo] connection status=error — attempting self-heal refresh (${conn.last_error ?? "no last_error"})`,
    );
    if (inflightRefresh) return inflightRefresh;
    inflightRefresh = doRefresh(env, conn.refresh_token).finally(() => {
      inflightRefresh = null;
    });
    return inflightRefresh;
  }

  const expiresAt = conn.token_expiry ? new Date(conn.token_expiry).getTime() : 0;
  const needsRefresh =
    !!opts?.forceRefresh ||
    !conn.access_token ||
    Date.now() >= expiresAt - REFRESH_MARGIN_MS;
  if (!needsRefresh && conn.access_token) {
    return conn.access_token;
  }

  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = doRefresh(env, conn.refresh_token).finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

/** Safe token shape for logs/API diagnostics — never the full secret. */
export function tokenShape(token: string | null | undefined): {
  present: boolean;
  length: number;
  prefix: string | null;
  looks_like_jwt: boolean;
} {
  if (!token) return { present: false, length: 0, prefix: null, looks_like_jwt: false };
  return {
    present: true,
    length: token.length,
    prefix: token.slice(0, 10),
    looks_like_jwt: token.startsWith("eyJ"),
  };
}

/** Best-effort JWT payload decode (Intuit access tokens are often JWTs). */
export function peekJwtPayload(token: string): Record<string, unknown> | null {
  if (!token.startsWith("eyJ")) return null;
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface QboProbeHostResult {
  host: string;
  url: string;
  http_status: number;
  ok: boolean;
  intuit_tid: string | null;
  body_excerpt: string | null;
  company_name: string | null;
}

export interface QboConnectionProbe {
  ok: boolean;
  environment: QboEnvironment;
  realm_id: string;
  api_host: string;
  url: string;
  client_id_prefix: string | null;
  token: ReturnType<typeof tokenShape>;
  jwt_claims: Record<string, unknown> | null;
  jwt_realmid: string | null;
  realm_matches_jwt: boolean | null;
  token_expiry_before: string | null;
  token_expiry_after_refresh: string | null;
  refreshed: boolean;
  primary: QboProbeHostResult;
  /** Only populated when primary fails — rules out host/token mismatch. */
  alternate_host: QboProbeHostResult | null;
}

async function probeCompanyInfo(
  host: string,
  realmId: string,
  token: string,
): Promise<QboProbeHostResult> {
  const url = `${host}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=70`;
  const resp = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const intuit_tid = resp.headers.get("intuit_tid");
  const text = await resp.text();
  let company_name: string | null = null;
  if (resp.ok) {
    try {
      const data = JSON.parse(text) as { CompanyInfo?: { CompanyName?: string } };
      company_name = data.CompanyInfo?.CompanyName ?? null;
    } catch {
      /* ignore */
    }
  }
  return {
    host,
    url,
    http_status: resp.status,
    ok: resp.ok,
    intuit_tid,
    body_excerpt: resp.ok ? null : text.slice(0, 400),
    company_name,
  };
}

/**
 * Deep connection probe for Test Connection / support escalation.
 * Force-refreshes the access token, calls production (or configured) CompanyInfo,
 * and on failure also probes the opposite host with the same token.
 */
export async function runQboConnectionProbe(env: Env): Promise<QboConnectionProbe> {
  const before = await loadConnection(env);
  if (!before?.account_id) throw new QboNotConnectedError();
  const tokenExpiryBefore = before.token_expiry;

  const token = await getValidAccessToken(env, { forceRefresh: true });
  const after = await loadConnection(env);
  const ctx = await resolveQboApiContext(env);

  const shape = tokenShape(token);
  const jwt = peekJwtPayload(token);
  const jwtRealmid = jwt
    ? String(
        jwt.realmid ??
          jwt.realmId ??
          (jwt as { realmid?: unknown }).realmid ??
          "",
      ) || null
    : null;

  console.log(
    `[qbo-probe] env=${ctx.environment} host=${ctx.apiHost} realm=${ctx.realmId} ` +
      `token_len=${shape.length} prefix=${shape.prefix} jwt_realmid=${jwtRealmid ?? "n/a"} ` +
      `client_id_prefix=${(env.QBO_CLIENT_ID ?? "").slice(0, 8) || "missing"}`,
  );

  const primary = await probeCompanyInfo(ctx.apiHost, ctx.realmId, token);
  console.log(
    `[qbo-probe] primary status=${primary.http_status} tid=${primary.intuit_tid ?? "none"} url=${primary.url}`,
  );

  let alternate: QboProbeHostResult | null = null;
  if (!primary.ok) {
    const otherHost = qboApiHost(ctx.environment === "production" ? "sandbox" : "production");
    alternate = await probeCompanyInfo(otherHost, ctx.realmId, token);
    console.log(
      `[qbo-probe] alternate status=${alternate.http_status} tid=${alternate.intuit_tid ?? "none"} url=${alternate.url}`,
    );
  }

  const realmMatchesJwt =
    jwtRealmid == null ? null : jwtRealmid === ctx.realmId;

  return {
    ok: primary.ok,
    environment: ctx.environment,
    realm_id: ctx.realmId,
    api_host: ctx.apiHost,
    url: primary.url,
    client_id_prefix: env.QBO_CLIENT_ID ? env.QBO_CLIENT_ID.slice(0, 8) : null,
    token: shape,
    jwt_claims: jwt
      ? {
          // Keep only non-sensitive identifying claims for the UI / escalation.
          realmid: jwt.realmid ?? jwt.realmId ?? null,
          aud: jwt.aud ?? null,
          iss: jwt.iss ?? null,
          exp: jwt.exp ?? null,
        }
      : null,
    jwt_realmid: jwtRealmid,
    realm_matches_jwt: realmMatchesJwt,
    token_expiry_before: tokenExpiryBefore,
    token_expiry_after_refresh: after?.token_expiry ?? null,
    refreshed:
      !!tokenExpiryBefore &&
      !!after?.token_expiry &&
      tokenExpiryBefore !== after.token_expiry,
    primary,
    alternate_host: alternate,
  };
}

async function doRefresh(env: Env, refreshToken: string): Promise<string> {
  let resp: TokenResponse;
  try {
    resp = await tokenRequest(env, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  } catch (err) {
    await setConnectionError(env, `Token refresh request failed: ${(err as Error).message}`);
    throw new QboReconnectError((err as Error).message);
  }

  if (resp.error || !resp.access_token || !resp.refresh_token) {
    const msg = `Refresh rejected: ${resp.error ?? "no_tokens"} ${resp.error_description ?? ""}`.trim();
    // A rejected refresh means the refresh token is revoked/expired → Reconnect.
    await setConnectionError(env, msg);
    throw new QboReconnectError(msg);
  }

  // ATOMIC: persist the (possibly rotated) refresh token + new access token in
  // a single write BEFORE returning the token to any caller.
  await writeTokens(env, {
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token,
    expiry: expiryIso(resp.expires_in),
    status: "connected",
  });
  return resp.access_token;
}

// ─── Low-level token endpoint call ─────────────────────────────────────────

async function tokenRequest(
  env: Env,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basicAuth(env)}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(body),
  });
  const text = await resp.text();
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`token endpoint returned non-JSON (${resp.status}): ${text.slice(0, 300)}`);
  }
  if (!resp.ok && !parsed.error) {
    parsed.error = `http_${resp.status}`;
    parsed.error_description = text.slice(0, 300);
  }
  return parsed;
}

function basicAuth(env: Env): string {
  return btoa(`${env.QBO_CLIENT_ID ?? ""}:${env.QBO_CLIENT_SECRET ?? ""}`);
}

function expiryIso(expiresIn?: number): string {
  return new Date(Date.now() + (expiresIn ?? 3600) * 1000).toISOString();
}

// ─── AES-GCM token encryption at rest ───────────────────────────────────────
// No pre-existing scheme in the repo (flagged in report-back). Key material is
// SHA-256(QBO_TOKEN_ENCRYPTION_KEY) → 256-bit AES-GCM key. Ciphertext is stored
// as base64 "v1:<iv>:<ct>". A documented dev-only fallback key keeps local dev
// working without the secret (logs a one-time warning).

const DEV_FALLBACK_KEY = "chs-hub-dev-only-qbo-token-key-do-not-use-in-prod";
let warnedFallback = false;
let cachedKey: { material: string; key: CryptoKey } | null = null;

async function getCryptoKey(env: Env): Promise<CryptoKey> {
  let material = env.QBO_TOKEN_ENCRYPTION_KEY;
  if (!material) {
    if (!warnedFallback) {
      console.warn(
        "[qbo] QBO_TOKEN_ENCRYPTION_KEY not set — using dev-only fallback key. Set the secret before any non-local use.",
      );
      warnedFallback = true;
    }
    material = DEV_FALLBACK_KEY;
  }
  if (cachedKey && cachedKey.material === material) return cachedKey.key;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  cachedKey = { material, key };
  return key;
}

export async function encryptToken(env: Env, plaintext: string | null): Promise<string | null> {
  if (plaintext == null) return null;
  const key = await getCryptoKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v1:${b64(iv)}:${b64(new Uint8Array(ct))}`;
}

export async function decryptToken(env: Env, stored: string | null): Promise<string | null> {
  if (stored == null) return null;
  if (!stored.startsWith("v1:")) return stored; // tolerate any legacy plaintext
  const parts = stored.split(":");
  if (parts.length !== 3) return null;
  try {
    const key = await getCryptoKey(env);
    const iv = unb64(parts[1]);
    const ct = unb64(parts[2]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// ─── State (anti-CSRF) signing — reuses the HMAC pattern from oauth-jobber ──

export async function makeState(env: Env): Promise<string> {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const ts = Date.now().toString();
  const sig = await hmacSign(env, `${nonce}.${ts}`);
  return `${nonce}.${ts}.${sig}`;
}

export async function verifyState(env: Env, state: string): Promise<boolean> {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [nonce, ts, sig] = parts;
  if (!nonce || !ts || !sig) return false;
  const expected = await hmacSign(env, `${nonce}.${ts}`);
  if (sig !== expected) return false;
  const issued = Number.parseInt(ts, 10);
  if (!Number.isFinite(issued)) return false;
  return Date.now() - issued <= 10 * 60 * 1000;
}

async function hmacSign(env: Env, payload: string): Promise<string> {
  const secret = env.QBO_CLIENT_SECRET ?? env.QBO_TOKEN_ENCRYPTION_KEY ?? DEV_FALLBACK_KEY;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return b64(new Uint8Array(sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
