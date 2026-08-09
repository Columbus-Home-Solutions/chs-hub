import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { useRouter } from "preact-router";
import { Sidebar } from "./Sidebar";
import { TabletSidebar } from "./TabletSidebar";
import { TopNav } from "./TopNav";
import { QuickCaptureSheet } from "./QuickCaptureSheet";
import { MoreNavSheet } from "./MoreNavSheet";
import {
  MOBILE_TABS_LEFT,
  MOBILE_TABS_RIGHT,
  go,
  isActive,
  isEstimatesTabActive,
  currentJobIdFromRoute,
} from "../../lib/nav";
import { useViewportTier } from "../../hooks/useViewportTier";
import { MessageCenterProvider } from "../../store/messageCenter";
import { MessageCenter } from "../MessageCenter";

export function AppShell({ children }: { children: ComponentChildren }) {
  const [{ url }] = useRouter();
  const tier = useViewportTier();
  const [captureOpen, setCaptureOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const jobId = currentJobIdFromRoute(url);

  function tabActive(path: string): boolean {
    if (path === "/estimates") return isEstimatesTabActive(url);
    if (path === "__more__") return moreOpen;
    return isActive(path, url);
  }

  /** Bottom / tablet nav always wins over Search / More / Capture / notif overlays. */
  function closeOverlays() {
    setMoreOpen(false);
    setCaptureOpen(false);
    setSearchOpen(false);
    window.dispatchEvent(new CustomEvent("chs:close-overlays"));
  }

  function openCapture() {
    setMoreOpen(false);
    setSearchOpen(false);
    setCaptureOpen(true);
  }

  return (
    <MessageCenterProvider>
      <div class={`app-shell app-shell--${tier}`}>
        <TopNav searchOpen={searchOpen} onSearchOpenChange={setSearchOpen} />
        <div class="app-body">
          {tier === "desktop" && <Sidebar />}
          {tier === "tablet" && (
            <TabletSidebar
              moreOpen={moreOpen}
              onMoreToggle={() => {
                setCaptureOpen(false);
                setSearchOpen(false);
                setMoreOpen((v) => !v);
              }}
              onNavigate={closeOverlays}
            />
          )}
          <main class="content">
            <div class="content__inner">{children}</div>
          </main>
        </div>

        {tier === "mobile" && (
          <nav class="bottom-tabs" aria-label="Mobile navigation">
            {MOBILE_TABS_LEFT.map((tab) => (
              <button
                key={tab.path}
                type="button"
                class={`bottom-tabs__btn${tabActive(tab.path) ? " bottom-tabs__btn--active" : ""}`}
                onClick={() => {
                  closeOverlays();
                  go(tab.path);
                }}
              >
                <span class="bottom-tabs__icon">{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
            <button
              type="button"
              class="bottom-tabs__btn nav__center-btn"
              aria-label="Quick capture"
              onClick={openCapture}
            >
              <span class="bottom-tabs__icon nav__center-btn__icon">+</span>
            </button>
            {MOBILE_TABS_RIGHT.map((tab) => {
              if (tab.path === "__more__") {
                return (
                  <button
                    key="more"
                    type="button"
                    class={`bottom-tabs__btn${moreOpen ? " bottom-tabs__btn--active" : ""}`}
                    aria-label="More"
                    onClick={() => {
                      setCaptureOpen(false);
                      setSearchOpen(false);
                      setMoreOpen((v) => !v);
                    }}
                  >
                    <span class="bottom-tabs__icon">{tab.icon}</span>
                    <span>{tab.label}</span>
                  </button>
                );
              }
              return (
                <button
                  key={tab.path}
                  type="button"
                  class={`bottom-tabs__btn${tabActive(tab.path) ? " bottom-tabs__btn--active" : ""}`}
                  onClick={() => {
                    closeOverlays();
                    go(tab.path);
                  }}
                >
                  <span class="bottom-tabs__icon">{tab.icon}</span>
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        )}

        {tier === "tablet" && (
          <button
            type="button"
            class="capture-fab"
            aria-label="Quick capture"
            onClick={openCapture}
          >
            +
          </button>
        )}

        <QuickCaptureSheet open={captureOpen} jobId={jobId} onClose={() => setCaptureOpen(false)} />
        <MoreNavSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
        <MessageCenter />
      </div>
    </MessageCenterProvider>
  );
}
