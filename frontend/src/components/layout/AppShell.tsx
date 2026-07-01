import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { useRouter } from "preact-router";
import { Sidebar } from "./Sidebar";
import { TopNav } from "./TopNav";
import { QuickCaptureSheet } from "./QuickCaptureSheet";
import { MOBILE_TABS_LEFT, MOBILE_TABS_RIGHT, go, isActive, currentJobIdFromRoute } from "../../lib/nav";
import { MessageCenterProvider } from "../../store/messageCenter";
import { MessageCenter } from "../MessageCenter";

export function AppShell({ children }: { children: ComponentChildren }) {
  const [{ url }] = useRouter();
  const [captureOpen, setCaptureOpen] = useState(false);
  const jobId = currentJobIdFromRoute(url);

  return (
    <MessageCenterProvider>
      <div class="app-shell">
        <TopNav />
        <div class="app-body">
          <Sidebar />
          <main class="content">
            <div class="content__inner">{children}</div>
          </main>
        </div>
        <nav class="bottom-tabs" aria-label="Mobile navigation">
          {MOBILE_TABS_LEFT.map((tab) => (
            <button
              key={tab.path}
              class={`bottom-tabs__btn${isActive(tab.path, url) ? " bottom-tabs__btn--active" : ""}`}
              onClick={() => go(tab.path)}
            >
              <span class="bottom-tabs__icon">{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
          <button
            type="button"
            class="bottom-tabs__btn nav__center-btn"
            aria-label="Quick capture"
            onClick={() => setCaptureOpen(true)}
          >
            <span class="bottom-tabs__icon nav__center-btn__icon">+</span>
          </button>
          {MOBILE_TABS_RIGHT.map((tab) => (
            <button
              key={tab.path}
              class={`bottom-tabs__btn${isActive(tab.path, url) ? " bottom-tabs__btn--active" : ""}`}
              onClick={() => go(tab.path)}
            >
              <span class="bottom-tabs__icon">{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
        <QuickCaptureSheet open={captureOpen} jobId={jobId} onClose={() => setCaptureOpen(false)} />
        {/* Message Center slide-out panel — rendered at app-shell level so it's accessible from any screen */}
        <MessageCenter />
      </div>
    </MessageCenterProvider>
  );
}
