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
  // Remote-load for Access-in-WebView verification (Phase 0 follow-up).
  // Loads the live Access-gated host so login cookies attach to the same origin
  // as the API. Bundled webDir remains as offline fallback when url is unset.
  server: {
    url: "https://dashboard.homesolutionsar.com/app/",
    androidScheme: "https",
    iosScheme: "https",
    // Keep Access OTP/login redirects inside the WebView (not Safari).
    allowNavigation: [
      "dashboard.homesolutionsar.com",
      "*.cloudflareaccess.com",
    ],
  },
  plugins: {
    SplashScreen: {
      // Stay up until LaunchSplash (web) takes over and calls hide().
      launchAutoHide: false,
      launchShowDuration: 0,
      backgroundColor: "#000000",
      // Fill the short axis so the badge starts oversized (edges clipped) —
      // matching the zoom-out intro that follows in the WebView.
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#1d2733",
      // Keep the WebView below the iOS status bar (default is true = overlap).
      overlaysWebView: false,
    },
    PushNotifications: {
      // SIMULATE this sprint — the token is registered to /api/devices/register
      // and the dispatcher logs the intended push. No live FCM/APNS send.
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
