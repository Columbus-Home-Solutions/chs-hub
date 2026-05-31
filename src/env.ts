/**
 * Worker bindings (see wrangler.toml) + secrets (set via `wrangler secret put`).
 */
export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;

  JOBBER_CLIENT_ID: string;
  JOBBER_CLIENT_SECRET: string;
  JOBBER_REFRESH_TOKEN: string;

  SYNC_TRIGGER_SECRET: string;

  // Full service account JSON blob from Google Cloud (see docs/google-sheets-setup.md).
  // Parsed at runtime to extract client_email and private_key for JWT signing.
  GOOGLE_SERVICE_ACCOUNT_JSON: string;

  // HighLevel Private Integration Token (starts with "pit-"). Generated in
  // HL Settings → Private Integrations. Scoped to a single location.
  HL_PRIVATE_TOKEN: string;
  // Location ID. Not secret — appears in HL URLs — lives in wrangler.toml [vars].
  HL_LOCATION_ID: string;

  // Dashboard `index.html` — replace %%OAUTH_CLIENT_ID%% at the edge (wrangler [vars]).
  DASHBOARD_OAUTH_CLIENT_ID?: string;

  /** Google Shared Drive ID (API `driveId`) — optional; enables D1/R2 → Drive mirror. */
  DRIVE_SHARED_DRIVE_ID?: string;
  /** Folder ID inside the Shared Drive where CHS-Hub creates Photos / Expenses / Company. */
  DRIVE_MIRROR_ROOT_FOLDER_ID?: string;

  // ─── Operational notifications (Resend) ─────────────────────────
  // All four reliability features (heartbeat, DLQ retry alerts, backup
  // verification, daily summary) flow through src/lib/ops/notify.ts.
  // If any of these are missing, notify() falls back to dry-run logging
  // rather than throwing — alerts must never break the sync itself.
  RESEND_API_KEY: string;       // secret, "re_..."
  ALERT_EMAIL_FROM: string;     // secret, must be a verified Resend sender
  ALERT_EMAIL_TO: string;       // secret, recipient (alias preferred)
  RESEND_DRY_RUN: string;       // var, "1" disables real sends (logs only)

  // ─── Stripe (Sprint 5 — deposit payments) ──────────────────────
  // Test keys locally. Prefer Worker secrets; falls back to system_settings
  // (stripe_secret_key / stripe_webhook_secret / stripe_publishable_key).
  // The publishable key is the only one safe to expose to the client.
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PUBLISHABLE_KEY?: string;

  /** HMAC for POST /api/file-link (shareable /api/f?t=… URLs). `wrangler secret put FILE_LINK_SECRET` — 32+ random bytes, hex or base64 ok. */
  FILE_LINK_SECRET?: string;
  /** Public origin for shared links, e.g. `https://chs-hub.<subdomain>.workers.dev` so links work without Cloudflare Access. Optional; defaults to the request host. */
  HUB_FILE_LINK_ORIGIN?: string;

  // ─── Notification engine (Sprint 7) ─────────────────────────────
  // Dispatch mode. "live" attempts real SMS/email when credentials are present
  // (and falls back to simulate when they're absent); anything else (default,
  // incl. unset) forces SIMULATE — render + log a notification_logs row marked
  // external_id='simulated:<uuid>' WITHOUT hitting Twilio/Resend, so the engine
  // is fully testable locally and never messages a real client. Set in
  // wrangler.toml [vars]; NOT a secret.
  NOTIFICATIONS_DISPATCH_MODE?: string;
  /** Absolute origin used to build client-facing links ({{estimate_link}}, {{portal_link}}). wrangler.toml [vars]. */
  APP_PUBLIC_ORIGIN?: string;

  // Twilio (SMS send + inbound/status webhook signature verify). All secrets;
  // a Pre-Launch item. Absent ⇒ SMS simulates and inbound webhooks reject.
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;

  /** Client-facing "from" address for notification emails. Falls back to ALERT_EMAIL_FROM. Pre-Launch: a verified Resend sender. */
  NOTIFICATIONS_EMAIL_FROM?: string;

  // ─── Claude / Anthropic (Sprint 8 — receipt + smart-note AI) ─────
  // Two ways to reach Claude, checked in this order by src/lib/claude.ts:
  //   1. ANTHROPIC_API_KEY (secret) → call api.anthropic.com directly.
  //   2. CLAUDE_PROXY_URL (var)     → POST the Messages body to the existing
  //      chs-claude-proxy worker, which holds the key server-side (this is the
  //      path the dashboard + capture PWA already use client-side).
  // If NEITHER is set (or the call fails), receipt/note AI degrades gracefully:
  // the photo/note row still persists, marked pending/failed, and manual entry
  // works — mirroring the Sprint 7 simulate discipline so local dev never needs
  // a key. Defaulted in code to the known proxy URL when unset.
  ANTHROPIC_API_KEY?: string;
  CLAUDE_PROXY_URL?: string;
}
