/**
 * Capacitor configuration — Sprint 18 (deliverable F).
 *
 * This is a SEPARATE BUILD TARGET from the Worker/Vite deploy. It wraps the
 * EXISTING web app (the same Vite build that ships to dashboard.homesolutionsar.com)
 * in a native iOS/Android shell. It does NOT fork the app, and it does NOT alter
 * the Worker, the Vite config, the host-routing guard, or the PWA fallback.
 *
 * ── server.url vs. bundled assets — DECISION: BUNDLED ASSETS ──────────────────
 * `webDir` points at the already-built web bundle (`public/app`). The native
 * binary ships those assets and loads them from the local `capacitor://` origin.
 *
 *   Why bundled (not server.url):
 *     • Store-stable + offline-friendly — the app opens without connectivity and
 *       the offline photo-capture path keeps working.
 *     • Avoids loading the Access-gated host directly into the WebView as the
 *       app's main document (see the auth note below).
 *   Caveat (recorded): web-content changes require a rebuild + resubmit. Native
 *     plugin changes require a resubmit regardless, so this is acceptable.
 *
 * ── ⚠️ Access-session-in-WebView — PRE-LAUNCH BLOCKER (flagged) ───────────────
 * Bundled assets load locally, but the app still calls the API at the Access-
 * gated host (dashboard.homesolutionsar.com/api/*). A native WebView does not
 * automatically carry a Cloudflare Access session, so authenticated API calls
 * will 302→Access-login and fail until this is resolved. This intersects the
 * unresolved APP_PUBLIC_ORIGIN / public-hostname Pre-Launch item. Options to
 * decide at Pre-Launch (NOT this sprint — push/dispatch stay SIMULATE):
 *     1. A service-token / device-auth path for the native app to the API, OR
 *     2. A public (non-Access) API origin scoped to the app with its own auth,
 *        OR
 *     3. An in-WebView Access login flow that persists the cookie.
 * Until then, the native build is for TestFlight/internal-testing wiring only.
 * `appServerUrl` below is the API base the bundled app talks to — set it when
 * the auth path is decided.
 */

import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.homesolutionsar.chs",
  appName: "CHS Hub",
  // The deploy step builds the Vite app into public/app (see package.json
  // "build:frontend"). Capacitor copies this directory into the native binary.
  webDir: "public/app",
  // No `server.url` — bundled assets (see decision above). When/if the
  // Access-session question is resolved in favor of server.url, set:
  //   server: { url: "https://dashboard.homesolutionsar.com", cleartext: false }
  server: {
    androidScheme: "https",
    iosScheme: "https",
    // The API the bundled app calls. Pre-Launch: confirm against the resolved
    // public-hostname / Access decision above.
    allowNavigation: ["dashboard.homesolutionsar.com"],
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: "#1d2733",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#1d2733",
    },
    PushNotifications: {
      // SIMULATE this sprint — the token is registered to /api/devices/register
      // and the dispatcher logs the intended push. No live FCM/APNS send.
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
