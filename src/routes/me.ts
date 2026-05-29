/**
 * GET /api/me (alias: /api/users/me) — current authenticated user.
 *
 * The frontend auth context calls this on load to learn who is signed in and
 * what role they hold. Identity is resolved by the Cloudflare Access middleware
 * (Cf-Access-Authenticated-User-Email → active users row). Returns 401 when no
 * Access identity is present (e.g. a logged-out / un-gated request).
 */

import type { Env } from "../env.js";
import { authenticateRequest, AuthError } from "../middleware/auth.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  try {
    const authed = await authenticateRequest(request, env);
    const u = authed.user;
    return json({
      id: u.id,
      email: u.email,
      first_name: u.first_name,
      last_name: u.last_name,
      role: u.role,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: "unauthorized", details: err.message }, { status: 401 });
    }
    throw err;
  }
}
