import { useAuth } from "../../store/auth";
import { initials } from "../../lib/format";
import {
  TABLET_TABS,
  go,
  isActive,
  isEstimatesTabActive,
} from "../../lib/nav";

/**
 * iPad / tablet vertical rail — same primary destinations as phone tabs
 * (Home, Estimates, Jobs, Clients, More) plus avatar → Settings.
 * Width/labels adapt via CSS orientation (portrait icon-only, landscape labeled).
 * Brand logo lives in the top bar (not the rail).
 */
export function TabletSidebar({
  moreOpen,
  onMoreToggle,
  onNavigate,
}: {
  moreOpen: boolean;
  onMoreToggle: () => void;
  /** Close overlays before routing to a primary tab / Settings. */
  onNavigate?: () => void;
}) {
  const { user } = useAuth();
  const displayName = user
    ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email
    : "Guest";

  function tabActive(path: string): boolean {
    if (path === "/estimates") return isEstimatesTabActive();
    if (path === "__more__") return moreOpen;
    return isActive(path);
  }

  function navigate(path: string) {
    onNavigate?.();
    go(path);
  }

  return (
    <aside class="tablet-rail" aria-label="Tablet navigation">
      <nav class="tablet-rail__nav">
        {TABLET_TABS.map((tab) => {
          if (tab.path === "__more__") {
            return (
              <button
                key="more"
                type="button"
                class={`tablet-rail__btn${moreOpen ? " tablet-rail__btn--active" : ""}`}
                aria-label="More"
                aria-expanded={moreOpen}
                onClick={onMoreToggle}
              >
                <span class="tablet-rail__icon" aria-hidden="true">
                  {tab.icon}
                </span>
                <span class="tablet-rail__label">{tab.label}</span>
              </button>
            );
          }
          return (
            <button
              key={tab.path}
              type="button"
              class={`tablet-rail__btn${tabActive(tab.path) ? " tablet-rail__btn--active" : ""}`}
              aria-label={tab.label}
              onClick={() => navigate(tab.path)}
            >
              <span class="tablet-rail__icon" aria-hidden="true">
                {tab.icon}
              </span>
              <span class="tablet-rail__label">{tab.label}</span>
            </button>
          );
        })}
      </nav>

      <div class="tablet-rail__spacer" />

      <button
        type="button"
        class="tablet-rail__avatar-btn"
        onClick={() => navigate("/settings")}
        aria-label={user ? `${displayName} — Settings` : "Settings"}
        title="Settings"
      >
        <span class="tablet-rail__avatar">
          {user ? initials(user.first_name, user.last_name, user.email) : "?"}
        </span>
        <span class="tablet-rail__label">Settings</span>
      </button>
    </aside>
  );
}
