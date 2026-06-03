#!/usr/bin/env bash
#
# Capacitor native setup — Sprint 18 (deliverable F).
#
# Cursor produced capacitor.config.ts + the plugin wiring + the runtime-detection
# helper (frontend/src/lib/native.ts) + the web fallback. THIS SCRIPT installs the
# Capacitor toolchain and adds the iOS/Android native projects. It is Tony's
# out-of-band step because it needs Xcode (iOS) and the Android SDK locally, which
# the build agent does not have.
#
# Run from the repo root:  bash scripts/capacitor-setup.sh
#
# Nothing here flips anything live. Push stays SIMULATE (the dispatcher logs the
# intended push); real FCM/APNS is a separate Pre-Launch flip.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Building the web bundle (the assets Capacitor wraps)…"
npm run build:frontend

echo "==> Installing Capacitor core + CLI + plugins…"
npm install --save \
  @capacitor/core \
  @capacitor/cli \
  @capacitor/ios \
  @capacitor/android \
  @capacitor/camera \
  @capacitor/geolocation \
  @capacitor/push-notifications \
  @capacitor/filesystem \
  @capacitor/haptics \
  @capacitor/status-bar \
  @capacitor/splash-screen \
  @capacitor/app

echo "==> Adding native platforms (idempotent — skips if already present)…"
[ -d ios ]     || npx cap add ios
[ -d android ] || npx cap add android

echo "==> Syncing web assets + plugins into the native projects…"
npx cap sync

cat <<'NEXT'

==> Done. Native projects created (ios/ and android/).

Next (Tony, out-of-band — see CHS-Capacitor-Submission-Checklist.md):
  • Generate app icons + splash from Logo3* (use @capacitor/assets).
  • iOS:     npx cap open ios      → set signing team, bundle id, push capability → Archive → TestFlight.
  • Android: npx cap open android  → set applicationId, signing config → build AAB → Play internal testing.

After ANY web change:   npm run build:frontend && npx cap sync   (bundled-assets caveat).
NEXT
