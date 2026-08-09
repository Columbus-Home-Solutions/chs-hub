import { useState } from "preact/hooks";
import { useRouter } from "preact-router";
import { route } from "preact-router";
import { go } from "../../lib/nav";
import {
  SIDEBAR_NAV,
  childActive,
  parentActive,
} from "../../lib/sidebar-nav";

// ─── Component ────────────────────────────────────────────────────────────────

export function Sidebar({
  mobileOpen = false,
  onClose,
}: {
  mobileOpen?: boolean;
  onClose?: () => void;
}) {
  const [router] = useRouter();
  const currentPath = router.url?.split("?")[0] ?? "/";
  const currentSearch = router.url?.includes("?")
    ? router.url.slice(router.url.indexOf("?") + 1)
    : "";

  // Sections that start expanded: those with an active child, plus Jobs always
  const initiallyOpen = new Set<string>(
    SIDEBAR_NAV.filter(
      (s) =>
        s.id === "jobs" ||
        s.children?.some((c) => childActive(c, currentPath, currentSearch)),
    ).map((s) => s.id),
  );
  const [expanded, setExpanded] = useState<Set<string>>(initiallyOpen);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <aside class={`sidebar${mobileOpen ? " sidebar--open" : ""}`}>
      <nav class="sidebar__nav">
        {SIDEBAR_NAV.map((section) => {
          const isExpanded = expanded.has(section.id);

          // ── Direct-nav item (no submenu) ──────────────────────────────────
          if (section.noChildren) {
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
