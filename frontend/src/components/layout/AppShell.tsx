import type { ComponentChildren } from "preact";
import { Sidebar } from "./Sidebar";
import { TopNav } from "./TopNav";
import { MOBILE_TABS, go, isActive } from "../../lib/nav";

export function AppShell({ children }: { children: ComponentChildren }) {
  return (
    <div class="app-shell">
      <TopNav />
      <div class="app-body">
        <Sidebar />
        <main class="content">
          <div class="content__inner">{children}</div>
        </main>
      </div>
      <nav class="bottom-tabs">
        {MOBILE_TABS.map((tab) => (
          <button
            key={tab.path}
            class={`bottom-tabs__btn${isActive(tab.path) ? " bottom-tabs__btn--active" : ""}`}
            onClick={() => go(tab.path)}
          >
            <span class="bottom-tabs__icon">{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
