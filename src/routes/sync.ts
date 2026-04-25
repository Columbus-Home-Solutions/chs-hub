/**
 * Sync trigger endpoints.
 *
 *   POST /api/sync/jobber  — server-to-server, protected by SYNC_TRIGGER_SECRET
 *                            (X-Sync-Token header). Also invoked by cron.
 *
 *   POST /api/sync/now     — user-initiated from the dashboard's "Sync Now"
 *                            button. Protected by Cloudflare Access (any
 *                            request that reaches us with a
 *                            Cf-Access-Authenticated-User-Email header has
 *                            already passed the Access policy; we don't
 *                            re-validate the JWT here because the rest of
 *                            the dashboard endpoints don't either).
 *                            Returns sync stats so the UI can report what
 *                            happened.
 */

import type { Env } from "../env.js";
import { syncJobberToD1 } from "../lib/jobber/sync.js";

export async function handleJobberSync(
  request: Request,
  env: Env,
): Promise<Response> {
  const authHeader = request.headers.get("x-sync-token");
  if (!authHeader || authHeader !== env.SYNC_TRIGGER_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  try {
    const stats = await syncJobberToD1(env);
    return json({ ok: stats.errors.length === 0, ...stats });
  } catch (err) {
    const message = (err as Error).message;
    return json({ ok: false, error: message }, 500);
  }
}

/**
 * User-facing "Sync Now" — runs the same Jobber-to-D1 sync that cron runs
 * every 30 minutes, on demand. We require either:
 *   - A Cloudflare Access identity header (any authenticated dashboard user),
 *     OR
 *   - The shared SYNC_TRIGGER_SECRET (parity with /api/sync/jobber, useful
 *     for scripts/curl).
 */
export async function handleSyncNow(
  request: Request,
  env: Env,
): Promise<Response> {
  const cfAccessUser = request.headers.get("cf-access-authenticated-user-email");
  const sharedSecret = request.headers.get("x-sync-token");
  const authorized =
    !!cfAccessUser ||
    (!!sharedSecret && sharedSecret === env.SYNC_TRIGGER_SECRET);

  if (!authorized) {
    return json({ error: "unauthorized" }, 401);
  }

  const startedAt = new Date().toISOString();
  try {
    const stats = await syncJobberToD1(env);
    return json({
      ok: stats.errors.length === 0,
      triggered_by: cfAccessUser ?? "shared-secret",
      ...stats,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });
  } catch (err) {
    return json(
      {
        ok: false,
        triggered_by: cfAccessUser ?? "shared-secret",
        started_at: startedAt,
        error: (err as Error).message,
      },
      500,
    );
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
