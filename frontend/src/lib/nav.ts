import { route, getCurrentUrl } from "preact-router";

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
export function isActive(path: string): boolean {
  const current = getCurrentUrl();
  const target = to(path);
  if (path === "/") return current === BASE || current === `${BASE}/`;
  return current === target || current.startsWith(target + "/");
}

export interface NavItem {
  label: string;
  path: string;
  icon: string;
  enabled: boolean;
}

// Sidebar nav (Dashboard spec). For Sprint 2 only Clients, Subcontractors and
// Settings route to real pages; the rest are "Coming soon" placeholders.
export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", path: "/", icon: "🏠", enabled: true },
  { label: "Jobs", path: "/jobs", icon: "🏗️", enabled: false },
  { label: "Estimates", path: "/estimates", icon: "📋", enabled: false },
  { label: "Financial", path: "/financial", icon: "💰", enabled: false },
  { label: "Clients", path: "/clients", icon: "👥", enabled: true },
  { label: "Subcontractors", path: "/subcontractors", icon: "🔧", enabled: true },
  { label: "Photos", path: "/photos", icon: "📸", enabled: false },
  { label: "Documents", path: "/documents", icon: "📄", enabled: false },
  { label: "Social", path: "/social", icon: "📱", enabled: false },
  { label: "Settings", path: "/settings", icon: "⚙️", enabled: true },
];

// Condensed set for the mobile bottom tab bar.
export const MOBILE_TABS: NavItem[] = [
  { label: "Home", path: "/", icon: "🏠", enabled: true },
  { label: "Clients", path: "/clients", icon: "👥", enabled: true },
  { label: "Subs", path: "/subcontractors", icon: "🔧", enabled: true },
  { label: "Settings", path: "/settings", icon: "⚙️", enabled: true },
];
