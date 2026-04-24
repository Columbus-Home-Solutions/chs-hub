/**
 * POST /api/sync/jobber — triggers a Jobber → D1 sync.
 *
 * Protected by the SYNC_TRIGGER_SECRET header (X-Sync-Token). Not for public
 * use. Also invoked internally by the scheduled cron handler (see src/index.ts).
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
