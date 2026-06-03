/**
 * Capacitor native-runtime bridge + graceful web fallback (Sprint 18, deliv. F).
 *
 * The web app is wrapped by Capacitor for iOS/Android, but the SAME bundle runs
 * as a PWA in a browser. Every native enhancement here is feature-detected
 * against the global `Capacitor` bridge that the native WebView injects at
 * runtime — so there is NO build-time dependency on the @capacitor/* npm
 * packages in the web bundle, and the PWA path keeps working unchanged when the
 * bridge is absent.
 *
 *   isNativePlatform()  → are we inside the Capacitor native shell?
 *   getPlatform()       → 'ios' | 'android' | 'web'
 *   registerPushDevice()→ (native only) request permission, get the FCM/APNS
 *                         token, and POST it to /api/devices/register. On web it
 *                         is a no-op (the existing web/notification path is
 *                         unchanged). Dispatch is SIMULATE this sprint.
 *   nativeHaptic()      → light haptic tap on native, no-op on web.
 */

interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
}

function bridge(): CapacitorBridge | null {
  const cap = (globalThis as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
  return cap ?? null;
}

export function isNativePlatform(): boolean {
  const cap = bridge();
  return Boolean(cap?.isNativePlatform?.());
}

export function getPlatform(): "ios" | "android" | "web" {
  const p = bridge()?.getPlatform?.();
  return p === "ios" || p === "android" ? p : "web";
}

function plugin<T = Record<string, unknown>>(name: string): T | null {
  const p = bridge()?.Plugins?.[name];
  return (p as T) ?? null;
}

interface PushPlugin {
  requestPermissions: () => Promise<{ receive: string }>;
  register: () => Promise<void>;
  addListener: (
    event: string,
    cb: (data: { value?: string; error?: string }) => void,
  ) => Promise<unknown> | unknown;
}

let pushWired = false;

/**
 * Register this device for push (native only). Returns a status string for the
 * UI. Idempotent — wires the bridge listeners once. The token is sent to the
 * backend; under SIMULATE the dispatcher logs the intended push (no live send).
 */
export async function registerPushDevice(): Promise<
  "registered" | "not_native" | "denied" | "unavailable" | "error"
> {
  if (!isNativePlatform()) return "not_native"; // PWA: existing web path, unchanged
  const push = plugin<PushPlugin>("PushNotifications");
  if (!push) return "unavailable";

  try {
    const perm = await push.requestPermissions();
    if (perm.receive !== "granted") return "denied";

    if (!pushWired) {
      pushWired = true;
      push.addListener("registration", (data) => {
        const token = data?.value;
        if (!token) return;
        void fetch("/api/devices/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: getPlatform(), token }),
        });
      });
      push.addListener("registrationError", (data) => {
        console.warn("[push] registration error", data?.error);
      });
    }
    await push.register();
    return "registered";
  } catch (err) {
    console.warn("[push] register failed", (err as Error).message);
    return "error";
  }
}

/** Unregister this device's push token (native only; best-effort). */
export async function unregisterPushDevice(token: string): Promise<void> {
  await fetch("/api/devices/unregister", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => undefined);
}

interface HapticsPlugin {
  impact: (opts: { style: string }) => Promise<void>;
}

/** Light haptic feedback on native; no-op on web. */
export function nativeHaptic(style: "LIGHT" | "MEDIUM" | "HEAVY" = "LIGHT"): void {
  if (!isNativePlatform()) return;
  const haptics = plugin<HapticsPlugin>("Haptics");
  void haptics?.impact({ style }).catch(() => undefined);
}
