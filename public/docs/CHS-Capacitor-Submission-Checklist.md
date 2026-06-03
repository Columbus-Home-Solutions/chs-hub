# CHS Hub — Capacitor App Store Submission Checklist (Sprint 18)

> **Cursor produces the Capacitor project + plugin config + this checklist. Tony executes the store steps** (Apple/Google accounts, signing certs, review) — those require developer-account access the build agent doesn't have. **Nothing here flips a live key.** Push stays **SIMULATE** this sprint (the dispatcher logs the intended push; real FCM/APNS is a separate Pre-Launch flip).

## What's already in the repo (Cursor's half)

- `capacitor.config.ts` — appId `com.homesolutionsar.chs`, appName **CHS Hub**, **bundled assets** (`webDir: public/app`), Splash/StatusBar/Push plugin config.
- `frontend/src/lib/native.ts` — runtime detection (`isNativePlatform`, `getPlatform`), `registerPushDevice()` (native-only; web no-op), `nativeHaptic()`. **Graceful web fallback: every native call feature-detects the `Capacitor` bridge, so the PWA in a browser runs unchanged.**
- `frontend/src/app.tsx` — calls `registerPushDevice()` on the native shell only.
- Backend: `POST /api/devices/register` / `unregister`, `GET /api/devices` + the SIMULATE push branch in the notification dispatcher.
- `scripts/capacitor-setup.sh` — installs the Capacitor toolchain and adds the `ios/` + `android/` native projects.

## Architecture decisions (recorded)

- **Separate build target.** Capacitor wraps the existing Vite build; it does not alter the Worker, Vite config, host-routing guard, or PWA.
- **Bundled assets (not `server.url`).** Store-stable + offline-friendly. **Caveat:** web-content changes require `npm run build:frontend && npx cap sync` + a resubmit (native plugin changes need a resubmit regardless).
- **⚠️ Access-session-in-WebView — PRE-LAUNCH BLOCKER.** The bundled app loads locally but calls the Access-gated API host. A native WebView doesn't carry a Cloudflare Access session, so authenticated API calls fail until one of these is decided at Pre-Launch: (1) a service/device-auth path for the app→API, (2) a public (non-Access) API origin with its own auth, or (3) an in-WebView Access login that persists the cookie. **This intersects the unresolved `APP_PUBLIC_ORIGIN` / public-hostname item.** Until resolved, the native build is for TestFlight/internal-testing wiring only.

## Native plugins wired (all with web fallback)

| Plugin | Native use | Web fallback |
| --- | --- | --- |
| Camera | native capture sheet | existing `<input capture>` + `frontend/src/lib/capture.ts` |
| Geolocation | native GPS | `navigator.geolocation` (already used) |
| Push Notifications | token → `/api/devices/register` (SIMULATE) | no-op (existing web/notification path) |
| Filesystem | device photo library | n/a (web upload path) |
| Haptics | tap feedback | no-op |
| Status Bar | brand `#1d2733` | n/a |
| Splash Screen | branded launch | n/a |
| App | lifecycle | n/a |

## Step 0 — local prerequisites (Tony)

- [ ] macOS with **Xcode** (latest) + CocoaPods (`sudo gem install cocoapods`).
- [ ] **Android Studio** + SDK + a JDK.
- [ ] `bash scripts/capacitor-setup.sh` — installs deps, adds `ios/` + `android/`, runs `npx cap sync`.
- [ ] Generate icons + splash from `Logo3*`: `npm i -D @capacitor/assets` then `npx capacitor-assets generate`.

## Step 1 — Apple (iOS / TestFlight)

- [ ] Apple Developer Program membership (Columbus Home Solutions).
- [ ] App Store Connect → **new app** record; bundle id `com.homesolutionsar.chs`.
- [ ] `npx cap open ios` → Signing & Capabilities → set Team; enable **Push Notifications** + **Background Modes** (remote notifications) capabilities (kept SIMULATE server-side until Pre-Launch).
- [ ] Set version/build, app icon, launch screen.
- [ ] Product → Archive → Distribute → **TestFlight**; add internal testers.
- [ ] (Pre-Launch, not now) APNs key in the Apple developer portal for the real send flip.

## Step 2 — Google (Android / Play internal testing)

- [ ] Google Play Console account.
- [ ] Create app; `applicationId = com.homesolutionsar.chs`.
- [ ] `npx cap open android` → set signing config (upload keystore — store securely, never commit).
- [ ] Build **AAB** (Build → Generate Signed Bundle).
- [ ] Play Console → **Internal testing** track → upload AAB → add testers.
- [ ] (Pre-Launch, not now) FCM server key wired for the real send flip.

## Step 3 — verify the PWA didn't regress

- [ ] Open the web app in a browser (not the native shell): camera (`<input capture>`), GPS, photo upload, and the offline/batch path all still work — `isNativePlatform()` returns false and every native call no-ops.

## Out of scope this sprint (do NOT do here)

- No live FCM/APNS send (SIMULATE only).
- No live key flips of any kind (Stripe test, notifications SIMULATE, QBO sandbox, WC test sheet, social SIMULATE all unchanged).
- The actual store review submission — that's the launch step after the Access-session blocker is resolved.
