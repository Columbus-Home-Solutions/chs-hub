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

  // Dashboard `index.html` — replace %%…%% at the edge (wrangler [vars]).
  DASHBOARD_OAUTH_CLIENT_ID?: string;
  DASHBOARD_GOOGLE_API_KEY?: string;
  JOB_TRACKER_SHEET_ID?: string;
  WC_SHEET_ID?: string;

  // ─── Operational notifications (Resend) ─────────────────────────
  // All four reliability features (heartbeat, DLQ retry alerts, backup
  // verification, daily summary) flow through src/lib/ops/notify.ts.
  // If any of these are missing, notify() falls back to dry-run logging
  // rather than throwing — alerts must never break the sync itself.
  RESEND_API_KEY: string;       // secret, "re_..."
  ALERT_EMAIL_FROM: string;     // secret, must be a verified Resend sender
  ALERT_EMAIL_TO: string;       // secret, recipient (alias preferred)
  RESEND_DRY_RUN: string;       // var, "1" disables real sends (logs only)
}
