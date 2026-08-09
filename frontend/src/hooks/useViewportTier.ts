import { useEffect, useState } from "preact/hooks";

/**
 * Layout chrome tier:
 * - mobile  — phone bottom tabs (≤767 CSS path, non-tablet)
 * - tablet  — adaptive icon rail (iPad-class touch viewports)
 * - desktop — full sidebar
 *
 * Tablet range rationale (CSS px):
 *   iPad mini 744×1133 → Pro 13" 1032×1376 (and landscape swaps).
 *   Require touch-like input + both dimensions "pad-sized" so phone
 *   landscape (~932×430) and mouse-driven laptop windows stay out.
 */
export type ViewportTier = "mobile" | "tablet" | "desktop";

function isTouchLike(): boolean {
  // pointer/hover media + multi-touch (covers iPadOS “desktop” UA quirks)
  return (
    window.matchMedia("(pointer: coarse)").matches ||
    window.matchMedia("(hover: none)").matches ||
    (typeof navigator !== "undefined" && (navigator.maxTouchPoints ?? 0) > 1)
  );
}

export function resolveViewportTier(): ViewportTier {
  if (typeof window === "undefined") return "desktop";
  const w = window.innerWidth;
  const h = window.innerHeight;
  const shortSide = Math.min(w, h);
  const longSide = Math.max(w, h);

  // iPad-class: touch + both dimensions pad-sized (see file header).
  // longSide ≤ 1400 keeps mouse-driven laptop desktops on the full sidebar.
  if (
    isTouchLike() &&
    shortSide >= 600 &&
    longSide >= 900 &&
    longSide <= 1400
  ) {
    return "tablet";
  }
  if (w <= 767) return "mobile";
  return "desktop";
}

export function useViewportTier(): ViewportTier {
  const [tier, setTier] = useState<ViewportTier>(() => resolveViewportTier());

  useEffect(() => {
    const update = () => setTier(resolveViewportTier());
    update();
    window.addEventListener("resize", update);
    // Orientation changes don't always fire resize on iPad WKWebView.
    window.addEventListener("orientationchange", update);
    const coarse = window.matchMedia("(pointer: coarse)");
    const hover = window.matchMedia("(hover: none)");
    coarse.addEventListener("change", update);
    hover.addEventListener("change", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      coarse.removeEventListener("change", update);
      hover.removeEventListener("change", update);
    };
  }, []);

  return tier;
}
