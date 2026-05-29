import { NAV_ITEMS, go, isActive } from "../../lib/nav";

export function Sidebar() {
  return (
    <aside class="sidebar">
      <nav class="sidebar__nav">
        {NAV_ITEMS.map((item) => {
          const active = item.enabled && isActive(item.path);
          const classes = [
            "sidebar__link",
            active ? "sidebar__link--active" : "",
            item.enabled ? "" : "sidebar__link--disabled",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={item.path}
              class={classes}
              onClick={() => item.enabled && go(item.path)}
            >
              <span class="sidebar__icon">{item.icon}</span>
              <span>{item.label}</span>
              {!item.enabled && <span class="sidebar__soon">Soon</span>}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
