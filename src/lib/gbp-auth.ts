/**
 * Google Business Profile OAuth token lifecycle — Reviews Phase B.
 *
 * Mirrors src/lib/qbo-auth.ts / google-calendar-auth.ts:
 *   - AES-GCM token encryption at rest via qbo-auth encrypt/decrypt helpers
 *     (reuses QBO_TOKEN_ENCRYPTION_KEY — same scheme, not a new crypto path)
 *   - Proactive refresh before expiry; persist rotated tokens before use
 *   - Refresh failure → status='error' + Reconnect (no silent retry loop)
 *
 * Secrets (Worker): GBP_CLIENT_ID, GBP_CLIENT_SECRET
 * Redirect (registered in Google Cloud Console for "CHS - Google Business Profile"):
 *   https://dashboard.homesolutionsar.com/api/integrations/google-business-profile/callback
 */

import type { Env } from "../env.js";
import { decryptToken, encryptToken } from "./qbo-auth.js";

export const GBP_SERVICE = "google_business_profile";
export const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const ACCOUNTS_URL = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_REDIRECT =
  "https://dashboard.homesolutionsar.com/api/integrations/google-business-profile/callback";

export interface GbpConfiguration {
  state?: string;
  /** Full resource name, e.g. accounts/123 */
  account_name?: string;
  /** Business Information API name, e.g. locations/456 */
  location_resource?: string;
  /** Full v4 parent for reviews, e.g. accounts/123/locations/456 */
  location_name?: string;
  location_title?: string;
  account_email?: string;
  [k: string]: unknown;
}

export interface GbpConnection {
  id: string;
  status: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: string | null;
  account_id: string | null;
  configuration: GbpConfiguration;
  last_sync: string | null;
  last_error: string | null;
}

export class GbpReconnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GbpReconnectError";
  }
}

export class GbpNotConnectedError extends Error {
  constructor(message = "Google Business Profile is not connected") {
    super(message);
    this.name = "GbpNotConnectedError";
  }
}

function clientId(env: Env): string {
  return (env.GBP_CLIENT_ID ?? "").trim();
}

function clientSecret(env: Env): string {
  return (env.GBP_CLIENT_SECRET ?? "").trim();
}

export function redirectUri(env: Env): string {
  if (env.GBP_REDIRECT_URI?.trim()) return env.GBP_REDIRECT_URI.trim();
  return DEFAULT_REDIRECT;
}

export function gbpCredentialsConfigured(env: Env): boolean {
  return !!clientId(env) && !!clientSecret(env);
}

export async function loadGbpConnection(env: Env): Promise<GbpConnection | null> {
  const row = await env.DB.prepare(
    `SELECT id, status, access_token, refresh_token, token_expiry, account_id,
            configuration, last_sync, last_error
       FROM integration_connections WHERE service = ?`,
  )
    .bind(GBP_SERVICE)
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

  let configuration: GbpConfiguration = {};
  if (row.configuration) {
    try {
      configuration = JSON.parse(row.configuration) as GbpConfiguration;
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
    accountId?: string | null;
    configuration?: GbpConfiguration;
    status?: string;
  },
): Promise<void> {
  const encAccess = await encryptToken(env, args.accessToken);
  const encRefresh = await encryptToken(env, args.refreshToken);
  const now = new Date().toISOString();

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
       connected_at  = COALESCE(integration_connections.connected_at, excluded.connected_at),
       updated_at    = excluded.updated_at`,
  )
    .bind(
      GBP_SERVICE,
      GBP_SERVICE,
      args.status ?? "connected",
      encAccess,
      encRefresh,
      args.expiry,
      args.accountId ?? null,
      args.configuration ? JSON.stringify(args.configuration) : null,
      now,
      now,
      now,
    )
    .run();
}

export async function setGbpError(env: Env, message: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE integration_connections SET status = 'error', last_error = ?, updated_at = ? WHERE service = ?`,
  )
    .bind(message.slice(0, 1000), new Date().toISOString(), GBP_SERVICE)
    .run();
}

export async function markGbpSynced(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE integration_connections
       SET last_sync = ?, status = 'connected', last_error = NULL, updated_at = ?
     WHERE service = ?`,
  )
    .bind(new Date().toISOString(), new Date().toISOString(), GBP_SERVICE)
    .run();
}

export async function saveGbpConfiguration(
  env: Env,
  configuration: GbpConfiguration,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE integration_connections SET configuration = ?, updated_at = ? WHERE service = ?`,
  )
    .bind(JSON.stringify(configuration), new Date().toISOString(), GBP_SERVICE)
    .run();
}

export function makeGbpState(): string {
  return crypto.randomUUID();
}

export async function saveGbpState(env: Env, state: string): Promise<void> {
  const conn = await loadGbpConnection(env);
  const configuration: GbpConfiguration = { ...(conn?.configuration ?? {}), state };
  await env.DB.prepare(
    `INSERT INTO integration_connections (id, service, status, configuration, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       configuration = excluded.configuration,
       status = 'pending',
       updated_at = datetime('now')`,
  )
    .bind(GBP_SERVICE, GBP_SERVICE, JSON.stringify(configuration))
    .run();
}

export async function verifyGbpState(env: Env, state: string): Promise<boolean> {
  const conn = await loadGbpConnection(env);
  if (!conn?.configuration.state) return false;
  const ok = conn.configuration.state === state;
  if (ok) {
    const { state: _s, ...rest } = conn.configuration;
    await saveGbpConfiguration(env, rest);
  }
  return ok;
}

export function buildGbpAuthorizeUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(env),
    response_type: "code",
    scope: GBP_SCOPE,
    redirect_uri: redirectUri(env),
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function exchangeTokens(env: Env, body: URLSearchParams): Promise<TokenResponse> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return (await resp.json()) as TokenResponse;
}

export async function exchangeGbpAuthCode(env: Env, code: string): Promise<void> {
  if (!gbpCredentialsConfigured(env)) {
    throw new GbpReconnectError("GBP_CLIENT_ID / GBP_CLIENT_SECRET not configured on the Worker.");
  }
  const data = await exchangeTokens(
    env,
    new URLSearchParams({
      code,
      client_id: clientId(env),
      client_secret: clientSecret(env),
      redirect_uri: redirectUri(env),
      grant_type: "authorization_code",
    }),
  );
  if (!data.access_token) {
    throw new GbpReconnectError(data.error_description ?? data.error ?? "Token exchange failed");
  }
  const existing = await loadGbpConnection(env);
  const refresh = data.refresh_token ?? existing?.refresh_token;
  if (!refresh) {
    throw new GbpReconnectError("No refresh token returned — disconnect and reconnect with consent.");
  }
  const expiry = new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString();
  const { state: _s, ...rest } = existing?.configuration ?? {};
  await writeTokens(env, {
    accessToken: data.access_token,
    refreshToken: refresh,
    expiry,
    configuration: rest,
    status: "connected",
  });

  // Discover account + first location for sync/reply.
  try {
    await discoverAndPersistLocation(env);
  } catch (err) {
    // Keep status=connected so token refresh still works; surface discovery issue.
    await env.DB.prepare(
      `UPDATE integration_connections SET last_error = ?, updated_at = ? WHERE service = ?`,
    )
      .bind(
        `Connected, but location discovery failed: ${(err as Error).message}`.slice(0, 1000),
        new Date().toISOString(),
        GBP_SERVICE,
      )
      .run();
  }
}

async function refreshAccessToken(env: Env, refreshToken: string): Promise<string> {
  if (!gbpCredentialsConfigured(env)) throw new GbpReconnectError("GBP OAuth not configured.");
  const data = await exchangeTokens(
    env,
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId(env),
      client_secret: clientSecret(env),
      grant_type: "refresh_token",
    }),
  );
  if (!data.access_token) {
    const msg = data.error_description ?? data.error ?? "Refresh failed";
    await setGbpError(env, msg);
    throw new GbpReconnectError(msg);
  }
  const expiry = new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString();
  await writeTokens(env, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiry,
    status: "connected",
  });
  return data.access_token;
}

let inflightRefresh: Promise<string> | null = null;

export async function getValidGbpAccessToken(env: Env): Promise<string> {
  const conn = await loadGbpConnection(env);
  if (!conn || conn.status === "disconnected" || !conn.refresh_token) {
    throw new GbpNotConnectedError();
  }
  if (conn.status === "error") {
    throw new GbpReconnectError(
      conn.last_error ?? "Google Business Profile connection needs re-authorization",
    );
  }

  const expiresAt = conn.token_expiry ? new Date(conn.token_expiry).getTime() : 0;
  const needsRefresh = !conn.access_token || Date.now() >= expiresAt - REFRESH_MARGIN_MS;
  if (!needsRefresh && conn.access_token) return conn.access_token;

  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = refreshAccessToken(env, conn.refresh_token).finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

/**
 * List GBP accounts (cheap authed call for /test) and optionally pick the first
 * location under the first account for reviews sync.
 */
export async function listGbpAccounts(
  env: Env,
): Promise<Array<{ name: string; accountName?: string; type?: string }>> {
  const token = await getValidGbpAccessToken(env);
  const resp = await fetch(ACCOUNTS_URL, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`accounts.list failed (${resp.status}): ${text.slice(0, 400)}`);
  }
  const data = (await resp.json()) as {
    accounts?: Array<{ name: string; accountName?: string; type?: string }>;
  };
  return data.accounts ?? [];
}

/**
 * Discover GBP account + first location and persist for reviews sync/reply.
 *
 * Account list: Account Management API
 *   GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts
 * Locations: Business Information API (NOT legacy mybusiness.googleapis.com/v4)
 *   GET https://mybusinessbusinessinformation.googleapis.com/v1/{parent}/locations?readMask=…
 *
 * Business Information returns location names as `locations/{id}`. Reviews v4
 * needs `accounts/{accountId}/locations/{locationId}` — we compose that here.
 */
export async function discoverAndPersistLocation(env: Env): Promise<void> {
  const accounts = await listGbpAccounts(env);
  if (accounts.length === 0) {
    throw new Error("No Google Business Profile accounts returned for this Google user.");
  }
  const accountName = accounts[0].name; // accounts/123
  const token = await getValidGbpAccessToken(env);

  const locUrl = new URL(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`,
  );
  locUrl.searchParams.set("readMask", "name,title,storefrontAddress");
  locUrl.searchParams.set("pageSize", "100");

  const locResp = await fetch(locUrl.toString(), {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!locResp.ok) {
    const text = await locResp.text();
    throw new Error(`locations.list failed (${locResp.status}): ${text.slice(0, 400)}`);
  }
  const locData = (await locResp.json()) as {
    locations?: Array<{ name: string; title?: string }>;
  };
  const locations = locData.locations ?? [];
  if (locations.length === 0) {
    throw new Error(`No locations under ${accountName}.`);
  }
  const loc = locations[0];
  // BI name: locations/{id} → v4 reviews parent: accounts/{aid}/locations/{id}
  const locationId = loc.name.replace(/^locations\//, "");
  const locationNameForReviews = `${accountName}/locations/${locationId}`;

  const conn = await loadGbpConnection(env);
  if (!conn?.access_token || !conn.refresh_token) {
    throw new GbpNotConnectedError("GBP tokens missing during location discovery");
  }
  const configuration: GbpConfiguration = {
    ...(conn.configuration ?? {}),
    account_name: accountName,
    location_resource: loc.name,
    location_name: locationNameForReviews,
    location_title: loc.title ?? loc.name,
  };
  const accountId = accountName.replace(/^accounts\//, "");
  await writeTokens(env, {
    accessToken: conn.access_token,
    refreshToken: conn.refresh_token,
    expiry: conn.token_expiry ?? new Date(Date.now() + 3600_000).toISOString(),
    accountId,
    configuration,
    status: "connected",
  });
}

export async function disconnectGbp(env: Env): Promise<void> {
  const conn = await loadGbpConnection(env);
  if (conn?.access_token) {
    try {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(conn.access_token)}`, {
        method: "POST",
      });
    } catch {
      /* best-effort */
    }
  }
  await env.DB.prepare(
    `UPDATE integration_connections
       SET status = 'disconnected', access_token = NULL, refresh_token = NULL,
           token_expiry = NULL, last_error = NULL, updated_at = datetime('now')
     WHERE service = ?`,
  )
    .bind(GBP_SERVICE)
    .run();
}

export async function getGbpStatus(env: Env): Promise<{
  connected: boolean;
  status: string;
  account_id: string | null;
  location_title: string | null;
  location_name: string | null;
  last_sync: string | null;
  last_error: string | null;
  credentials_present: boolean;
}> {
  const conn = await loadGbpConnection(env);
  const credentials_present = gbpCredentialsConfigured(env);
  if (!conn || conn.status === "disconnected") {
    return {
      connected: false,
      status: "disconnected",
      account_id: null,
      location_title: null,
      location_name: null,
      last_sync: null,
      last_error: null,
      credentials_present,
    };
  }
  return {
    connected: conn.status === "connected",
    status: conn.status,
    account_id: conn.account_id,
    location_title: conn.configuration.location_title ?? null,
    location_name: conn.configuration.location_name ?? null,
    last_sync: conn.last_sync,
    last_error: conn.last_error,
    credentials_present,
  };
}
