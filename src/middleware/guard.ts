/**
 * Route guard helper — resolves the Cloudflare Access identity and enforces a
 * role for write endpoints, returning a ready-to-send error Response on
 * failure. Read endpoints stay open (the dashboard host is Access-gated at the
 * edge, matching the existing chs-hub convention), so they don't use this.
 *
 *   const guarded = await guard(request, env, ["owner", "project_manager"]);
 *   if (guarded instanceof Response) return guarded;  // 401 / 403
 *   const { user } = guarded;                          // authenticated user
 */

import type { Env } from "../env.js";
import { authenticateRequest, AuthError, type AuthenticatedUser } from "./auth.js";
import { requireRole, RoleError } from "./roles.js";
import type { UserRole } from "./auth.js";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function guard(
  request: Request,
  env: Env,
  allowedRoles: UserRole[],
): Promise<{ user: AuthenticatedUser } | Response> {
  try {
    const authed = await authenticateRequest(request, env);
    requireRole(authed, allowedRoles);
    return { user: authed.user };
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: "unauthorized", details: err.message }, 401);
    }
    if (err instanceof RoleError) {
      return json({ error: "forbidden", details: err.message }, 403);
    }
    throw err;
  }
}
