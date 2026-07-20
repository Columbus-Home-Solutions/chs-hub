/**
 * Google Business Profile — Reviews Sync + live reply (Phase B).
 *
 * Cron: folded into the existing every-30-min tick (runThirtyMinTick in src/index.ts).
 * Do NOT wire to the nightly "15 7" slot — that comment in the Phase A stub was stale.
 *
 * Reviews API (v4):
 *   GET  https://mybusiness.googleapis.com/v4/{locationName}/reviews
 *   PUT  https://mybusiness.googleapis.com/v4/{locationName}/reviews/{reviewId}/reply
 *
 * locationName is the full resource, e.g. accounts/123/locations/456.
 */

import type { Env } from "../env.js";
import {
  GbpNotConnectedError,
  GbpReconnectError,
  getValidGbpAccessToken,
  loadGbpConnection,
  markGbpSynced,
  setGbpError,
  type GbpConfiguration,
} from "./gbp-auth.js";
import { recordDeadLetter } from "./ops/dlq.js";

const GBP_V4_BASE = "https://mybusiness.googleapis.com/v4";

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
  name: string;
}

function gbpStarToInt(star: GbpReview["starRating"]): number {
  return { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[star] ?? 3;
}

async function isGbpLive(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = 'gbp_reviews_live'",
  ).first<{ value: string }>();
  return row?.value === "true" || row?.value === "1";
}

async function matchReviewerToClient(
  env: Env,
  reviewerName: string,
): Promise<{ id: string; confidence: "suggested" } | null> {
  if (!reviewerName.trim()) return null;

  const exact = await env.DB.prepare(
    `SELECT id FROM clients
     WHERE LOWER(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) = LOWER(TRIM(?))
        OR LOWER(TRIM(COALESCE(name, ''))) = LOWER(TRIM(?))
     LIMIT 1`,
  )
    .bind(reviewerName, reviewerName)
    .first<{ id: string }>();
  if (exact) return { id: exact.id, confidence: "suggested" };

  const parts = reviewerName.trim().split(/\s+/);
  if (parts.length >= 2) {
    const lastName = parts[parts.length - 1];
    const partial = await env.DB.prepare(
      `SELECT id FROM clients WHERE LOWER(COALESCE(last_name, '')) = LOWER(?) LIMIT 1`,
    )
      .bind(lastName)
      .first<{ id: string }>();
    if (partial) return { id: partial.id, confidence: "suggested" };
  }
  return null;
}

function locationNameFromConn(configuration: GbpConfiguration): string | null {
  return configuration.location_name?.trim() || null;
}

/**
 * Pull reviews from GBP and upsert into google_reviews.
 * Skips when gbp_reviews_live is false or GBP is not connected.
 */
export async function syncGbpReviews(env: Env): Promise<{
  synced: number;
  updated: number;
  reconciled: number;
  errors: number;
  skipped?: string;
}> {
  if (!(await isGbpLive(env))) {
    return { synced: 0, updated: 0, reconciled: 0, errors: 0, skipped: "gbp_reviews_live=false" };
  }

  const conn = await loadGbpConnection(env);
  if (!conn || conn.status === "disconnected") {
    return { synced: 0, updated: 0, reconciled: 0, errors: 0, skipped: "not_connected" };
  }

  let locationName = locationNameFromConn(conn.configuration);
  if (!locationName) {
    await setGbpError(env, "No GBP location configured — reconnect Google Business Profile.");
    return { synced: 0, updated: 0, reconciled: 0, errors: 1, skipped: "no_location" };
  }

  let token: string;
  try {
    token = await getValidGbpAccessToken(env);
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof GbpReconnectError || err instanceof GbpNotConnectedError) {
      await setGbpError(env, msg);
    }
    throw err;
  }

  let synced = 0;
  let updated = 0;
  let reconciled = 0;
  let errors = 0;
  let pageToken: string | undefined;

  try {
    do {
      const url = new URL(`${GBP_V4_BASE}/${locationName}/reviews`);
      url.searchParams.set("pageSize", "50");
      url.searchParams.set("orderBy", "updateTime desc");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const resp = await fetch(url.toString(), {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`reviews.list failed (${resp.status}): ${text.slice(0, 500)}`);
      }

      const data = (await resp.json()) as {
        reviews?: GbpReview[];
        nextPageToken?: string;
      };

      for (const review of data.reviews ?? []) {
        try {
          const result = await upsertGbpReview(env, review);
          if (result === "inserted") synced += 1;
          else if (result === "reconciled") reconciled += 1;
          else updated += 1;
        } catch (err) {
          errors += 1;
          console.error("[gbp_reviews_sync] upsert failed:", (err as Error).message, review.reviewId);
        }
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    await markGbpSynced(env);
  } catch (err) {
    const message = (err as Error).message;
    await setGbpError(env, message);
    await recordDeadLetter(env, {
      jobName: "gbp_reviews_sync",
      entityType: "google_review",
      entityId: locationName,
      payload: { locationName },
      errorMessage: message,
    });
    throw err;
  }

  return { synced, updated, reconciled, errors };
}

type UpsertResult = "inserted" | "updated" | "reconciled";

async function upsertGbpReview(env: Env, review: GbpReview): Promise<UpsertResult> {
  const googleReviewId = review.reviewId;
  const reviewerName = review.reviewer?.displayName?.trim() || "Anonymous";
  const starRating = gbpStarToInt(review.starRating);
  const commentText = review.comment ?? null;
  const reviewCreatedAt = review.createTime;
  const reviewUpdatedAt = review.updateTime;
  const photoUrl = review.reviewer?.profilePhotoUrl ?? null;
  const externalReply = review.reviewReply?.comment?.trim() || null;
  const externalReplyAt = review.reviewReply?.updateTime ?? null;

  const existing = await env.DB.prepare(
    "SELECT * FROM google_reviews WHERE google_review_id = ?",
  )
    .bind(googleReviewId)
    .first<{
      id: string;
      reply_text: string | null;
      reply_source: string | null;
      matched_client_id: string | null;
      match_confidence: string | null;
    }>();

  if (existing) {
    // Preserve CMS replies; pull external replies when we have none locally.
    let replyText = existing.reply_text;
    let replySource = existing.reply_source;
    let replySentAt: string | null = null;

    if (externalReply && !existing.reply_text) {
      replyText = externalReply;
      replySource = "external";
      replySentAt = externalReplyAt;
    } else if (
      externalReply &&
      existing.reply_source === "external" &&
      existing.reply_text !== externalReply
    ) {
      replyText = externalReply;
      replySource = "external";
      replySentAt = externalReplyAt;
    }

    await env.DB.prepare(
      `UPDATE google_reviews SET
         reviewer_name = ?,
         reviewer_photo_url = COALESCE(?, reviewer_photo_url),
         star_rating = ?,
         comment_text = ?,
         review_created_at = ?,
         review_updated_at = ?,
         reply_text = COALESCE(?, reply_text),
         reply_source = COALESCE(?, reply_source),
         reply_sent_at = CASE WHEN ? IS NOT NULL THEN ? ELSE reply_sent_at END,
         entry_source = 'sync',
         synced_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(
        reviewerName,
        photoUrl,
        starRating,
        commentText,
        reviewCreatedAt,
        reviewUpdatedAt,
        replyText,
        replySource,
        replySentAt,
        replySentAt,
        existing.id,
      )
      .run();
    return "updated";
  }

  // Reconcile Phase A manual rows: same reviewer + star + same calendar day, no google id.
  const createdDay = reviewCreatedAt.slice(0, 10);
  const manual = await env.DB.prepare(
    `SELECT id, reply_text, reply_source, matched_client_id, match_confidence
       FROM google_reviews
      WHERE google_review_id IS NULL
        AND entry_source = 'manual'
        AND LOWER(TRIM(reviewer_name)) = LOWER(TRIM(?))
        AND star_rating = ?
        AND substr(review_created_at, 1, 10) = ?
      LIMIT 1`,
  )
    .bind(reviewerName, starRating, createdDay)
    .first<{
      id: string;
      reply_text: string | null;
      reply_source: string | null;
      matched_client_id: string | null;
      match_confidence: string | null;
    }>();

  if (manual) {
    let replyText = manual.reply_text;
    let replySource = manual.reply_source;
    let replySentAt: string | null = null;
    if (externalReply && !manual.reply_text) {
      replyText = externalReply;
      replySource = "external";
      replySentAt = externalReplyAt;
    }

    await env.DB.prepare(
      `UPDATE google_reviews SET
         google_review_id = ?,
         reviewer_photo_url = COALESCE(?, reviewer_photo_url),
         comment_text = COALESCE(?, comment_text),
         review_created_at = ?,
         review_updated_at = ?,
         reply_text = COALESCE(?, reply_text),
         reply_source = COALESCE(?, reply_source),
         reply_sent_at = CASE WHEN ? IS NOT NULL THEN ? ELSE reply_sent_at END,
         entry_source = 'sync',
         synced_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(
        googleReviewId,
        photoUrl,
        commentText,
        reviewCreatedAt,
        reviewUpdatedAt,
        replyText,
        replySource,
        replySentAt,
        replySentAt,
        manual.id,
      )
      .run();
    return "reconciled";
  }

  // New sync row — client-match suggestion only on insert.
  const match = await matchReviewerToClient(env, reviewerName);
  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO google_reviews (
       id, google_review_id, reviewer_name, reviewer_photo_url, star_rating,
       comment_text, review_created_at, review_updated_at,
       reply_text, reply_sent_at, reply_source,
       matched_client_id, match_confidence,
       entry_source, synced_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sync', datetime('now'), datetime('now'))`,
  )
    .bind(
      id,
      googleReviewId,
      reviewerName,
      photoUrl,
      starRating,
      commentText,
      reviewCreatedAt,
      reviewUpdatedAt,
      externalReply,
      externalReply ? externalReplyAt : null,
      externalReply ? "external" : null,
      match?.id ?? null,
      match?.confidence ?? null,
    )
    .run();

  return "inserted";
}

/**
 * Post a reply to Google. Caller must update local DB only after ok: true.
 */
export async function postGbpReply(
  env: Env,
  googleReviewId: string,
  replyText: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const conn = await loadGbpConnection(env);
  const locationName = conn ? locationNameFromConn(conn.configuration) : null;
  if (!locationName) {
    return { ok: false, error: "Google Business Profile location is not configured. Reconnect in Settings → Integrations." };
  }

  let token: string;
  try {
    token = await getValidGbpAccessToken(env);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const url = `${GBP_V4_BASE}/${locationName}/reviews/${encodeURIComponent(googleReviewId)}/reply`;
  try {
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ comment: replyText }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return {
        ok: false,
        error: `Google reply failed (${resp.status}): ${text.slice(0, 400)}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Cron / manual entry point with isolation + DLQ already handled inside sync. */
export async function runGbpReviewsSyncTick(env: Env): Promise<void> {
  try {
    const result = await syncGbpReviews(env);
    if (result.skipped) {
      console.log(`[gbp_reviews_sync] skipped: ${result.skipped}`);
      return;
    }
    console.log(
      `[gbp_reviews_sync] synced=${result.synced} updated=${result.updated} reconciled=${result.reconciled} errors=${result.errors}`,
    );
  } catch (err) {
    // syncGbpReviews already DLQ'd; keep cron tick non-fatal.
    console.error(`[gbp_reviews_sync] failed:`, (err as Error).message);
  }
}
