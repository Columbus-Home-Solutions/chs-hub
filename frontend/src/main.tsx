import { render } from "preact";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/app.css";
import "./styles/punch.css";
import { App } from "./app";
import { resolveViewportTier } from "./hooks/useViewportTier";
import { isNativePlatform } from "./lib/native";

const LOCKED_VIEWPORT =
  "width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover";
const DESKTOP_VIEWPORT = "width=device-width, initial-scale=1.0, viewport-fit=cover";

/**
 * Lock pinch-zoom on phone/tablet (and any Capacitor shell). Desktop browser
 * keeps normal scaling (Ctrl+/−).
 *
 * Important: iPadOS 13+ often reports a Macintosh desktop UA with no "iPad"
 * token, and iPad widths are >767px — so UA/narrow checks alone miss tablets.
 * Use the same viewport-tier detection as the tablet shell.
 */
function applyMobileViewportLock() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;

  const tier = resolveViewportTier();
  const lock = isNativePlatform() || tier === "mobile" || tier === "tablet";

  if (lock) {
    meta.setAttribute("content", LOCKED_VIEWPORT);
    document.documentElement.classList.add("is-mobile-shell");
  } else {
    meta.setAttribute("content", DESKTOP_VIEWPORT);
    document.documentElement.classList.remove("is-mobile-shell");
  }
}

applyMobileViewportLock();
window.addEventListener("resize", applyMobileViewportLock);
window.addEventListener("orientationchange", applyMobileViewportLock);
window.matchMedia("(pointer: coarse)").addEventListener("change", applyMobileViewportLock);
window.matchMedia("(hover: none)").addEventListener("change", applyMobileViewportLock);

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}
