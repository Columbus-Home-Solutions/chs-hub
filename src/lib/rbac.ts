/**
 * RBAC enforcement layer (Sprint 17).
 *
 * The auth middleware (src/middleware/auth.ts) already resolves the Cloudflare
 * Access identity to an active `users` row and attaches `req.user` (with role).
 * This module turns that *resolution* into *enforcement*: a single, centralized
 * gate (`enforceRbac`) applied in src/index.ts before any API route dispatches,
 * plus a capability model (`can`) mirrored by the frontend (frontend/src/lib/rbac.ts).
 *
 * Design (Module-Spec-System-Admin §3 matrix + Route Map labels):
 *   • The OWNER passes every gate — RBAC must never change what the owner can do
 *     today (business rule 11). This is encoded once, here.
 *   • Most operational /api routes are open to any *authenticated, active* user
 *     (ALL). Only the routes the matrix restricts carry an explicit rule.
 *   • PUBLIC / token-gated / secret-gated routes are NEVER given a role gate —
 *     they have no `req.user` (pay/quote/portal/share/webhooks/ops/sync).
 *   • 401 (no/inactive identity) is distinct from 403 (authenticated, wrong role).
 *
 * Net-new behavior is additive: the gate sits in front of existing handlers and
 * never alters their business logic.
 */

import type { Env } from "../env.js";
import {
  authenticateRequest,
  AuthError,
  type AuthenticatedUser,
  type UserRole,
} from "../middleware/auth.js";

export const ALL_ROLES: UserRole[] = [
  "owner",
  "project_manager",
  "field_crew",
  "office_admin",
];

// ─── Capability model (mirrored by frontend/src/lib/rbac.ts) ──────────────────
//
// A capability is a coarse permission the UI gates on (nav items, tabs, buttons,
// financial figures). The OWNER implicitly holds every capability.

export type Capability =
  | "system_admin" // settings, users, integrations, audit, dlq, backup, health
  | "view_financials" // profit / margin / job-costing figures
  | "manage_estimates" // estimate builder writes
  | "manage_jobs" // job + task + schedule writes
  | "manage_clients" // clients / properties / communications
  | "manage_invoices" // invoices / payments / billing cycles
  | "field_ops" // photos / daily logs / time tracking
  | "manage_company_docs"; // company SOPs / internal library upload + edit

export const ALL_CAPABILITIES: Capability[] = [
  "system_admin",
  "view_financials",
  "manage_estimates",
  "manage_jobs",
  "manage_clients",
  "manage_invoices",
  "field_ops",
  "manage_company_docs",
];

/**
 * Non-owner role → capabilities. The owner is intentionally omitted: `can()`
 * short-circuits to true for owner so the owner always passes.
 *
 *   project_manager — runs jobs/estimates/invoices/clients + field ops, but NOT
 *                     system admin and NOT raw profit/margin figures.
 *   field_crew      — field ops only (photos, daily logs, time tracking).
 *   office_admin    — client/invoice/payment desk work; NOT job-costing/margins,
 *                     NOT estimates, NOT system admin.
 */
const ROLE_CAPABILITIES: Record<Exclude<UserRole, "owner">, Capability[]> = {
  project_manager: [
    "manage_estimates",
    "manage_jobs",
    "manage_clients",
    "manage_invoices",
    "field_ops",
  ],
  field_crew: ["field_ops"],
  office_admin: ["manage_clients", "manage_invoices", "manage_company_docs"],
};

/** Does this role hold the capability? The owner holds all capabilities. */
export function roleCan(role: UserRole, capability: Capability): boolean {
  if (role === "owner") return true;
  return ROLE_CAPABILITIES[role].includes(capability);
}

/** Convenience over a resolved user (or null = signed-out). */
export function can(
  user: { role: UserRole } | null | undefined,
  capability: Capability,
): boolean {
  if (!user) return false;
  return roleCan(user.role, capability);
}

// ─── Route → role table ──────────────────────────────────────────────────────
//
// Ordered; first match wins. `roles` is the set permitted (besides owner, who
// always passes). A route NOT matched here defaults to ALL (any authenticated
// active user) — the same effective access the Access-gated host gives today,
// plus the active-user check the auth middleware already performs.

interface RouteRule {
  /** HTTP method, or "*" for any. */
  method: string;
  pattern: RegExp;
  roles: UserRole[];
}

const O: UserRole[] = ["owner"];
const O_OA: UserRole[] = ["owner", "office_admin"];
const O_PM: UserRole[] = ["owner", "project_manager"];
const O_PM_OA: UserRole[] = ["owner", "project_manager", "office_admin"];
const O_PM_FC: UserRole[] = ["owner", "project_manager", "field_crew"];

const ROUTE_RULES: RouteRule[] = [
  // Self-service identity endpoints — every authenticated role (must precede the
  // owner-only /api/users rules below).
  { method: "GET", pattern: /^\/api\/users\/(me|clockable)$/, roles: ALL_ROLES },
  { method: "*", pattern: /^\/api\/me$/, roles: ALL_ROLES },

  // ── System Admin surface — OWNER ONLY (business rule 1) ────────────────────
  { method: "*", pattern: /^\/api\/users(\/.*)?$/, roles: O }, // user management CRUD
  { method: "*", pattern: /^\/api\/settings(\/.*)?$/, roles: O }, // system settings
  { method: "*", pattern: /^\/api\/vendor-subscriptions(\/.*)?$/, roles: O }, // vendor cost/renewal tracker
  { method: "*", pattern: /^\/api\/integrations(\/.*)?$/, roles: O },
  { method: "*", pattern: /^\/api\/google-calendar(\/.*)?$/, roles: O },
  { method: "*", pattern: /^\/api\/google-business-profile(\/.*)?$/, roles: O },
  { method: "*", pattern: /^\/api\/calendar\/ical(\/.*)?$/, roles: O },
  { method: "GET", pattern: /^\/api\/social\/(status|test-connection)$/, roles: O },
  { method: "*", pattern: /^\/api\/quickbooks(\/.*)?$/, roles: O },
  { method: "*", pattern: /^\/api\/wc-spreadsheet(\/.*)?$/, roles: O },
  { method: "*", pattern: /^\/api\/audit-logs(\/.*)?$/, roles: O },
  { method: "*", pattern: /^\/api\/dlq(\/.*)?$/, roles: O },
  { method: "*", pattern: /^\/api\/backup(\/.*)?$/, roles: O },
  { method: "*", pattern: /^\/api\/health$/, roles: O }, // admin health panel

  // ── Financial figures (profit / margin / job-costing) — OWNER ONLY ─────────
  { method: "*", pattern: /^\/api\/jobs\/[^/]+\/costing$/, roles: O },
  { method: "*", pattern: /^\/api\/costing(\/.*)?$/, roles: O },
  { method: "*", pattern: /^\/api\/kpis$/, roles: O },

  // ── Estimating — OWNER + PM (field crew / office admin 403) ────────────────
  { method: "*", pattern: /^\/api\/estimates(\/.*)?$/, roles: O_PM },
  { method: "*", pattern: /^\/api\/estimate-templates(\/.*)?$/, roles: O_PM },
  { method: "*", pattern: /^\/api\/estimate-requests(\/.*)?$/, roles: O_PM },
  { method: "*", pattern: /^\/api\/line-items(\/.*)?$/, roles: O_PM },
  { method: "*", pattern: /^\/api\/sub-items(\/.*)?$/, roles: O_PM },

  { method: "POST", pattern: /^\/api\/warranty-calls(\/.*)?$/, roles: O_PM_OA },
  { method: "PATCH", pattern: /^\/api\/warranty-calls(\/.*)?$/, roles: O_PM_OA },
  { method: "DELETE", pattern: /^\/api\/warranty-calls(\/.*)?$/, roles: O_PM_OA },

  // ── Company docs library — writes: OWNER + Office Admin; reads: ALL ────────
  { method: "POST", pattern: /^\/api\/company-documents$/, roles: O_OA },
  { method: "PATCH", pattern: /^\/api\/company-documents\/[^/]+$/, roles: O_OA },
  { method: "DELETE", pattern: /^\/api\/company-documents\/[^/]+$/, roles: O_OA },

  // ── Social media engine — OWNER + PM ───────────────────────────────────────
  { method: "*", pattern: /^\/api\/social-posts(\/.*)?$/, roles: O_PM },
  { method: "*", pattern: /^\/api\/content-schedules(\/.*)?$/, roles: O_PM },

  // ── Photo report + project packet (Sprint 18) — OWNER + PM ─────────────────
  // Sales/owner artifacts (Route Map §6 O/PM). Device-token registration
  // (/api/devices/*) is intentionally absent → defaults to ALL (every user
  // registers their own device); the handlers scope writes to req.user.
  { method: "POST", pattern: /^\/api\/jobs\/[^/]+\/photo-report$/, roles: O_PM },
  { method: "POST", pattern: /^\/api\/jobs\/[^/]+\/project-packet$/, roles: O_PM },

  // ── Invoices / payments / billing — OWNER + PM + Office Admin ──────────────
  { method: "*", pattern: /^\/api\/invoices(\/.*)?$/, roles: O_PM_OA },
  { method: "*", pattern: /^\/api\/payments(\/.*)?$/, roles: O_PM_OA },
  { method: "*", pattern: /^\/api\/billing-cycles(\/.*)?$/, roles: O_PM_OA },

  // ── Field ops (write) — OWNER + PM + Field Crew (office admin 403) ─────────
  // Reads default to ALL; the mutating verbs are restricted to the field roles.
  { method: "POST", pattern: /^\/api\/time-entries(\/.*)?$/, roles: O_PM_FC },
  { method: "PUT", pattern: /^\/api\/time-entries(\/.*)?$/, roles: O_PM_FC },
  { method: "POST", pattern: /^\/api\/daily-logs(\/.*)?$/, roles: O_PM_FC },
  { method: "PUT", pattern: /^\/api\/daily-logs(\/.*)?$/, roles: O_PM_FC },
];

/**
 * Prefixes/paths that must NEVER receive a user role gate. These are PUBLIC
 * (token-gated), webhook-signed, or shared-secret-gated — they carry no
 * `req.user`. Adding a gate here would 401 legitimate token/secret traffic.
 */
const RBAC_EXEMPT_PREFIXES = [
  "/api/public/", // pay + quote token APIs
  "/api/punch/", // sub punch list token API (Sprint 33)
  "/api/sub/", // persistent sub access token API (Sprint 34)
  "/api/portal/", // client portal token API
  "/api/bid/", // sub bid submission token API (Sprint 38 Run 3)
  "/api/packet/", // sub onboarding packet token API (Sprint 39 Run 1)
  "/api/share/", // shareable document links
  "/api/webhooks/", // Stripe + Twilio (signature-gated)
  "/api/ops/", // SYNC_TRIGGER_SECRET gated
  "/api/sync/", // x-sync-token OR Access
  "/api/hl/", // HighLevel proxy (token held server-side)
];

const RBAC_EXEMPT_EXACT = new Set<string>([
  "/api/health/heartbeat", // lightweight readiness probe (ALL)
  "/api/f", // public file-link resolve
  "/api/file-link", // create share link
  "/api/jobber/status",
  "/api/debug/sheets-inspect",
  "/api/wc/sync", // SYNC_TRIGGER_SECRET gated manual WC sync
  "/api/calendar/ical", // token-gated iCal feed (no Access)
]);

/** Is this an /api path that the user-RBAC gate should evaluate? */
export function isGatedApiPath(path: string): boolean {
  if (!path.startsWith("/api/")) return false;
  if (RBAC_EXEMPT_EXACT.has(path)) return false;
  for (const prefix of RBAC_EXEMPT_PREFIXES) {
    if (path.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * The role set permitted for a (method, path), or null when the route is open
 * to any authenticated active user (the default). The owner is always allowed
 * regardless of the returned set.
 */
export function resolveRequiredRoles(
  method: string,
  path: string,
): UserRole[] | null {
  for (const rule of ROUTE_RULES) {
    if (rule.method !== "*" && rule.method !== method) continue;
    if (rule.pattern.test(path)) return rule.roles;
  }
  return null;
}

function jsonError(error: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Centralized RBAC gate. Call once in the fetch handler before route dispatch.
 *
 *   • Returns null  → request may proceed (not gated, or user is permitted).
 *   • Returns 401   → no / inactive Access identity on a gated route.
 *   • Returns 403   → authenticated, but the role isn't permitted for the route.
 */
export async function enforceRbac(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (!isGatedApiPath(url.pathname)) return null;

  let user: AuthenticatedUser;
  try {
    const authed = await authenticateRequest(request, env);
    user = authed.user;
    // Stash the resolved user on the request so downstream handlers can reuse it
    // without re-querying (and so audit logging always has the actor).
    (request as Request & { user?: AuthenticatedUser }).user = user;
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonError("unauthorized", err.message, 401);
    }
    throw err;
  }

  const roles = resolveRequiredRoles(request.method, url.pathname);
  if (roles === null) return null; // any authenticated active user
  if (user.role === "owner") return null; // owner passes every gate
  if (roles.includes(user.role)) return null;

  return jsonError(
    "forbidden",
    `Role '${user.role}' is not permitted for ${request.method} ${url.pathname}`,
    403,
  );
}
