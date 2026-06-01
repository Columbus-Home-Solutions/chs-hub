/**
 * GET /api/me (alias: /api/users/me) — current authenticated user.
 *
 * The frontend auth context calls this on load to learn who is signed in and
 * what role they hold. Identity is resolved by the Cloudflare Access middleware
 * (Cf-Access-Authenticated-User-Email → active users row). Returns 401 when no
 * Access identity is present (e.g. a logged-out / un-gated request).
 *
 * Also hosts GET /api/users/clockable — the narrow, all-roles utility list that
 * populates the time-tracker worker dropdown (active O/PM/FC users only).
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

interface ClockableRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  role: string;
}

/**
 * GET /api/users/clockable — active users eligible to clock labor time.
 *
 * All authenticated roles (FC needs it to populate their own clock-in form), so
 * this is intentionally separate from the Owner-only `/api/users` management
 * list: narrow fields, no PII beyond the display name. `office_admin` is
 * excluded — they manage the office side and don't log job labor time. Returns
 * `[{ id, full_name, role }]` sorted by name; `full_name` is the same
 * `"First Last"` string stored to `time_entries.worker`.
 */
export async function handleClockableUsers(request: Request, env: Env): Promise<Response> {
  try {
    await authenticateRequest(request, env);
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: "unauthorized", details: err.message }, { status: 401 });
    }
    throw err;
  }

  const { results } = await env.DB.prepare(
    `SELECT id, first_name, last_name, name, role
       FROM users
      WHERE is_active = 1
        AND role IN ('owner', 'project_manager', 'field_crew')
      ORDER BY first_name, last_name`,
  ).all<ClockableRow>();

  const users = (results ?? []).map((u) => {
    const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
    return { id: u.id, full_name: full || (u.name ?? "").trim(), role: u.role };
  });

  return json(users);
}
