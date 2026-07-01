import { route, getCurrentUrl } from "preact-router";
import type { Capability } from "./rbac";

/**
 * The app is served under /app (see vite.config base + the Worker's /app
 * handler), in both dev and production. preact-router matches against the full
 * location pathname, so every route path and navigation is prefixed with BASE.
 */
export const BASE = "/app";

export function to(path: string): string {
  return `${BASE}${path === "/" ? "" : path}` || BASE;
}

export function go(path: string): void {
  route(to(path));
}

/** Is the given app-relative path the active route (prefix match for sections)? */
export function isActive(path: string, currentPath?: string): boolean {
  const current = currentPath ?? getCurrentUrl() ?? "";
  const target = to(path);
  if (path === "/") return current === BASE || current === `${BASE}/`;
  return current === target || current.startsWith(target + "/");
}

export interface NavItem {
  label: string;
  path: string;
  icon: string;
  enabled: boolean;
  /** When set, the item is shown only to roles holding this capability (RBAC). */
  capability?: Capability;
}

// Sidebar nav. All items enabled as of Sprint 18; capability gates visibility
// per the Sprint 17 RBAC matrix (owner sees all). Financial and Photos link to
// the Jobs pipeline — both features live inside the Job detail tabs.
export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", path: "/", icon: "🏠", enabled: true },
  { label: "Jobs", path: "/jobs", icon: "🏗️", enabled: true },
  { label: "Warranty Calls", path: "/warranty-calls", icon: "🛡️", enabled: true },
  { label: "Schedule", path: "/schedule", icon: "📅", enabled: true },
  { label: "Financial", path: "/financial", icon: "💰", enabled: true, capability: "view_financials" },
  { label: "Payers", path: "/payers", icon: "🏦", enabled: true, capability: "view_financials" },
  { label: "Clients", path: "/clients", icon: "👥", enabled: true, capability: "manage_clients" },
  { label: "Estimating", path: "/estimating", icon: "📋", enabled: true, capability: "manage_estimates" },
  { label: "Subcontractors", path: "/subcontractors", icon: "🔧", enabled: true },
  { label: "Photos", path: "/photos", icon: "📸", enabled: true, capability: "field_ops" },
  { label: "Documents", path: "/documents", icon: "📄", enabled: true },
  { label: "Company Docs", path: "/company-docs", icon: "🏢", enabled: true },
  { label: "Social", path: "/social", icon: "📱", enabled: true, capability: "manage_estimates" },
  { label: "Settings", path: "/settings", icon: "⚙️", enabled: true, capability: "system_admin" },
];

// Condensed set for the mobile bottom tab bar (left/right of the center + action).
export const MOBILE_TABS_LEFT: NavItem[] = [
  { label: "Home", path: "/", icon: "🏠", enabled: true },
  { label: "Jobs", path: "/jobs", icon: "🏗️", enabled: true },
];

export const MOBILE_TABS_RIGHT: NavItem[] = [
  { label: "Clients", path: "/clients", icon: "👥", enabled: true },
  { label: "Settings", path: "/settings", icon: "⚙️", enabled: true },
];

/** @deprecated Use MOBILE_TABS_LEFT / MOBILE_TABS_RIGHT — kept for any legacy imports. */
export const MOBILE_TABS: NavItem[] = [...MOBILE_TABS_LEFT, ...MOBILE_TABS_RIGHT];

/** When the current route is `/app/jobs/:id`, return that job id; otherwise null. */
export function currentJobIdFromRoute(path?: string): string | null {
  const current = path ?? getCurrentUrl() ?? "";
  const prefix = `${BASE}/jobs/`;
  if (!current.startsWith(prefix)) return null;
  const rest = current.slice(prefix.length);
  const id = rest.split(/[/?#]/)[0];
  return id ? decodeURIComponent(id) : null;
}
