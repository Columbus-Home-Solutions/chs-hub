/**
 * Google Calendar OAuth token lifecycle (read-only calendar scope).
 * Reuses QBO_TOKEN_ENCRYPTION_KEY for token encryption at rest.
 */

import type { Env } from "../env.js";
import { decryptToken, encryptToken } from "./qbo-auth.js";

export const GCAL_SERVICE = "google_calendar";
export const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface GcalConfiguration {
  state?: string;
  email?: string;
  [k: string]: unknown;
}

export interface GcalConnection {
  id: string;
  status: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: string | null;
  configuration: GcalConfiguration;
  last_sync: string | null;
  last_error: string | null;
}

export class GcalReconnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GcalReconnectError";
  }
}

export class GcalNotConnectedError extends Error {
  constructor(message = "Google Calendar is not connected") {
    super(message);
    this.name = "GcalNotConnectedError";
  }
}

function clientId(env: Env): string {
  return (env.DASHBOARD_OAUTH_CLIENT_ID ?? "").trim();
}

function clientSecret(env: Env): string {
  return (env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
}

export function redirectUri(env: Env): string {
  if (env.GOOGLE_CALENDAR_REDIRECT_URI?.trim()) return env.GOOGLE_CALENDAR_REDIRECT_URI.trim();
  return "https://dashboard.homesolutionsar.com/api/integrations/google-calendar/callback";
}

export async function loadGcalConnection(env: Env): Promise<GcalConnection | null> {
  const row = await env.DB.prepare(
    `SELECT id, status, access_token, refresh_token, token_expiry, configuration, last_sync, last_error
       FROM integration_connections WHERE service = ?`,
  )
    .bind(GCAL_SERVICE)
    .first<{
      id: string;
      status: string;
      access_token: string | null;
      refresh_token: string | null;
      token_expiry: string | null;
      configuration: string | null;
      last_sync: string | null;
      last_error: string | null;
    }>();
  if (!row) return null;

  let configuration: GcalConfiguration = {};
  if (row.configuration) {
    try {
      configuration = JSON.parse(row.configuration) as GcalConfiguration;
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
    configuration?: GcalConfiguration;
    status?: string;
  },
): Promise<void> {
  const encAccess = await encryptToken(env, args.accessToken);
  const encRefresh = await encryptToken(env, args.refreshToken);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO integration_connections
       (id, service, status, access_token, refresh_token, token_expiry,
        configuration, last_error, connected_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status        = excluded.status,
       access_token  = excluded.access_token,
       refresh_token = excluded.refresh_token,
       token_expiry  = excluded.token_expiry,
       configuration = COALESCE(excluded.configuration, integration_connections.configuration),
       last_error    = NULL,
       connected_at  = COALESCE(integration_connections.connected_at, excluded.connected_at),
       updated_at    = excluded.updated_at`,
  )
    .bind(
      GCAL_SERVICE,
      GCAL_SERVICE,
      args.status ?? "connected",
      encAccess,
      encRefresh,
      args.expiry,
      args.configuration ? JSON.stringify(args.configuration) : null,
      now,
      now,
      now,
    )
    .run();
}

export async function setGcalError(env: Env, message: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE integration_connections SET status = 'error', last_error = ?, updated_at = ? WHERE service = ?`,
  )
    .bind(message.slice(0, 1000), new Date().toISOString(), GCAL_SERVICE)
    .run();
}

export async function markGcalSynced(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE integration_connections SET last_sync = ?, status = 'connected', last_error = NULL, updated_at = ? WHERE service = ?`,
  )
    .bind(new Date().toISOString(), new Date().toISOString(), GCAL_SERVICE)
    .run();
}

export function makeState(): string {
  return crypto.randomUUID();
}

export async function saveGcalState(env: Env, state: string): Promise<void> {
  const conn = await loadGcalConnection(env);
  const configuration: GcalConfiguration = { ...(conn?.configuration ?? {}), state };
  await env.DB.prepare(
    `INSERT INTO integration_connections (id, service, status, configuration, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET configuration = excluded.configuration, status = 'pending', updated_at = datetime('now')`,
  )
    .bind(GCAL_SERVICE, GCAL_SERVICE, JSON.stringify(configuration))
    .run();
}

export async function verifyGcalState(env: Env, state: string): Promise<boolean> {
  const conn = await loadGcalConnection(env);
  if (!conn?.configuration.state) return false;
  const ok = conn.configuration.state === state;
  if (ok) {
    const { state: _s, ...rest } = conn.configuration;
    await env.DB.prepare(
      `UPDATE integration_connections SET configuration = ?, updated_at = datetime('now') WHERE service = ?`,
    )
      .bind(JSON.stringify(rest), GCAL_SERVICE)
      .run();
  }
  return ok;
}

export function buildAuthorizeUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(env),
    response_type: "code",
    scope: GCAL_SCOPE,
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

export async function exchangeAuthCode(env: Env, code: string): Promise<void> {
  const secret = clientSecret(env);
  if (!clientId(env) || !secret) {
    throw new GcalReconnectError("Google OAuth client ID/secret not configured on the Worker.");
  }
  const data = await exchangeTokens(
    env,
    new URLSearchParams({
      code,
      client_id: clientId(env),
      client_secret: secret,
      redirect_uri: redirectUri(env),
      grant_type: "authorization_code",
    }),
  );
  if (!data.access_token) {
    throw new GcalReconnectError(data.error_description ?? data.error ?? "Token exchange failed");
  }
  const existing = await loadGcalConnection(env);
  const refresh = data.refresh_token ?? existing?.refresh_token;
  if (!refresh) throw new GcalReconnectError("No refresh token returned — try disconnect and reconnect.");
  const expiry = new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString();
  await writeTokens(env, {
    accessToken: data.access_token,
    refreshToken: refresh,
    expiry,
    configuration: existing?.configuration,
    status: "connected",
  });
}

async function refreshAccessToken(env: Env, refreshToken: string): Promise<string> {
  const secret = clientSecret(env);
  if (!clientId(env) || !secret) throw new GcalReconnectError("Google OAuth not configured.");
  const data = await exchangeTokens(
    env,
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId(env),
      client_secret: secret,
      grant_type: "refresh_token",
    }),
  );
  if (!data.access_token) {
    await setGcalError(env, data.error_description ?? data.error ?? "Refresh failed");
    throw new GcalReconnectError(data.error_description ?? data.error ?? "Refresh failed");
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

export async function getValidAccessToken(env: Env): Promise<string> {
  const conn = await loadGcalConnection(env);
  if (!conn || conn.status === "disconnected" || !conn.access_token || !conn.refresh_token) {
    throw new GcalNotConnectedError();
  }
  const expiryMs = conn.token_expiry ? new Date(conn.token_expiry).getTime() : 0;
  if (expiryMs - Date.now() > REFRESH_MARGIN_MS) return conn.access_token;
  return refreshAccessToken(env, conn.refresh_token);
}

export async function disconnectGcal(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE integration_connections
       SET status = 'disconnected', access_token = NULL, refresh_token = NULL,
           token_expiry = NULL, last_error = NULL, updated_at = datetime('now')
     WHERE service = ?`,
  )
    .bind(GCAL_SERVICE)
    .run();
}

export async function getGcalStatus(env: Env): Promise<{
  connected: boolean;
  status: string;
  last_sync: string | null;
  last_error: string | null;
  credentials_present: boolean;
  client_id_configured: boolean;
  client_secret_configured: boolean;
}> {
  const conn = await loadGcalConnection(env);
  const client_id_configured = !!clientId(env);
  const client_secret_configured = !!clientSecret(env);
  const credentials_present = client_id_configured && client_secret_configured;
  if (!conn || conn.status === "disconnected") {
    return {
      connected: false,
      status: "disconnected",
      last_sync: null,
      last_error: null,
      credentials_present,
      client_id_configured,
      client_secret_configured,
    };
  }
  return {
    connected: conn.status === "connected",
    status: conn.status,
    last_sync: conn.last_sync,
    last_error: conn.last_error,
    credentials_present,
    client_id_configured,
    client_secret_configured,
  };
}
