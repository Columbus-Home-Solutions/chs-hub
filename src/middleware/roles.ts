/**
 * Role-based access control checks.
 *
 * Used by route handlers after {@link authenticateRequest} has attached the
 * resolved user. Throws {@link RoleError} (caller maps to 403) when the user's
 * role is not in the allowed set.
 */

import type { AuthenticatedRequest, UserRole } from "./auth.js";

export class RoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleError";
  }
}

export function requireRole(
  request: AuthenticatedRequest,
  allowedRoles: UserRole[],
): void {
  if (!allowedRoles.includes(request.user.role)) {
    throw new RoleError("Insufficient permissions");
  }
}
