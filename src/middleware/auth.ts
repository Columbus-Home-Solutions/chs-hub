/**
 * Cloudflare Access → user resolution middleware.
 *
 * Cloudflare Access sits in front of the dashboard host and injects the
 * verified identity into `Cf-Access-Authenticated-User-Email`. We resolve that
 * email to an active row in the (unified-schema) `users` table and attach it to
 * the request so downstream handlers can enforce role-based access.
 */

import type { Env } from "../env.js";

export type UserRole = "owner" | "project_manager" | "field_crew" | "office_admin";

export interface AuthenticatedUser {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: UserRole;
  is_active: number;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

/** Thrown when no Access identity is present or the user is unknown/inactive. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Resolve the Cloudflare Access identity to an active user record.
 * Throws {@link AuthError} (caller maps to 401) when unauthenticated.
 */
export async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<AuthenticatedRequest> {
  const email = request.headers.get("Cf-Access-Authenticated-User-Email");

  if (!email) {
    throw new AuthError("No authenticated user email in request headers");
  }

  const user = await env.DB.prepare(
    "SELECT id, email, first_name, last_name, role, is_active FROM users WHERE email = ? AND is_active = 1",
  )
    .bind(email)
    .first<AuthenticatedUser>();

  if (!user) {
    throw new AuthError("User not found or inactive");
  }

  const authedRequest = request as AuthenticatedRequest;
  authedRequest.user = user;
  return authedRequest;
}
