/**
 * Google Reviews API — Sprint 36 Phase A.
 *
 * Routes (all under /api/google-reviews — NOT /api/reviews, which is saved_reviews):
 *   GET    /api/google-reviews                  list + filters
 *   GET    /api/google-reviews/stats            summary strip data
 *   POST   /api/google-reviews                  manually add a review (Phase A entry point)
 *   GET    /api/google-reviews/:id              single review detail
 *   POST   /api/google-reviews/:id/generate-response  AI draft reply (Claude)
 *   POST   /api/google-reviews/:id/reply        save reply locally (Phase A — no GBP call)
 *   PUT    /api/google-reviews/:id/match        confirm or dismiss client-match suggestion
 *   POST   /api/google-reviews/:id/feature      upsert into saved_reviews (feature on quote page)
 *
 * Phase B will extend /reply to actually call the GBP updateReply endpoint once
 * GBP_REVIEWS_LIVE is flipped to true. No changes to this file are needed for
 * the data model or the local-save path.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { claudeMessages } from "../lib/claude.js";
import { DEFAULT_BRAND_VOICE } from "../lib/social.js";

const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;

// ─── helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface ReviewRow {
  id: string;
  google_review_id: string | null;
  reviewer_name: string;
  reviewer_photo_url: string | null;
  star_rating: number;
  comment_text: string | null;
  review_created_at: string;
  review_updated_at: string | null;
  reply_text: string | null;
  reply_sent_at: string | null;
  reply_source: string | null;
  matched_client_id: string | null;
  match_confidence: string | null;
  entry_source: string;
  synced_at: string;
  created_at: string;
}

/** Attempt to find a client whose full name fuzzy-matches the reviewer_name. */
async function findClientMatch(
  env: Env,
  reviewerName: string,
): Promise<{ id: string; name: string } | null> {
  if (!reviewerName.trim()) return null;

  // Exact match on LOWER(first_name || ' ' || last_name).
  const exact = await env.DB.prepare(
    `SELECT id, COALESCE(first_name || ' ' || last_name, name) AS display_name
     FROM clients
     WHERE LOWER(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) = LOWER(TRIM(?))
        OR LOWER(TRIM(COALESCE(name, ''))) = LOWER(TRIM(?))
     LIMIT 1`,
  )
    .bind(reviewerName, reviewerName)
    .first<{ id: string; display_name: string }>();

  if (exact) return { id: exact.id, name: exact.display_name };

  // Partial: reviewer_name is contained in the client's name or vice-versa (last-name only).
  const parts = reviewerName.trim().split(/\s+/);
  if (parts.length >= 2) {
    const lastName = parts[parts.length - 1];
    const partial = await env.DB.prepare(
      `SELECT id, COALESCE(first_name || ' ' || last_name, name) AS display_name
       FROM clients
       WHERE LOWER(COALESCE(last_name, '')) = LOWER(?)
       LIMIT 1`,
    )
      .bind(lastName)
      .first<{ id: string; display_name: string }>();
    if (partial) return { id: partial.id, name: partial.display_name };
  }

  return null;
}

/** Read the GBP_REVIEWS_LIVE flag from system_settings. */
async function isGbpLive(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = 'gbp_reviews_live'",
  ).first<{ value: string }>();
  return row?.value === "true" || row?.value === "1";
}

// ─── GET /api/google-reviews ─────────────────────────────────────────────────

export async function handleGoogleReviewList(env: Env, url: URL): Promise<Response> {
  const filter = str(url.searchParams.get("filter")) ?? "all"; // all | unanswered
  const clientId = str(url.searchParams.get("client_id"));
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 500);

  const where: string[] = [];
  const binds: unknown[] = [];

  if (filter === "unanswered") {
    where.push("r.reply_text IS NULL");
  }
  if (clientId) {
    where.push("r.matched_client_id = ?");
    binds.push(clientId);
  }

  const sql = `
    SELECT r.*,
      c.first_name || ' ' || c.last_name AS matched_client_name,
      c.id AS matched_client_id_check
    FROM google_reviews r
    LEFT JOIN clients c ON c.id = r.matched_client_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY r.review_created_at DESC
    LIMIT ?`;

  const { results } = await env.DB.prepare(sql).bind(...binds, limit).all();

  const gbpLive = await isGbpLive(env);
  return json({ reviews: results ?? [], gbp_live: gbpLive });
}

// ─── GET /api/google-reviews/stats ───────────────────────────────────────────

export async function handleGoogleReviewStats(env: Env): Promise<Response> {
  const stats = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       ROUND(AVG(star_rating), 1) AS avg_rating,
       SUM(CASE WHEN reply_text IS NULL THEN 1 ELSE 0 END) AS unanswered,
       SUM(CASE WHEN star_rating >= 4 THEN 1 ELSE 0 END) AS positive,
       SUM(CASE WHEN star_rating <= 2 THEN 1 ELSE 0 END) AS critical
     FROM google_reviews`,
  ).first<{
    total: number;
    avg_rating: number | null;
    unanswered: number;
    positive: number;
    critical: number;
  }>();

  const gbpLive = await isGbpLive(env);

  return json({
    total: stats?.total ?? 0,
    avg_rating: stats?.avg_rating ?? null,
    unanswered: stats?.unanswered ?? 0,
    positive: stats?.positive ?? 0,
    critical: stats?.critical ?? 0,
    gbp_live: gbpLive,
  });
}

// ─── GET /api/google-reviews/:id ─────────────────────────────────────────────

export async function handleGoogleReviewGet(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM google_reviews WHERE id = ?")
    .bind(id)
    .first<ReviewRow>();
  if (!row) return err(404, "not_found", "Review not found");

  const gbpLive = await isGbpLive(env);
  return json({ review: row, gbp_live: gbpLive });
}

// ─── POST /api/google-reviews ─────────────────────────────────────────────────

export async function handleGoogleReviewCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const reviewerName = str(body.reviewer_name);
  const starRating = num(body.star_rating);
  const reviewCreatedAt = str(body.review_created_at) ?? new Date().toISOString().slice(0, 10);

  if (!reviewerName) return err(422, "validation_error", "reviewer_name is required");
  if (!starRating || starRating < 1 || starRating > 5) {
    return err(422, "validation_error", "star_rating must be between 1 and 5");
  }

  const id = crypto.randomUUID();

  // Attempt client name match on creation (suggestion only).
  const match = await findClientMatch(env, reviewerName);
  const matchedClientId = match?.id ?? null;
  const matchConfidence = match ? "suggested" : null;

  await env.DB.prepare(
    `INSERT INTO google_reviews (
       id, reviewer_name, star_rating, comment_text,
       review_created_at, matched_client_id, match_confidence,
       entry_source, synced_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', datetime('now'), datetime('now'))`,
  )
    .bind(id, reviewerName, starRating, str(body.comment_text), reviewCreatedAt, matchedClientId, matchConfidence)
    .run();

  const row = await env.DB.prepare("SELECT * FROM google_reviews WHERE id = ?").bind(id).first();
  return json({ review: row, matched_client: match }, { status: 201 });
}

// ─── POST /api/google-reviews/:id/generate-response ──────────────────────────

export async function handleGoogleReviewGenerateResponse(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const review = await env.DB.prepare("SELECT * FROM google_reviews WHERE id = ?")
    .bind(id)
    .first<ReviewRow>();
  if (!review) return err(404, "not_found", "Review not found");

  // Build the AI prompt using the brand voice system prompt (reusing Sprint 16 pattern).
  const systemPrompt =
    `${DEFAULT_BRAND_VOICE}\n\n` +
    "You are drafting a reply to a Google Business Profile review on behalf of Columbus Home Solutions. " +
    "Rules:\n" +
    "- Keep the reply under 150 words.\n" +
    "- Be warm, genuine, and professional — never defensive or sycophantic.\n" +
    "- Thank the reviewer by first name if you can infer it.\n" +
    "- For negative reviews (1–2 stars), acknowledge the concern, apologize sincerely, and invite them to contact us directly to resolve it.\n" +
    "- For positive reviews, express genuine gratitude and invite them back for future work.\n" +
    "- Never make up specific details not mentioned in the review.\n" +
    "Respond with ONLY the reply text — no JSON, no labels.";

  const stars = review.star_rating;
  const sentiment = stars >= 4 ? "positive" : stars === 3 ? "neutral" : "negative";
  const userPrompt = [
    `Review (${stars} stars, ${sentiment}):`,
    review.reviewer_name ? `Reviewer: ${review.reviewer_name}` : "",
    review.comment_text ? `"${review.comment_text}"` : "(No comment text — reviewer left stars only.)",
    "\nWrite a reply from Columbus Home Solutions.",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await claudeMessages(env, {
    model: "claude-sonnet-4-20250514",
    maxTokens: 300,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  if (!result.ok || !result.text) {
    return json({
      draft: null,
      error: result.error ?? "AI unavailable — write your reply manually.",
    });
  }

  return json({ draft: result.text.trim() });
}

// ─── POST /api/google-reviews/:id/reply ──────────────────────────────────────

export async function handleGoogleReviewReply(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const review = await env.DB.prepare("SELECT id FROM google_reviews WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!review) return err(404, "not_found", "Review not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const replyText = str(body.reply_text);
  if (!replyText) return err(422, "validation_error", "reply_text is required");

  // Phase A: always save locally. Phase B will add the GBP API call here when
  // GBP_REVIEWS_LIVE is true.
  await env.DB.prepare(
    "UPDATE google_reviews SET reply_text = ?, reply_sent_at = datetime('now'), reply_source = 'cms' WHERE id = ?",
  )
    .bind(replyText, id)
    .run();

  const gbpLive = await isGbpLive(env);
  const row = await env.DB.prepare("SELECT * FROM google_reviews WHERE id = ?").bind(id).first();

  return json({
    review: row,
    // This flag drives the "not yet posted to Google" banner in the UI.
    posted_to_google: gbpLive,
    gbp_live: gbpLive,
  });
}

// ─── PUT /api/google-reviews/:id/match ───────────────────────────────────────

export async function handleGoogleReviewMatch(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const review = await env.DB.prepare("SELECT id FROM google_reviews WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!review) return err(404, "not_found", "Review not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const action = str(body.action); // 'confirm' | 'dismiss'
  const clientId = str(body.client_id);

  if (action === "confirm") {
    if (!clientId) return err(422, "validation_error", "client_id required to confirm a match");
    const client = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(clientId).first();
    if (!client) return err(404, "not_found", "Client not found");

    await env.DB.prepare(
      "UPDATE google_reviews SET matched_client_id = ?, match_confidence = 'confirmed' WHERE id = ?",
    )
      .bind(clientId, id)
      .run();
  } else if (action === "dismiss") {
    // Clear the match entirely — do not re-suggest for this review.
    await env.DB.prepare(
      "UPDATE google_reviews SET matched_client_id = NULL, match_confidence = NULL WHERE id = ?",
    )
      .bind(id)
      .run();
  } else {
    return err(422, "validation_error", "action must be 'confirm' or 'dismiss'");
  }

  const row = await env.DB.prepare("SELECT * FROM google_reviews WHERE id = ?").bind(id).first();
  return json({ review: row });
}

// ─── POST /api/google-reviews/:id/feature ────────────────────────────────────
// Toggle "Feature on quote page" — upserts into saved_reviews.

export async function handleGoogleReviewFeature(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const review = await env.DB.prepare("SELECT * FROM google_reviews WHERE id = ?")
    .bind(id)
    .first<ReviewRow>();
  if (!review) return err(404, "not_found", "Review not found");

  const body = await readJson(request);
  const featured = body?.featured !== false; // default true (enable)

  if (featured) {
    // Check if already in saved_reviews (by google_review_id or by this review id).
    const savedId = `gr-${id}`;
    const existing = await env.DB.prepare("SELECT id FROM saved_reviews WHERE id = ?")
      .bind(savedId)
      .first<{ id: string }>();

    if (existing) {
      await env.DB.prepare("UPDATE saved_reviews SET is_active = 1, updated_at = datetime('now') WHERE id = ?")
        .bind(savedId)
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO saved_reviews (id, reviewer_name, review_date, rating, review_text, source, is_active, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, 'google', 1, NULL, datetime('now'))`,
      )
        .bind(
          savedId,
          review.reviewer_name,
          review.review_created_at,
          review.star_rating,
          review.comment_text ?? "",
        )
        .run();
    }

    return json({ featured: true, saved_review_id: savedId });
  } else {
    // Un-feature: mark inactive in saved_reviews (don't delete — preserves history).
    const savedId = `gr-${id}`;
    await env.DB.prepare("UPDATE saved_reviews SET is_active = 0 WHERE id = ?").bind(savedId).run();
    return json({ featured: false });
  }
}
