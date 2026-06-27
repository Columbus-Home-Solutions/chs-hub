import { useState } from "preact/hooks";
import { useRouter } from "preact-router";
import { route } from "preact-router";
import { to, go } from "../../lib/nav";

// ─── Types ───────────────────────────────────────────────────────────────────

interface NavChild {
  label: string;
  /** Full URL — internal (/app/...) or external (https://...) */
  href: string;
  external?: boolean;
  placeholder?: boolean;
  /**
   * Custom active test. Receives the current pathname (no query) and the
   * raw search string (no leading `?`). Required for items that share a
   * path but differ only by query params (Jobs status filters, Financial tabs).
   */
  activeTest?: (path: string, search: string) => boolean;
}

interface NavSection {
  id: string;
  label: string;
  icon: string;
  /**
   * App-relative path (without /app prefix) for the parent label navigation.
   * When undefined the section is "toggle-only" — both label and chevron
   * click toggle the submenu (Jobs, Content, Resources).
   */
  navPath?: string;
  children?: NavChild[];
  /**
   * Direct-nav item with no submenu (Dashboard, Schedule, Settings).
   * navPath is still required for navigation + active detection.
   */
  noChildren?: boolean;
  dividerBefore?: boolean;
  dividerAfter?: boolean;
}

// ─── Active-detection helpers ─────────────────────────────────────────────────

function childActive(child: NavChild, path: string, search: string): boolean {
  if (child.external || child.placeholder) return false;
  if (child.activeTest) return child.activeTest(path, search);

  const [hrefPath, hrefSearch] = child.href.split("?");
  if (path !== hrefPath && !path.startsWith(hrefPath + "/")) return false;
  if (!hrefSearch) return true;

  const want = new URLSearchParams(hrefSearch);
  const have = new URLSearchParams(search);
  for (const [k, v] of want.entries()) {
    if (have.get(k) !== v) return false;
  }
  return true;
}

function parentActive(section: NavSection, path: string, search: string): boolean {
  if (!section.navPath) return false;
  const target = to(section.navPath);
  if (section.navPath === "/") {
    return path === to("/") || path === to("/") + "/";
  }
  // Active when on the parent route but NOT on a child route that overrides it
  const onParentPath = path === target || path.startsWith(target + "/");
  if (!onParentPath) return false;
  // If any child is active (more specific match), the parent row itself isn't
  // highlighted — the active child handles the indicator.
  if (section.children?.some((c) => childActive(c, path, search))) return false;
  return true;
}

// ─── Nav structure ────────────────────────────────────────────────────────────

const NAV: NavSection[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: "🏠",
    navPath: "/",
    noChildren: true,
    dividerAfter: true,
  },
  {
    id: "pipeline",
    label: "Pipeline",
    icon: "📋",
    // No navPath — label + chevron both toggle only (same as Jobs)
    children: [
      {
        label: "Leads",
        href: to("/estimating") + "?tab=chs",
        activeTest: (p, s) =>
          p === to("/estimating") && new URLSearchParams(s).get("tab") === "chs",
      },
      {
        label: "Estimates",
        href: to("/estimates"),
        activeTest: (p) => p === to("/estimates"),
      },
      {
        label: "Google Local Services",
        href: "https://ads.google.com/localservices",
        external: true,
      },
      {
        label: "Thumbtack",
        href: "https://www.thumbtack.com/pro",
        external: true,
      },
    ],
  },
  {
    id: "jobs",
    label: "Jobs",
    icon: "🏗️",
    // No navPath — label + chevron both toggle only
    children: [
      {
        label: "All Jobs",
        href: to("/jobs"),
        activeTest: (p, s) =>
          p === to("/jobs") && !new URLSearchParams(s).has("status"),
      },
      {
        label: "Needs Scheduling",
        href: to("/jobs") + "?status=deposit_paid",
        activeTest: (p, s) =>
          p === to("/jobs") &&
          new URLSearchParams(s).get("status") === "deposit_paid",
      },
      {
        label: "Scheduled",
        href: to("/jobs") + "?status=scheduled",
        activeTest: (p, s) =>
          p === to("/jobs") &&
          new URLSearchParams(s).get("status") === "scheduled",
      },
      {
        label: "In Progress",
        href: to("/jobs") + "?status=in_progress",
        activeTest: (p, s) =>
          p === to("/jobs") &&
          new URLSearchParams(s).get("status") === "in_progress",
      },
      {
        label: "Punch List",
        href: to("/jobs") + "?status=punch_list",
        activeTest: (p, s) =>
          p === to("/jobs") &&
          new URLSearchParams(s).get("status") === "punch_list",
      },
      {
        label: "Needs Reconciliation",
        href: to("/jobs") + "?status=complete",
        activeTest: (p, s) =>
          p === to("/jobs") &&
          new URLSearchParams(s).get("status") === "complete",
      },
      {
        label: "Closed",
        href: to("/jobs") + "?status=closed",
        activeTest: (p, s) =>
          p === to("/jobs") &&
          new URLSearchParams(s).get("status") === "closed",
      },
      {
        label: "Warranty Calls",
        href: to("/warranty-calls"),
        activeTest: (p) =>
          p === to("/warranty-calls") || p.startsWith(to("/warranty-calls") + "/"),
      },
    ],
  },
  {
    id: "schedule",
    label: "Schedule",
    icon: "📅",
    navPath: "/schedule",
    noChildren: true,
  },
  {
    id: "financial",
    label: "Financial",
    icon: "💰",
    // No navPath — label + chevron both toggle only (same as Jobs)
    children: [
      {
        label: "Reports",
        href: to("/financial") + "?tab=reports",
        activeTest: (p, s) =>
          p === to("/financial") && new URLSearchParams(s).get("tab") === "reports",
      },
      {
        label: "WC Spreadsheet",
        href: "https://docs.google.com/spreadsheets/d/1utmYdBkUM8cefQ-1mpEnhiyV-vVf-IOhN1yn_wfXyZo/edit?usp=drive_link",
        external: true,
      },
      {
        label: "Pricing Intelligence",
        href: to("/financial") + "?tab=pricing",
      },
      { label: "QuickBooks", href: "https://app.qbo.intuit.com", external: true },
      { label: "Wisetack", href: "https://app.wisetack.com", external: true },
      { label: "Stripe", href: "https://dashboard.stripe.com", external: true },
    ],
  },
  {
    id: "people",
    label: "People",
    icon: "👥",
    // No navPath — toggle only
    children: [
      {
        label: "Clients",
        href: to("/clients"),
        activeTest: (p) =>
          p === to("/clients") || p.startsWith(to("/clients") + "/"),
      },
      {
        label: "Payers",
        href: to("/payers"),
        activeTest: (p) =>
          p === to("/payers") || p.startsWith(to("/payers") + "/"),
      },
      {
        label: "Subs",
        href: to("/subcontractors"),
        activeTest: (p) =>
          p === to("/subcontractors") ||
          p.startsWith(to("/subcontractors") + "/"),
      },
    ],
  },
  {
    id: "documents",
    label: "Documents",
    icon: "📄",
    // No navPath — toggle only
    children: [
      {
        label: "Photos",
        href: to("/photos"),
        activeTest: (p) =>
          p === to("/photos") || p.startsWith(to("/photos") + "/"),
      },
      {
        label: "Documents",
        href: to("/documents"),
        activeTest: (p, s) =>
          p === to("/documents") && !new URLSearchParams(s).has("tab"),
      },
      {
        label: "Company Docs",
        href: to("/company-docs"),
        activeTest: (p) =>
          p === to("/company-docs") || p.startsWith(to("/company-docs") + "/"),
      },
    ],
  },
  {
    id: "social",
    label: "Social",
    icon: "📱",
    // No navPath — toggle only
    children: [
      {
        label: "Post Manager",
        href: to("/social"),
        activeTest: (p) => p === to("/social") || p.startsWith(to("/social") + "/"),
      },
      {
        label: "Google Business",
        href: "https://business.google.com",
        external: true,
      },
      {
        label: "Meta Business",
        href: "https://business.facebook.com",
        external: true,
      },
      { label: "Instagram", href: "https://www.instagram.com", external: true },
      { label: "LinkedIn", href: "https://www.linkedin.com", external: true },
      {
        label: "Website",
        href: "https://homesolutionsar.com",
        external: true,
      },
    ],
  },
  {
    id: "content",
    label: "Content",
    icon: "🎨",
    // No navPath — toggle only
    children: [
      { label: "Canva", href: "https://www.canva.com", external: true },
      { label: "Loom", href: "https://www.loom.com", external: true },
    ],
  },
  {
    id: "resources",
    label: "Resources",
    icon: "🔗",
    // No navPath — toggle only
    dividerAfter: true,
    children: [
      { label: "AFCU", href: "https://www.afcu.org", external: true },
      {
        label: "Lowe's Credit",
        href: "https://lowes.syf.com/commercial/",
        external: true,
      },
      { label: "Bill", href: "https://www.bill.com", external: true },
      {
        label: "AMEX",
        href: "https://www.americanexpress.com",
        external: true,
      },
      { label: "Bluevine", href: "https://www.bluevine.com", external: true },
      {
        label: "Cloudflare",
        href: "https://dash.cloudflare.com",
        external: true,
      },
      { label: "Twilio", href: "https://console.twilio.com", external: true },
      {
        label: "Google Cloud",
        href: "https://console.cloud.google.com",
        external: true,
      },
      {
        label: "Google Shared Drive",
        href: "https://drive.google.com",
        external: true,
      },
      {
        label: "QR Code Generator",
        href: "https://www.qr-code-generator.com",
        external: true,
      },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: "⚙️",
    navPath: "/settings",
    noChildren: true,
    dividerBefore: true,
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export function Sidebar() {
  const [{ url }] = useRouter();

  // Derive path and search from the router URL (includes query string)
  const qIdx = url.indexOf("?");
  const currentPath = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const currentSearch = qIdx >= 0 ? url.slice(qIdx + 1) : "";

  // Initialize: expand the one section that contains the active route.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const section of NAV) {
      if (section.children) {
        const active = section.children.some((c) =>
          childActive(c, currentPath, currentSearch),
        );
        init[section.id] = active;
      }
    }
    return init;
  });

  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <aside class="sidebar">
      <nav class="sidebar__nav">
        {NAV.map((section) => {
          const isExpanded = !!expanded[section.id];

          if (section.noChildren && section.navPath) {
            // ── Direct-nav item (Dashboard, Schedule, Settings) ──────────────
            const active = parentActive(section, currentPath, currentSearch);
            return (
              <div key={section.id}>
                {section.dividerBefore && <div class="sidebar__divider" />}
                <div
                  class={`sidebar__link${active ? " sidebar__link--active" : ""}`}
                  onClick={() => go(section.navPath!)}
                >
                  <span class="sidebar__icon">{section.icon}</span>
                  <span>{section.label}</span>
                </div>
                {section.dividerAfter && <div class="sidebar__divider" />}
              </div>
            );
          }

          // ── Collapsible section ───────────────────────────────────────────
          const anyChildActive = section.children?.some((c) =>
            childActive(c, currentPath, currentSearch),
          );
          const pActive =
            !anyChildActive && parentActive(section, currentPath, currentSearch);

          const hasNavPath = !!section.navPath;

          return (
            <div key={section.id}>
              {section.dividerBefore && <div class="sidebar__divider" />}

              {/* Parent row */}
              <div
                class={`sidebar__parent${pActive ? " sidebar__parent--active" : ""}${anyChildActive ? " sidebar__parent--child-active" : ""}`}
                onClick={hasNavPath ? undefined : () => toggle(section.id)}
              >
                {/* Label zone — navigates if section has a parent route */}
                <div
                  class="sidebar__parent-label"
                  onClick={
                    hasNavPath
                      ? (e) => {
                          e.stopPropagation();
                          go(section.navPath!);
                        }
                      : undefined
                  }
                >
                  <span class="sidebar__icon">{section.icon}</span>
                  <span>{section.label}</span>
                </div>

                {/* Chevron zone — always toggles */}
                <div
                  class={`sidebar__chevron${isExpanded ? " sidebar__chevron--open" : ""}`}
                  onClick={
                    hasNavPath
                      ? (e) => {
                          e.stopPropagation();
                          toggle(section.id);
                        }
                      : undefined
                  }
                >
                  ▸
                </div>
              </div>

              {/* Submenu */}
              <div
                class={`sidebar__submenu${isExpanded ? " sidebar__submenu--open" : ""}`}
              >
                {section.children?.map((child) => {
                  const active = childActive(child, currentPath, currentSearch);

                  if (child.external) {
                    return (
                      <a
                        key={child.href}
                        class="sidebar__sublink"
                        href={child.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {child.label}
                        <span class="sidebar__ext-icon">↗</span>
                      </a>
                    );
                  }

                  if (child.placeholder) {
                    return (
                      <div
                        key={child.href}
                        class="sidebar__sublink sidebar__sublink--placeholder"
                        title="Coming soon"
                      >
                        {child.label}
                        <span class="sidebar__soon">Soon</span>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={child.href}
                      class={`sidebar__sublink${active ? " sidebar__sublink--active" : ""}`}
                      onClick={() => route(child.href)}
                    >
                      {child.label}
                    </div>
                  );
                })}
              </div>

              {section.dividerAfter && <div class="sidebar__divider" />}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
