/**
 * Sync trigger endpoints.
 *
 *   POST /api/sync/jobber  — server-to-server, protected by SYNC_TRIGGER_SECRET
 *                            (X-Sync-Token header). Also invoked by cron.
 *
 *   POST /api/sync/now     — user-initiated from the dashboard's "Sync Now"
 *                            button. Trusted caller signals:
 *                            Cf-Access-Authenticated-User-Email (when your
 *                            Access app forwards it), Cf-Access-Jwt-Assertion
 *                            (present for essentially all authenticated
 *                            Access sessions — preferred), or X-Sync-Token /
 *                            SYNC_TRIGGER_SECRET for curl/scripts.
 *                            After Jobber → D1, runs WC workbook sync like
 *                            the 30‑minute cron so Google Sheets stay fresh.
 */

import type { Env } from "../env.js";
import { syncJobberToD1 } from "../lib/jobber/sync.js";
import { syncWorkbook } from "../lib/wc/sync.js";

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
 * User-facing "Sync Now" — Jobber → D1 (same as cron), then WC Sheets sync
 * (same piggyback as runJobberTick). Auth: Access JWT or email header, or
 * SYNC_TRIGGER_SECRET.
 */
export async function handleSyncNow(
  request: Request,
  env: Env,
): Promise<Response> {
  const cfAccessUser = request.headers.get("cf-access-authenticated-user-email");
  const cfAccessJwt = request.headers.get("cf-access-jwt-assertion");
  const sharedSecret = request.headers.get("x-sync-token");
  const authorized =
    !!(cfAccessUser && cfAccessUser.trim()) ||
    !!(cfAccessJwt && cfAccessJwt.trim()) ||
    (!!sharedSecret && sharedSecret === env.SYNC_TRIGGER_SECRET);

  if (!authorized) {
    return json({ error: "unauthorized" }, 401);
  }

  const triggeredBy =
    (cfAccessUser && cfAccessUser.trim()) ||
    (cfAccessJwt && cfAccessJwt.trim() ? "cf-access-session" : null) ||
    "shared-secret";

  const startedAt = new Date().toISOString();

  let stats: Awaited<ReturnType<typeof syncJobberToD1>> | null = null;
  let jobberError: string | null = null;
  try {
    stats = await syncJobberToD1(env);
  } catch (err) {
    jobberError = (err as Error).message;
  }

  let wc = null as Awaited<ReturnType<typeof syncWorkbook>> | null;
  let wcThrown: string | null = null;
  try {
    wc = await syncWorkbook(env);
  } catch (err) {
    wcThrown = (err as Error).message;
  }

  const finishedAt = new Date().toISOString();

  if (jobberError) {
    return json(
      {
        ok: false,
        triggered_by: triggeredBy,
        started_at: startedAt,
        finished_at: finishedAt,
        error: jobberError,
        wc_sync: wcThrown
          ? { ok: false, error: wcThrown }
          : wc
            ? {
                ok: wc.ok,
                duration_ms: wc.duration_ms,
                errors: wc.errors,
                monthly_rows_written: wc.monthly.rows_written,
                kbpi_weeks_matched: wc.kbpi.weeks_matched,
              }
            : null,
      },
      500,
    );
  }

  const wcPayload = wcThrown
    ? { ok: false as const, error: wcThrown }
    : wc
      ? {
          ok: wc.ok,
          duration_ms: wc.duration_ms,
          errors: wc.errors,
          monthly_rows_written: wc.monthly.rows_written,
          kbpi_weeks_matched: wc.kbpi.weeks_matched,
        }
      : null;

  return json({
    ok: stats!.errors.length === 0 && (!wcPayload || wcPayload.ok !== false),
    triggered_by: triggeredBy,
    ...stats!,
    wc_sync: wcPayload,
    started_at: startedAt,
    finished_at: finishedAt,
  });
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
