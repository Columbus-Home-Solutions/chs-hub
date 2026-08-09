import { useEffect, useState } from "preact/hooks";
import { hideNativeSplash, isNativePlatform } from "../../lib/native";
import logoUrl from "../../assets/chs-logo.png";

type Phase = "boot" | "zoom" | "fade" | "done";

/**
 * Native-only launch intro: starts with the logo oversized (edges clipped,
 * matching the Capacitor splash) then zooms out to a readable size and fades.
 */
export function LaunchSplash() {
  const [phase, setPhase] = useState<Phase>(() =>
    isNativePlatform() ? "boot" : "done",
  );

  useEffect(() => {
    if (phase === "done") return;
    if (!isNativePlatform()) {
      setPhase("done");
      return;
    }

    let cancelled = false;
    const timers: number[] = [];

    // Hand off from the native splash with no fade so the web overlay matches.
    void hideNativeSplash(0).then(() => {
      if (cancelled) return;
      // Next frame: trigger CSS zoom-out from the oversized start state.
      timers.push(
        window.setTimeout(() => {
          if (!cancelled) setPhase("zoom");
        }, 40),
      );
      // After zoom settles, fade the overlay.
      timers.push(
        window.setTimeout(() => {
          if (!cancelled) setPhase("fade");
        }, 1100),
      );
      // Unmount.
      timers.push(
        window.setTimeout(() => {
          if (!cancelled) setPhase("done");
        }, 1550),
      );
    });

    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  if (phase === "done") return null;

  return (
    <div
      class={`launch-splash${phase === "zoom" || phase === "fade" ? " launch-splash--zoom" : ""}${phase === "fade" ? " launch-splash--fade" : ""}`}
      aria-hidden="true"
    >
      <img class="launch-splash__logo" src={logoUrl} alt="" draggable={false} />
    </div>
  );
}
