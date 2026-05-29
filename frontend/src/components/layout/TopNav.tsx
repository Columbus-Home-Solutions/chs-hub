import { useAuth } from "../../store/auth";
import { initials } from "../../lib/format";
import { go } from "../../lib/nav";

export function TopNav() {
  const { user } = useAuth();
  return (
    <header class="topnav">
      <div class="topnav__brand" onClick={() => go("/")} style={{ cursor: "pointer" }}>
        <span class="topnav__brand-mark">C</span>
        <span>CHS Platform</span>
      </div>
      <div class="topnav__right">
        <button class="topnav__bell" aria-label="Notifications" title="Notifications">
          🔔
          <span class="topnav__bell-count">0</span>
        </button>
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
