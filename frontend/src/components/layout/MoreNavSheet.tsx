import { useEffect, useMemo, useState } from "preact/hooks";
import { useRouter, route } from "preact-router";
import { go } from "../../lib/nav";
import {
  SIDEBAR_NAV,
  childActive,
  parentActive,
  type NavSection,
} from "../../lib/sidebar-nav";
import { SlideUpSheet } from "./SlideUpSheet";

/**
 * Mobile More sheet: same accordion as desktop sidebar, minus sections already
 * covered by primary tabs. Settings is filtered here only (avatar → Settings);
 * sidebar-nav.ts / desktop Sidebar are untouched.
 */
const OMIT_SECTION_IDS = new Set(["dashboard", "jobs", "settings"]);

function moreSections(): NavSection[] {
  return SIDEBAR_NAV.filter((s) => !OMIT_SECTION_IDS.has(s.id));
}

export function MoreNavSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [router] = useRouter();
  const currentPath = router.url?.split("?")[0] ?? "/";
  const currentSearch = router.url?.includes("?")
    ? router.url.slice(router.url.indexOf("?") + 1)
    : "";

  const sections = useMemo(() => moreSections(), []);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Always open fully collapsed — no People (or active-route) pre-expand.
  useEffect(() => {
    if (!open) return;
    setExpanded(new Set());
  }, [open]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function navInternal(path: string) {
    onClose();
    go(path);
  }

  function navHref(href: string) {
    onClose();
    route(href);
  }

  return (
    <SlideUpSheet open={open} onClose={onClose} title="More" ariaLabel="More navigation">
      <nav class="more-nav-sheet__nav">
        {sections.map((section) => (
          <MoreSection
            key={section.id}
            section={section}
            expanded={expanded.has(section.id)}
            currentPath={currentPath}
            currentSearch={currentSearch}
            onToggle={() => toggle(section.id)}
            onClose={onClose}
            onNavInternal={navInternal}
            onNavHref={navHref}
          />
        ))}
      </nav>
    </SlideUpSheet>
  );
}

function MoreSection({
  section,
  expanded,
  currentPath,
  currentSearch,
  onToggle,
  onClose,
  onNavInternal,
  onNavHref,
}: {
  section: NavSection;
  expanded: boolean;
  currentPath: string;
  currentSearch: string;
  onToggle: () => void;
  onClose: () => void;
  onNavInternal: (path: string) => void;
  onNavHref: (href: string) => void;
}) {
  if (section.noChildren) {
    const active = parentActive(section, currentPath, currentSearch);
    return (
      <button
        type="button"
        class={`more-nav-sheet__row${active ? " more-nav-sheet__row--active" : ""}`}
        onClick={() => onNavInternal(section.navPath!)}
      >
        <span class="more-nav-sheet__icon">{section.icon}</span>
        <span>{section.label}</span>
      </button>
    );
  }

  const anyChildActive = section.children?.some((c) =>
    childActive(c, currentPath, currentSearch),
  );

  return (
    <div class="more-nav-sheet__section">
      <button
        type="button"
        class={`more-nav-sheet__row more-nav-sheet__row--parent${anyChildActive ? " more-nav-sheet__row--child-active" : ""}`}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span class="more-nav-sheet__icon">{section.icon}</span>
        <span class="more-nav-sheet__row-label">{section.label}</span>
        <span class={`more-nav-sheet__chevron${expanded ? " more-nav-sheet__chevron--open" : ""}`}>
          ▸
        </span>
      </button>
      {expanded && (
        <div class="more-nav-sheet__submenu">
          {section.children?.map((child) => {
            if (child.external) {
              return (
                <a
                  key={child.href}
                  class="more-nav-sheet__sublink"
                  href={child.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={onClose}
                >
                  {child.label}
                  <span class="more-nav-sheet__ext">↗</span>
                </a>
              );
            }
            if (child.placeholder) {
              return (
                <div
                  key={child.href}
                  class="more-nav-sheet__sublink more-nav-sheet__sublink--placeholder"
                >
                  {child.label}
                  <span class="more-nav-sheet__soon">Soon</span>
                </div>
              );
            }
            const active = childActive(child, currentPath, currentSearch);
            return (
              <button
                key={child.href}
                type="button"
                class={`more-nav-sheet__sublink${active ? " more-nav-sheet__sublink--active" : ""}`}
                onClick={() => onNavHref(child.href)}
              >
                {child.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
