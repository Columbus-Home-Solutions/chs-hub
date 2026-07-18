/**
 * POST /api/wc/sync — manually kick the Wealthy Contractor workbook sync.
 *
 * Normally the sync runs on the Jobber cron tick (every 30 min, after the
 * Jobber→D1 sync completes). This endpoint lets us trigger it on demand
 * for testing or for catching up after a Jobber sync failure.
 *
 * Guarded behind SYNC_TRIGGER_SECRET — the same token that gates the
 * Jobber sync trigger.
 */

import type { Env } from "../env.js";
import { runWcSpreadsheetSync } from "../services/wc-spreadsheet.js";

export async function handleWcSync(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const secret =
    url.searchParams.get("secret") ??
    request.headers.get("x-sync-token") ??
    "";
  if (secret !== env.SYNC_TRIGGER_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const result = await runWcSpreadsheetSync(env);
  const ok = result.status === "success" || result.status === "skipped";
  return new Response(JSON.stringify(result, null, 2), {
    status: ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
}
