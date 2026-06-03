import { describe, expect, it } from "vitest";
import {
  roleCan,
  can,
  resolveRequiredRoles,
  isGatedApiPath,
  enforceRbac,
} from "../src/lib/rbac.js";
import type { Env } from "../src/env.js";
import type { UserRole } from "../src/middleware/auth.js";

/**
 * Minimal D1 stub: authenticateRequest issues exactly
 *   SELECT ... FROM users WHERE email = ? AND is_active = 1
 * so we resolve the bound email against a fixture map.
 */
function makeEnv(usersByEmail: Record<string, { id: string; role: UserRole; is_active: number }>): Env {
  const db = {
    prepare(_sql: string) {
      return {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          this._args = args;
          return this;
        },
        async first() {
          const email = this._args[0] as string;
          const u = usersByEmail[email];
          if (!u || u.is_active !== 1) return null;
          return {
            id: u.id,
            email,
            first_name: "Test",
            last_name: "User",
            role: u.role,
            is_active: u.is_active,
          };
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: {} };
        },
      };
    },
  };
  return { DB: db } as unknown as Env;
}

const FIXTURE = {
  "owner@chs.local": { id: "u-owner", role: "owner" as UserRole, is_active: 1 },
  "pm@chs.local": { id: "u-pm", role: "project_manager" as UserRole, is_active: 1 },
  "fc@chs.local": { id: "u-fc", role: "field_crew" as UserRole, is_active: 1 },
  "oa@chs.local": { id: "u-oa", role: "office_admin" as UserRole, is_active: 1 },
  "gone@chs.local": { id: "u-gone", role: "field_crew" as UserRole, is_active: 0 },
};

function reqAs(email: string | null, method: string, path: string): Request {
  const headers: Record<string, string> = {};
  if (email) headers["Cf-Access-Authenticated-User-Email"] = email;
  return new Request(`https://dashboard.homesolutionsar.com${path}`, { method, headers });
}

async function status(env: Env, email: string | null, method: string, path: string): Promise<number> {
  const res = await enforceRbac(reqAs(email, method, path), env, new URL(`https://x${path}`));
  return res ? res.status : 200; // null = allowed → 200
}

describe("capability matrix (can / roleCan)", () => {
  it("owner holds every capability", () => {
    for (const cap of ["system_admin", "view_financials", "manage_estimates", "manage_jobs", "manage_clients", "manage_invoices", "field_ops"] as const) {
      expect(roleCan("owner", cap)).toBe(true);
    }
  });

  it("project_manager: jobs/estimates/invoices/clients/field, but NOT admin or financials", () => {
    expect(roleCan("project_manager", "manage_estimates")).toBe(true);
    expect(roleCan("project_manager", "manage_invoices")).toBe(true);
    expect(roleCan("project_manager", "manage_jobs")).toBe(true);
    expect(roleCan("project_manager", "system_admin")).toBe(false);
    expect(roleCan("project_manager", "view_financials")).toBe(false);
  });

  it("field_crew: field ops only", () => {
    expect(roleCan("field_crew", "field_ops")).toBe(true);
    expect(roleCan("field_crew", "manage_estimates")).toBe(false);
    expect(roleCan("field_crew", "view_financials")).toBe(false);
    expect(roleCan("field_crew", "system_admin")).toBe(false);
  });

  it("office_admin: clients + invoices, NOT costing/estimates/admin", () => {
    expect(roleCan("office_admin", "manage_clients")).toBe(true);
    expect(roleCan("office_admin", "manage_invoices")).toBe(true);
    expect(roleCan("office_admin", "view_financials")).toBe(false);
    expect(roleCan("office_admin", "manage_estimates")).toBe(false);
    expect(roleCan("office_admin", "system_admin")).toBe(false);
  });

  it("can() short-circuits owner and rejects signed-out", () => {
    expect(can({ role: "owner" }, "system_admin")).toBe(true);
    expect(can(null, "field_ops")).toBe(false);
  });
});

describe("isGatedApiPath", () => {
  it("gates authenticated /api routes", () => {
    expect(isGatedApiPath("/api/users")).toBe(true);
    expect(isGatedApiPath("/api/settings/default_labor_rate")).toBe(true);
    expect(isGatedApiPath("/api/jobs")).toBe(true);
  });
  it("never gates PUBLIC / webhook / secret routes", () => {
    expect(isGatedApiPath("/api/public/quote/abc")).toBe(false);
    expect(isGatedApiPath("/api/portal/abc")).toBe(false);
    expect(isGatedApiPath("/api/share/abc")).toBe(false);
    expect(isGatedApiPath("/api/webhooks/stripe")).toBe(false);
    expect(isGatedApiPath("/api/ops/dlq")).toBe(false);
    expect(isGatedApiPath("/api/sync/now")).toBe(false);
    expect(isGatedApiPath("/api/health/heartbeat")).toBe(false);
    expect(isGatedApiPath("/app/clients/1")).toBe(false);
  });
});

describe("resolveRequiredRoles", () => {
  it("owner-only admin routes", () => {
    expect(resolveRequiredRoles("GET", "/api/users")).toEqual(["owner"]);
    expect(resolveRequiredRoles("PUT", "/api/settings/x")).toEqual(["owner"]);
    expect(resolveRequiredRoles("GET", "/api/audit-logs")).toEqual(["owner"]);
    expect(resolveRequiredRoles("GET", "/api/dlq")).toEqual(["owner"]);
    expect(resolveRequiredRoles("GET", "/api/health")).toEqual(["owner"]);
    expect(resolveRequiredRoles("GET", "/api/jobs/abc/costing")).toEqual(["owner"]);
  });
  it("self endpoints stay open to all roles", () => {
    expect(resolveRequiredRoles("GET", "/api/users/me")).toContain("field_crew");
    expect(resolveRequiredRoles("GET", "/api/users/clockable")).toContain("office_admin");
  });
  it("unmatched routes default to ALL (null)", () => {
    expect(resolveRequiredRoles("GET", "/api/notifications/inbox")).toBeNull();
  });

  it("Sprint 18: photo-report + project-packet are O/PM; devices default to ALL", () => {
    expect(resolveRequiredRoles("POST", "/api/jobs/abc/photo-report")).toEqual(["owner", "project_manager"]);
    expect(resolveRequiredRoles("POST", "/api/jobs/abc/project-packet")).toEqual(["owner", "project_manager"]);
    // Every authenticated user registers their own device → no rule → ALL.
    expect(resolveRequiredRoles("POST", "/api/devices/register")).toBeNull();
    expect(resolveRequiredRoles("POST", "/api/devices/unregister")).toBeNull();
    expect(resolveRequiredRoles("GET", "/api/devices")).toBeNull();
  });
});

describe("enforceRbac — the §3 matrix end-to-end", () => {
  const env = makeEnv(FIXTURE);

  it("401 when no Access identity on a gated route", async () => {
    expect(await status(env, null, "GET", "/api/users")).toBe(401);
  });

  it("401 when the user is inactive (deactivated cannot act)", async () => {
    expect(await status(env, "gone@chs.local", "GET", "/api/jobs")).toBe(401);
  });

  it("owner passes every gate (no regression)", async () => {
    for (const path of [
      "/api/users",
      "/api/settings/x",
      "/api/integrations",
      "/api/audit-logs",
      "/api/dlq",
      "/api/backup/status",
      "/api/health",
      "/api/jobs/abc/costing",
      "/api/estimates",
      "/api/invoices",
      "/api/jobs",
    ]) {
      expect(await status(env, "owner@chs.local", "GET", path)).toBe(200);
    }
  });

  it("project_manager: 403 on admin + financials, 200 on jobs/estimates/invoices", async () => {
    expect(await status(env, "pm@chs.local", "GET", "/api/users")).toBe(403);
    expect(await status(env, "pm@chs.local", "PUT", "/api/settings/x")).toBe(403);
    expect(await status(env, "pm@chs.local", "GET", "/api/integrations")).toBe(403);
    expect(await status(env, "pm@chs.local", "GET", "/api/jobs/abc/costing")).toBe(403);
    expect(await status(env, "pm@chs.local", "GET", "/api/jobs")).toBe(200);
    expect(await status(env, "pm@chs.local", "GET", "/api/estimates")).toBe(200);
    expect(await status(env, "pm@chs.local", "POST", "/api/invoices")).toBe(200);
  });

  it("field_crew: 403 on financials/estimates/settings, 200 on field ops", async () => {
    expect(await status(env, "fc@chs.local", "GET", "/api/jobs/abc/costing")).toBe(403);
    expect(await status(env, "fc@chs.local", "POST", "/api/estimates")).toBe(403);
    expect(await status(env, "fc@chs.local", "PUT", "/api/settings/x")).toBe(403);
    expect(await status(env, "fc@chs.local", "POST", "/api/time-entries")).toBe(200);
    expect(await status(env, "fc@chs.local", "POST", "/api/daily-logs")).toBe(200);
    // Reads default to ALL — own jobs reachable.
    expect(await status(env, "fc@chs.local", "GET", "/api/jobs/abc")).toBe(200);
  });

  it("Sprint 18: photo-report/packet 403 for field_crew, devices 200 for all", async () => {
    expect(await status(env, "fc@chs.local", "POST", "/api/jobs/abc/photo-report")).toBe(403);
    expect(await status(env, "fc@chs.local", "POST", "/api/jobs/abc/project-packet")).toBe(403);
    expect(await status(env, "pm@chs.local", "POST", "/api/jobs/abc/photo-report")).toBe(200);
    expect(await status(env, "owner@chs.local", "POST", "/api/jobs/abc/project-packet")).toBe(200);
    // Device registration is open to every authenticated active role.
    expect(await status(env, "fc@chs.local", "POST", "/api/devices/register")).toBe(200);
    expect(await status(env, "oa@chs.local", "GET", "/api/devices")).toBe(200);
  });

  it("office_admin: 403 on costing/settings/users, 200 on clients/invoices/payments", async () => {
    expect(await status(env, "oa@chs.local", "GET", "/api/jobs/abc/costing")).toBe(403);
    expect(await status(env, "oa@chs.local", "PUT", "/api/settings/x")).toBe(403);
    expect(await status(env, "oa@chs.local", "GET", "/api/users")).toBe(403);
    expect(await status(env, "oa@chs.local", "POST", "/api/estimates")).toBe(403);
    expect(await status(env, "oa@chs.local", "GET", "/api/clients")).toBe(200);
    expect(await status(env, "oa@chs.local", "POST", "/api/invoices")).toBe(200);
    expect(await status(env, "oa@chs.local", "POST", "/api/payments")).toBe(200);
  });

  it("PUBLIC token routes are unaffected (no role gate, reachable without identity)", async () => {
    expect(await status(env, null, "GET", "/api/public/quote/tok")).toBe(200);
    expect(await status(env, null, "POST", "/api/webhooks/stripe")).toBe(200);
    expect(await status(env, null, "GET", "/api/portal/tok")).toBe(200);
  });
});
