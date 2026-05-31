import { useAuth } from "../../store/auth";
import { initials } from "../../lib/format";
import { go } from "../../lib/nav";
import { NotificationBell } from "./NotificationBell";
import logoUrl from "../../assets/chs-logo.png";

export function TopNav() {
  const { user } = useAuth();
  return (
    <header class="topnav">
      <div class="topnav__brand" onClick={() => go("/")} style={{ cursor: "pointer" }}>
        <img class="topnav__brand-logo" src={logoUrl} alt="Columbus Home Solutions" />
        <span>CHS Platform</span>
      </div>
      <div class="topnav__right">
        <NotificationBell />
        <button class="topnav__user" onClick={() => go("/settings")}>
          <span class="topnav__avatar">
            {user ? initials(user.first_name, user.last_name, user.email) : "?"}
          </span>
          <span class="topnav__user-meta">
            <span class="topnav__user-name">
              {user ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email : "Guest"}
            </span>
            <span class="topnav__user-role">{user ? user.role.replace(/_/g, " ") : "not signed in"}</span>
          </span>
        </button>
      </div>
    </header>
  );
}
