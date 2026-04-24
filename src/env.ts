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
}
