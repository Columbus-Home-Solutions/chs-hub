import { useAuth } from "../../store/auth";
import { useWeather, weatherEmoji } from "../../store/weather";
import { initials } from "../../lib/format";
import { go } from "../../lib/nav";
import { useIsMobile } from "../../hooks/useIsMobile";
import { NotificationBell } from "./NotificationBell";
import { MessageCenterButton } from "../MessageCenter";
import { GlobalSearch } from "./GlobalSearch";
import logoUrl from "../../assets/chs-logo.png";

export function TopNav({
  searchOpen = false,
  onSearchOpenChange,
}: {
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
}) {
  const { user } = useAuth();
  const weather = useWeather();
  const current = weather?.current ?? null;
  const isMobile = useIsMobile();

  const displayName = user
    ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email
    : "Guest";

  const setSearchOpen = (open: boolean) => onSearchOpenChange?.(open);

  return (
    <header class="topnav">
      <div class="topnav__brand" onClick={() => go("/")} style={{ cursor: "pointer" }}>
        <img class="topnav__brand-logo" src={logoUrl} alt="Columbus Home Solutions" />
        <span class="topnav__brand-text topnav__brand-text--full">CHS Platform</span>
        <span class="topnav__brand-text topnav__brand-text--short" aria-hidden="true">CHS</span>
      </div>

      {current && (
        <div class="topnav__weather">
          <span>{weatherEmoji(current.icon)}</span>
          <span>{current.temperature}°F</span>
          <span class="topnav__weather-cond">{current.condition}</span>
        </div>
      )}

      <div class="topnav__right">
        <button
          type="button"
          class="topnav__search-btn"
          aria-label="Search clients and jobs"
          onClick={() => setSearchOpen(true)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
            <path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
        <MessageCenterButton />
        <NotificationBell />
        <button
          type="button"
          class="topnav__user"
          onClick={() => go("/settings")}
          aria-label={user ? `${displayName} — Settings` : "Settings"}
        >
          <span class="topnav__avatar">
            {user ? initials(user.first_name, user.last_name, user.email) : "?"}
          </span>
          {!isMobile && (
            <span class="topnav__user-meta">
              <span class="topnav__user-name">{displayName}</span>
              <span class="topnav__user-role">
                {user ? user.role.replace(/_/g, " ") : "not signed in"}
              </span>
            </span>
          )}
        </button>
      </div>

      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </header>
  );
}
