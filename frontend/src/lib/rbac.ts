/**
 * Frontend capability gating (Sprint 17) — mirrors src/lib/rbac.ts on the worker.
 *
 * `can(user, capability)` is the single predicate the UI consults to show/hide
 * nav items, settings tabs, action buttons, and financial figures. The OWNER
 * holds every capability (no behavior change for the current sole user). The
 * server enforces the same matrix on every gated route, so this is UX polish —
 * never the security boundary.
 */

import type { CurrentUser } from "../store/auth";

export type Capability =
  | "system_admin"
  | "view_financials"
  | "manage_estimates"
  | "manage_jobs"
  | "manage_clients"
  | "manage_invoices"
  | "field_ops";

type Role = CurrentUser["role"];

const ROLE_CAPABILITIES: Record<Exclude<Role, "owner">, Capability[]> = {
  project_manager: [
    "manage_estimates",
    "manage_jobs",
    "manage_clients",
    "manage_invoices",
    "field_ops",
  ],
  field_crew: ["field_ops"],
  office_admin: ["manage_clients", "manage_invoices"],
};

export function can(
  user: Pick<CurrentUser, "role"> | null | undefined,
  capability: Capability,
): boolean {
  if (!user) return false;
  if (user.role === "owner") return true;
  return ROLE_CAPABILITIES[user.role].includes(capability);
}

/** True only for the Owner — the System Admin surface gate. */
export function isOwner(user: Pick<CurrentUser, "role"> | null | undefined): boolean {
  return user?.role === "owner";
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  project_manager: "Project Manager",
  field_crew: "Field Crew",
  office_admin: "Office Admin",
};

/** Human-readable capability summary per role — feeds the Add-User preview. */
export const ROLE_CAPABILITY_SUMMARY: Record<Role, string[]> = {
  owner: [
    "Full access — system settings, users, integrations, audit, backups",
    "All financial figures (profit / margin / job costing)",
    "Estimating, jobs, invoices, clients, field ops, social",
  ],
  project_manager: [
    "Estimating, jobs, scheduling, change orders",
    "Invoices & payments, clients & communications",
    "Field ops (photos, daily logs, time)",
    "No system settings, users, integrations, or profit/margin figures",
  ],
  field_crew: [
    "Field ops only — photos, daily logs, time tracking",
    "Own assigned jobs (read)",
    "No financials, estimates, or settings",
  ],
  office_admin: [
    "Clients & communications, documents",
    "Invoices & payments",
    "No job costing / margins, estimates, settings, or user management",
  ],
};
