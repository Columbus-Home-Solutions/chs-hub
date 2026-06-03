/**
 * Runtime config endpoints — serve browser-safe keys to authenticated clients.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";

const ALL_ROLES = ["owner", "project_manager", "field_crew", "office_admin"] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** GET /api/config/maps — referrer-restricted Google Maps JS API key for Places autocomplete. */
export async function handleMapsConfig(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...ALL_ROLES]);
  if (guarded instanceof Response) return guarded;

  const key = (env.GOOGLE_MAPS_API_KEY ?? "").trim();
  if (!key) {
    return json({ key: null, configured: false });
  }
  return json({ key, configured: true });
}
