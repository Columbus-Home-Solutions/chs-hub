/**
 * Google Business Profile — Reviews Sync (Phase B stub).
 *
 * This file exists so Phase B is "fill in the body and wire it up," not
 * "start from scratch." The function signatures, GBP API endpoint shapes,
 * and the data flow are documented here and ready to implement once:
 *
 *   1. GBP API access is approved (applied July 1, 2026 — still pending).
 *   2. OAuth credentials are stored in system_settings or Worker secrets.
 *   3. The `gbp_reviews_live` system_settings flag is flipped to 'true'.
 *
 * ── TODO (Phase B) ────────────────────────────────────────────────────────────
 *   - Wire syncGbpReviews() into the existing "15 7 * * *" nightly cron slot
 *     (runNightly in src/index.ts). Do NOT add a new cron trigger — the
 *     account is already at the 5-trigger Free plan cap.
 *   - Implement postGbpReply() body and call it from
 *     POST /api/google-reviews/:id/reply when gbp_reviews_live === true.
 *   - The OAuth token refresh pattern should mirror the existing QBO OAuth
 *     implementation (src/lib/qbo-sync.ts) — access token in system_settings,
 *     refresh when a 401 is received from the GBP API.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Env } from "../env.js";

// GBP API base URL for the My Business platform.
const GBP_API_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";

// The reviews endpoint under a specific location resource.
// Full path: accounts/{accountId}/locations/{locationId}/reviews
const GBP_REVIEWS_PATH = (accountId: string, locationId: string) =>
  `${GBP_API_BASE}/accounts/${accountId}/locations/${locationId}/reviews`;

// The reply endpoint for a specific review.
const GBP_REPLY_PATH = (accountId: string, locationId: string, reviewId: string) =>
  `${GBP_REVIEWS_PATH(accountId, locationId)}/${reviewId}/reply`;

export interface GbpReview {
  reviewId: string;
  reviewer: {
    profilePhotoUrl?: string;
    displayName: string;
    isAnonymous?: boolean;
  };
  starRating: "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE";
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: {
    comment: string;
    updateTime: string;
  };
  name: string; // resource name, e.g. accounts/.../locations/.../reviews/...
}

/** Map GBP star rating string to integer 1–5. */
function gbpStarToInt(star: GbpReview["starRating"]): number {
  return { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[star] ?? 3;
}

/**
 * Phase B entry point: pull all reviews from GBP and upsert into google_reviews.
 *
 * TODO: implement when GBP API access is approved.
 *   - GET accounts.locations.reviews.list with pageSize=50, paginate until done.
 *   - For each review: INSERT OR REPLACE INTO google_reviews with entry_source='sync'.
 *   - Run client name matching for new rows that have no matched_client_id yet.
 *   - Wire to "15 7 * * *" nightly cron — see dispatchCron in src/index.ts.
 */
export async function syncGbpReviews(
  env: Env,
  accountId: string,
  locationId: string,
): Promise<{ synced: number; errors: number }> {
  // TODO: wire to cron + flip GBP_REVIEWS_LIVE once GBP API access is approved.
  void env;
  void accountId;
  void locationId;
  void GBP_REVIEWS_PATH;
  void gbpStarToInt;
  return { synced: 0, errors: 0 };
}

/**
 * Phase B entry point: post a reply to a specific GBP review.
 *
 * TODO: implement when GBP API access is approved.
 *   - PUT accounts.locations.reviews.updateReply with { comment: replyText }.
 *   - Called from POST /api/google-reviews/:id/reply when gbp_reviews_live === true.
 *   - On success: update google_reviews SET reply_source='cms', reply_sent_at=now().
 *   - On failure: surface error to caller (never silent).
 */
export async function postGbpReply(
  env: Env,
  accountId: string,
  locationId: string,
  reviewId: string,
  replyText: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // TODO: wire to cron + flip GBP_REVIEWS_LIVE once GBP API access is approved.
  void env;
  void accountId;
  void locationId;
  void reviewId;
  void replyText;
  void GBP_REPLY_PATH;
  return { ok: false, error: "GBP API not yet activated — Phase B pending." };
}
