/**
 * Jobber OAuth token management.
 *
 * Jobber rotates refresh tokens on every use, which makes atomic persistence
 * of the new token mandatory — if we don't save it, the next run 401s.
 *
 * Strategy:
 *   - Refresh token lives in D1 `integrations` table (id='jobber')
 *   - On first run (or if that row is missing), bootstrap from the
 *     JOBBER_REFRESH_TOKEN Worker secret
 *   - After every successful refresh, persist the new refresh_token to D1
 *     BEFORE returning the access_token to the caller
 *   - If D1 persistence fails, we throw — better to 500 the sync than to
 *     silently discard a rotated token and break the next invocation
 */

import type { Env } from "../../env.js";

const TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
const INTEGRATION_ID = "jobber";

interface JobberTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  scope?: string;
}

/**
 * Load the currently-stored refresh token, falling back to the Worker
 * secret on cold-start (no D1 row yet).
 */
async function loadStoredRefreshToken(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT refresh_token FROM integrations WHERE id = ?",
  )
    .bind(INTEGRATION_ID)
    .first<{ refresh_token: string | null }>();

  if (row?.refresh_token) return row.refresh_token;

  if (!env.JOBBER_REFRESH_TOKEN) {
    throw new Error(
      "No Jobber refresh token in D1 and no JOBBER_REFRESH_TOKEN secret available",
    );
  }

  return env.JOBBER_REFRESH_TOKEN;
}

/**
 * Persist a rotated refresh + access token to D1. Uses INSERT ... ON CONFLICT
 * so the first call bootstraps the row and subsequent calls update in place.
 */
async function persistTokens(
  env: Env,
  tokens: JobberTokenResponse,
): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  await env.DB.prepare(
    `INSERT INTO integrations (id, kind, access_token, refresh_token, token_expires_at, enabled, created_at, updated_at)
     VALUES (?, 'oauth', ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       token_expires_at = excluded.token_expires_at,
       updated_at = excluded.updated_at`,
  )
    .bind(
      INTEGRATION_ID,
      tokens.access_token,
      tokens.refresh_token,
      expiresAt,
      now,
      now,
    )
    .run();
}

/**
 * Exchange the current refresh token for a fresh access token + rotated
 * refresh token. Persists both to D1 before returning.
 */
export async function refreshAccessToken(env: Env): Promise<string> {
  const currentRefresh = await loadStoredRefreshToken(env);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.JOBBER_CLIENT_ID,
      client_secret: env.JOBBER_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: currentRefresh,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Jobber token refresh failed: HTTP ${res.status} — ${body.slice(0, 300)}`,
    );
  }

  const tokens = (await res.json()) as JobberTokenResponse;
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error(
      `Jobber token refresh returned invalid body: ${JSON.stringify(tokens).slice(0, 300)}`,
    );
  }

  await persistTokens(env, tokens);
  return tokens.access_token;
}

/**
 * Preferred entry point for everything downstream of auth — returns a live
 * access token, refreshing (and rotating the stored refresh token) if needed.
 *
 * For v1 we always refresh. Later we can cache the access_token in memory for
 * the lifetime of a sync run, or even in D1 with expiry checking.
 */
export async function getAccessToken(env: Env): Promise<string> {
  return refreshAccessToken(env);
}
