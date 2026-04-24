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
}
