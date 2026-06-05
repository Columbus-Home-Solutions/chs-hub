/**
 * Social publishing — state machine + Graph API path (Sprint 16, Deliverable F).
 *
 * SIMULATE this sprint. The real Facebook/Instagram Graph request shapes are
 * written and unit-tested, but only the exact env value SOCIAL_PUBLISH_MODE
 * (or the system_settings row) === "live" actually calls them. Anything else
 * simulates: synthetic post ids/urls, status='published', a [SIMULATE] log line.
 * No live social account is touched this sprint.
 *
 * The machine: approved → (due) → published | failed.
 *   - Per-platform branch on `platform` (both / facebook_only / instagram_only).
 *   - Instagram TWO-STEP: create a media container on Facebook's servers, then
 *     publish the container (IG cannot take a direct upload).
 *   - Idempotency: a `published` post is never re-published. Per-platform partial
 *     success is recorded on the post (facebook_post_id / instagram_post_id); on
 *     retry only the still-missing platform is attempted.
 *   - 3× retry with exponential backoff via the existing dead_letter_queue
 *     pattern (operation='social_publish'); after the 3rd failure the post goes
 *     status='failed' and the owner gets a SIMULATE in-app alert (business #6).
 *
 * Cron fold (NO new trigger — 5-cap full): publishDuePosts() is called from the
 * existing every-15-minute handler alongside the notification drain.
 */

import type { Env } from "../env.js";
import { createOwnerInApp } from "./notification-engine.js";
import {
  getSetting,
  logSocialAudit,
  parseJsonArray,
  SETTING_PUBLISH_MODE,
  type Platform,
  type SocialPostRow,
} from "./social.js";

export const MAX_PUBLISH_ATTEMPTS = 3;
// Exponential backoff between attempts: 1 min / 5 min / 30 min (mirrors the
// notification engine's backoff ladder).
export const PUBLISH_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

// ─── pure helpers (unit-tested) ────────────────────────────────────────────────

export type PublishMode = "live" | "simulate";

/** Only the exact value "live" goes live; everything else simulates. */
export function normalizePublishMode(value: string | null | undefined): PublishMode {
  return (value ?? "").trim().toLowerCase() === "live" ? "live" : "simulate";
}

export interface PlatformTargets {
  facebook: boolean;
  instagram: boolean;
}

export function platformTargets(platform: Platform | string): PlatformTargets {
  return {
    facebook: platform === "both" || platform === "facebook_only",
    instagram: platform === "both" || platform === "instagram_only",
  };
}

/** A post that's already `published` is terminal — never re-attempt it. */
export function canAttemptPublish(status: string): boolean {
  return status === "approved" || status === "failed" || status === "scheduled";
}

export function nextBackoffMs(attemptsSoFar: number): number {
  const idx = Math.min(attemptsSoFar, PUBLISH_BACKOFF_MS.length - 1);
  return PUBLISH_BACKOFF_MS[Math.max(0, idx)];
}

export interface PlatformOutcome {
  platform: "facebook" | "instagram";
  ok: boolean;
  postId?: string;
  url?: string;
  error?: string;
}

export interface OutcomeDecision {
  finalStatus: "published" | "approved" | "failed";
  dlqStatus: "resolved" | "pending" | "dismissed" | null;
  nextRetryAt: string | null;
  exhausted: boolean;
}

/**
 * Decide the post's next state from the attempt results + prior retry count.
 * Pure — the DB orchestration calls this then persists.
 */
export function decidePublishOutcome(
  outcomes: PlatformOutcome[],
  priorRetryCount: number,
  now: number = Date.now(),
): OutcomeDecision {
  const anyFailed = outcomes.some((o) => !o.ok);
  if (!anyFailed) {
    return { finalStatus: "published", dlqStatus: "resolved", nextRetryAt: null, exhausted: false };
  }
  const attemptsSoFar = priorRetryCount + 1;
  if (attemptsSoFar >= MAX_PUBLISH_ATTEMPTS) {
    return { finalStatus: "failed", dlqStatus: "dismissed", nextRetryAt: null, exhausted: true };
  }
  const nextRetryAt = new Date(now + nextBackoffMs(priorRetryCount)).toISOString();
  // Stay 'approved' so the cron picks it up again once the backoff window opens.
  return { finalStatus: "approved", dlqStatus: "pending", nextRetryAt, exhausted: false };
}

export function simulatedFacebook(postId: string): PlatformOutcome {
  const id = `SIMFB-${postId.slice(0, 8)}-${Date.now()}`;
  return { platform: "facebook", ok: true, postId: id, url: `https://www.facebook.com/${id}` };
}

export function simulatedInstagram(postId: string): PlatformOutcome {
  const id = `SIMIG-${postId.slice(0, 8)}-${Date.now()}`;
  return { platform: "instagram", ok: true, postId: id, url: `https://www.instagram.com/p/${id}` };
}

// Graph API request-shape builders (documented; exercised only when live).

export function buildFacebookPhotoRequest(args: {
  pageId: string;
  accessToken: string;
  imageUrl: string;
  caption: string;
}): { url: string; body: Record<string, unknown> } {
  return {
    url: `${GRAPH_BASE}/${args.pageId}/photos`,
    body: { url: args.imageUrl, caption: args.caption, access_token: args.accessToken },
  };
}

export function buildInstagramContainerRequest(args: {
  igAccountId: string;
  accessToken: string;
  imageUrl: string;
  caption: string;
}): { url: string; body: Record<string, unknown> } {
  return {
    url: `${GRAPH_BASE}/${args.igAccountId}/media`,
    body: { image_url: args.imageUrl, caption: args.caption, access_token: args.accessToken },
  };
}

export function buildInstagramPublishRequest(args: {
  igAccountId: string;
  accessToken: string;
  creationId: string;
}): { url: string; body: Record<string, unknown> } {
  return {
    url: `${GRAPH_BASE}/${args.igAccountId}/media_publish`,
    body: { creation_id: args.creationId, access_token: args.accessToken },
  };
}

/** Trim hashtags for the target network (stored set is the full Instagram-scale list). */
export function pickHashtagsForPlatform(tags: string[], platform: "facebook" | "instagram"): string[] {
  const clean = tags.filter(Boolean);
  if (platform === "facebook") return clean.slice(0, 5);
  return clean.slice(0, 15);
}

/** Compose the full caption (caption + hashtags) sent to the platforms. */
export function composePublishText(caption: string, hashtags: string[]): string {
  const tags = hashtags.filter(Boolean).join(" ");
  return tags ? `${caption}\n\n${tags}` : caption;
}

// ─── mode resolution (env → settings → default) ───────────────────────────────

export async function resolvePublishMode(env: Env): Promise<PublishMode> {
  const fromEnv = (env.SOCIAL_PUBLISH_MODE ?? "").trim();
  if (fromEnv) return normalizePublishMode(fromEnv);
  const fromSettings = await getSetting(env, SETTING_PUBLISH_MODE);
  return normalizePublishMode(fromSettings);
}

// ─── DLQ helpers (reuse dead_letter_queue, operation='social_publish') ────────

function dlqId(postId: string): string {
  return `splpub:${postId}`;
}

interface DlqRow {
  id: string;
  retry_count: number;
  status: string;
  next_retry_at: string | null;
}

async function loadDlq(env: Env, postId: string): Promise<DlqRow | null> {
  return env.DB.prepare(
    "SELECT id, retry_count, status, next_retry_at FROM dead_letter_queue WHERE id = ?",
  )
    .bind(dlqId(postId))
    .first<DlqRow>();
}

async function upsertDlq(
  env: Env,
  postId: string,
  retryCount: number,
  status: string,
  nextRetryAt: string | null,
  error: string,
): Promise<void> {
  const resolvedAt = status === "resolved" || status === "dismissed" ? new Date().toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO dead_letter_queue (id, operation, payload, error_message, retry_count, max_retries, status, next_retry_at, created_at, resolved_at)
     VALUES (?, 'social_publish', ?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(id) DO UPDATE SET
       payload = excluded.payload,
       error_message = excluded.error_message,
       retry_count = excluded.retry_count,
       status = excluded.status,
       next_retry_at = excluded.next_retry_at,
       resolved_at = excluded.resolved_at`,
  )
    .bind(
      dlqId(postId),
      JSON.stringify({ post_id: postId }),
      error.slice(0, 500),
      retryCount,
      MAX_PUBLISH_ATTEMPTS,
      status,
      nextRetryAt,
      resolvedAt,
    )
    .run();
}

// ─── per-platform attempts ─────────────────────────────────────────────────────

/** Origin for URLs Facebook/Instagram fetch (public host, not Access-gated dashboard). */
export function publicPublishOrigin(env: Env): string {
  return (env.APP_PUBLIC_ORIGIN ?? "https://client.homesolutionsar.com").replace(/\/$/, "");
}

/**
 * Absolute image URL for Graph API. Uses /api/public/* routes on APP_PUBLIC_ORIGIN
 * so Meta can fetch without Cloudflare Access.
 */
export function publicImageUrl(env: Env, post: SocialPostRow): string | null {
  const origin = publicPublishOrigin(env);
  if (post.ai_generated_image_url) {
    if (post.ai_generated_image_url.startsWith("http")) return post.ai_generated_image_url;
    if (
      post.ai_generated_image_url.includes("/social-posts/") &&
      post.ai_generated_image_url.endsWith("/image")
    ) {
      return `${origin}/api/public/social-posts/${post.id}/image`;
    }
    return `${origin}${post.ai_generated_image_url}`;
  }
  const photoIds = parseJsonArray(post.photo_ids);
  if (photoIds.length > 0) {
    return `${origin}/api/public/social/photos/${photoIds[photoIds.length - 1]}`;
  }
  return null;
}

async function attemptFacebook(
  env: Env,
  post: SocialPostRow,
  mode: PublishMode,
  text: string,
): Promise<PlatformOutcome> {
  if (mode !== "live") {
    console.log(`[social-publish] [SIMULATE] facebook post ${post.id}`);
    return simulatedFacebook(post.id);
  }
  const pageId = await getSetting(env, "social_facebook_page_id");
  const token = await getSetting(env, "social_facebook_page_token");
  console.log(
    `[social-publish] facebook credentials source=system_settings pageId=${pageId ? "set" : "missing"} token=${token ? "set" : "missing"}`,
  );
  const imageUrl = publicImageUrl(env, post);
  if (!pageId || !token || !imageUrl) {
    return { platform: "facebook", ok: false, error: "facebook_not_connected" };
  }
  try {
    const req = buildFacebookPhotoRequest({ pageId, accessToken: token, imageUrl, caption: text });
    const res = await fetch(req.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = (await res.json()) as {
      id?: string;
      post_id?: string;
      error?: { message?: string; code?: number };
    };
    if (!res.ok || data.error) {
      if (data.error?.code === 200) {
        return {
          platform: "facebook",
          ok: false,
          error:
            "Facebook publish failed: Page token is missing pages_manage_posts permission. " +
            "Regenerate the token with correct scopes and re-seed social_facebook_page_token.",
        };
      }
      return { platform: "facebook", ok: false, error: data.error?.message ?? `http_${res.status}` };
    }
    const id = data.post_id ?? data.id ?? "";
    return { platform: "facebook", ok: true, postId: id, url: `https://www.facebook.com/${id}` };
  } catch (e) {
    return { platform: "facebook", ok: false, error: (e as Error).message };
  }
}

async function attemptInstagram(
  env: Env,
  post: SocialPostRow,
  mode: PublishMode,
  text: string,
): Promise<PlatformOutcome> {
  if (mode !== "live") {
    console.log(`[social-publish] [SIMULATE] instagram (two-step) post ${post.id}`);
    return simulatedInstagram(post.id);
  }
  const igId = await getSetting(env, "social_instagram_account_id");
  const token = await getSetting(env, "social_facebook_page_token");
  console.log(
    `[social-publish] instagram credentials source=system_settings accountId=${igId ?? "missing"} token=${token ? "set" : "missing"}`,
  );
  const imageUrl = publicImageUrl(env, post);
  if (!igId || !token || !imageUrl) {
    return { platform: "instagram", ok: false, error: "instagram_not_connected" };
  }
  try {
    // Step 1: create the media container on Facebook's servers.
    const c = buildInstagramContainerRequest({ igAccountId: igId, accessToken: token, imageUrl, caption: text });
    const cRes = await fetch(c.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c.body),
    });
    const cData = (await cRes.json()) as { id?: string; error?: { message?: string; code?: number } };
    if (!cRes.ok || cData.error || !cData.id) {
      if (cData.error?.code === 10) {
        return {
          platform: "instagram",
          ok: false,
          error:
            "Instagram publish failed: app lacks permission (code 10). " +
            "Ensure the Page token includes pages_manage_posts and the IG account is linked.",
        };
      }
      return { platform: "instagram", ok: false, error: cData.error?.message ?? `container_http_${cRes.status}` };
    }
    // Step 2: publish the container (IG can't take a direct upload).
    const p = buildInstagramPublishRequest({ igAccountId: igId, accessToken: token, creationId: cData.id });
    const pRes = await fetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p.body),
    });
    const pData = (await pRes.json()) as { id?: string; error?: { message?: string } };
    if (!pRes.ok || pData.error || !pData.id) {
      return { platform: "instagram", ok: false, error: pData.error?.message ?? `publish_http_${pRes.status}` };
    }
    return {
      platform: "instagram",
      ok: true,
      postId: pData.id,
      url: `https://www.instagram.com/p/${pData.id}`,
    };
  } catch (e) {
    return { platform: "instagram", ok: false, error: (e as Error).message };
  }
}

// ─── orchestration ─────────────────────────────────────────────────────────────

export interface PublishResult {
  ok: boolean;
  status: string;
  reason?: string;
  outcomes?: PlatformOutcome[];
  mode?: PublishMode;
}

/**
 * Publish a single post. Used by the manual route AND the cron drain. Honors
 * idempotency (published → no-op), per-platform partial success, and the
 * 3×-backoff → failed + notify ladder.
 */
export async function publishPost(
  env: Env,
  postId: string,
  actor: string,
): Promise<PublishResult> {
  const post = await env.DB.prepare("SELECT * FROM social_posts WHERE id = ?")
    .bind(postId)
    .first<SocialPostRow>();
  if (!post) return { ok: false, status: "not_found", reason: "Post not found." };

  // Idempotency: a published post is NEVER re-published.
  if (post.status === "published") {
    return { ok: true, status: "published", reason: "already_published" };
  }
  if (!canAttemptPublish(post.status)) {
    return { ok: false, status: post.status, reason: "not_eligible" };
  }

  const mode = await resolvePublishMode(env);
  const targets = platformTargets(post.platform);
  const allTags = parseJsonArray(post.hashtags);

  // Per-platform idempotency: skip a platform already published.
  const needFb = targets.facebook && !post.facebook_post_id;
  const needIg = targets.instagram && !post.instagram_post_id;

  const outcomes: PlatformOutcome[] = [];
  if (needFb) {
    const text = composePublishText(
      post.caption,
      pickHashtagsForPlatform(allTags, "facebook"),
    );
    outcomes.push(await attemptFacebook(env, post, mode, text));
  }
  if (needIg) {
    const text = composePublishText(
      post.caption,
      pickHashtagsForPlatform(allTags, "instagram"),
    );
    outcomes.push(await attemptInstagram(env, post, mode, text));
  }

  // Persist each platform's success immediately (so a later retry skips it).
  for (const o of outcomes) {
    if (!o.ok) continue;
    if (o.platform === "facebook") {
      await env.DB.prepare(
        "UPDATE social_posts SET facebook_post_id = ?, facebook_url = ? WHERE id = ?",
      )
        .bind(o.postId ?? null, o.url ?? null, postId)
        .run();
    } else {
      await env.DB.prepare(
        "UPDATE social_posts SET instagram_post_id = ?, instagram_url = ? WHERE id = ?",
      )
        .bind(o.postId ?? null, o.url ?? null, postId)
        .run();
    }
  }

  const prior = await loadDlq(env, postId);
  const priorRetryCount = prior?.retry_count ?? 0;
  const decision = decidePublishOutcome(outcomes, priorRetryCount);
  const errorSummary = outcomes
    .filter((o) => !o.ok)
    .map((o) => `${o.platform}:${o.error}`)
    .join("; ");

  if (decision.finalStatus === "published") {
    await env.DB.prepare(
      "UPDATE social_posts SET status = 'published', published_date = datetime('now'), image_variation_index = 0 WHERE id = ?",
    )
      .bind(postId)
      .run();
    if (prior) await upsertDlq(env, postId, priorRetryCount, "resolved", null, "");
    await logSocialAudit(env, actor, "social_post_published", postId, {
      mode,
      platform: post.platform,
      outcomes,
    });
    return { ok: true, status: "published", outcomes, mode };
  }

  // Failure path: bump retry count, schedule backoff, or give up after 3.
  const nextRetryCount = priorRetryCount + 1;
  await upsertDlq(env, postId, nextRetryCount, decision.dlqStatus ?? "pending", decision.nextRetryAt, errorSummary);

  if (decision.exhausted) {
    await env.DB.prepare("UPDATE social_posts SET status = 'failed' WHERE id = ?")
      .bind(postId)
      .run();
    await logSocialAudit(env, actor, "social_post_failed", postId, {
      mode,
      attempts: nextRetryCount,
      error: errorSummary,
    });
    // SIMULATE owner alert (business rule #6).
    await createOwnerInApp(env, {
      message: `Social post failed to publish after ${MAX_PUBLISH_ATTEMPTS} attempts: ${errorSummary.slice(0, 160)}`,
      linkPath: "/app/social",
      dedupe: `social_publish_failed:${postId}`,
    });
    return { ok: false, status: "failed", reason: errorSummary, outcomes, mode };
  }

  await logSocialAudit(env, actor, "social_post_publish_retry", postId, {
    mode,
    attempt: nextRetryCount,
    next_retry_at: decision.nextRetryAt,
    error: errorSummary,
  });
  return { ok: false, status: "approved", reason: "retry_scheduled", outcomes, mode };
}

export interface PublishSweepStats {
  scanned: number;
  published: number;
  retried: number;
  failed: number;
  skipped_backoff: number;
  duration_ms: number;
}

/**
 * Cron drain: publish every approved post whose scheduled_date is due, honoring
 * any open backoff window. Folded into the existing 15-min handler (no new cron).
 */
export async function publishDuePosts(env: Env): Promise<PublishSweepStats> {
  const started = Date.now();
  const stats: PublishSweepStats = {
    scanned: 0,
    published: 0,
    retried: 0,
    failed: 0,
    skipped_backoff: 0,
    duration_ms: 0,
  };
  const now = new Date().toISOString();

  const { results } = await env.DB.prepare(
    `SELECT s.id, d.next_retry_at AS dlq_next, d.status AS dlq_status
       FROM social_posts s
       LEFT JOIN dead_letter_queue d
         ON d.id = 'splpub:' || s.id AND d.operation = 'social_publish'
      WHERE s.status = 'approved'
        AND s.scheduled_date IS NOT NULL
        AND s.scheduled_date <= ?
      ORDER BY s.scheduled_date ASC
      LIMIT 50`,
  )
    .bind(now)
    .all<{ id: string; dlq_next: string | null; dlq_status: string | null }>();

  for (const row of results ?? []) {
    stats.scanned++;
    // Respect an open backoff window.
    if (row.dlq_status === "pending" && row.dlq_next && row.dlq_next > now) {
      stats.skipped_backoff++;
      continue;
    }
    try {
      const r = await publishPost(env, row.id, "cron:social_publisher");
      if (r.status === "published") stats.published++;
      else if (r.status === "failed") stats.failed++;
      else stats.retried++;
    } catch (err) {
      console.error(`[social-publish] post ${row.id} threw:`, (err as Error).message);
    }
  }

  stats.duration_ms = Date.now() - started;
  return stats;
}
