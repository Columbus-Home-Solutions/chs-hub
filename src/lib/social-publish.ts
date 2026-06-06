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
 *   - All live publishing goes through the Instagram Graph API (two-step container
 *     + media_publish). Facebook delivery uses `also_share_to_facebook` on the
 *     IG container — no direct Pages `/photos` call (avoids pages_manage_posts).
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
  resolveInstagramAccessToken,
  SETTING_IG_ACCOUNT_ID,
  SETTING_PUBLISH_MODE,
  type Platform,
  type SocialPostRow,
} from "./social.js";

/** CHS Instagram Business Account — used when social_instagram_account_id is unset. */
export const DEFAULT_IG_BUSINESS_ACCOUNT_ID = "17841451185371306";

export const MAX_PUBLISH_ATTEMPTS = 3;
// Exponential backoff between attempts: 1 min / 5 min / 30 min (mirrors the
// notification engine's backoff ladder).
export const PUBLISH_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];

const INSTAGRAM_GRAPH_BASE = "https://graph.instagram.com/v25.0";
/** Legacy Facebook Graph host — only used by deprecated Page /photos helper. */
const FACEBOOK_GRAPH_BASE = "https://graph.facebook.com/v21.0";

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

export interface InstagramPublishResult {
  ok: boolean;
  instagramPostId?: string;
  instagramUrl?: string;
  facebookPostId?: string;
  facebookUrl?: string;
  error?: string;
}

/** Simulated IG publish; when cross-posting, also returns a synthetic FB id. */
export function simulatedInstagramPublish(
  postId: string,
  shareToFacebook: boolean,
): InstagramPublishResult {
  const stamp = Date.now();
  const igId = `SIMIG-${postId.slice(0, 8)}-${stamp}`;
  const fbId = shareToFacebook ? `SIMFB-${postId.slice(0, 8)}-${stamp}` : undefined;
  return {
    ok: true,
    instagramPostId: igId,
    instagramUrl: `https://www.instagram.com/p/${igId}`,
    facebookPostId: fbId,
    facebookUrl: fbId ? `https://www.facebook.com/${fbId}` : undefined,
  };
}

/** Extract IG + FB ids from a Graph media_publish (or follow-up GET) payload. */
export function parseInstagramPublishResponse(data: Record<string, unknown>): {
  instagramPostId: string | null;
  facebookPostId: string | null;
} {
  const instagramPostId =
    (typeof data.id === "string" && data.id) ||
    (typeof data.ig_media_id === "string" && data.ig_media_id) ||
    null;
  let facebookPostId =
    (typeof data.facebook_post_id === "string" && data.facebook_post_id) ||
    (typeof data.fb_post_id === "string" && data.fb_post_id) ||
    (typeof data.post_id_on_facebook === "string" && data.post_id_on_facebook) ||
    (typeof data.crossposted_facebook_post_id === "string" && data.crossposted_facebook_post_id) ||
    null;
  if (!facebookPostId) {
    const shares = data.shares as { data?: Array<{ id?: string }> } | undefined;
    const shareId = shares?.data?.[0]?.id;
    if (typeof shareId === "string" && shareId.trim()) {
      facebookPostId = shareId.trim();
    }
  }
  return { instagramPostId, facebookPostId };
}

// Graph API request-shape builders (documented; exercised only when live).

/** @deprecated Direct Page /photos publish removed — use Instagram cross-post instead. */
export function buildFacebookPhotoRequest(args: {
  pageId: string;
  accessToken: string;
  imageUrl: string;
  caption: string;
}): { url: string; body: Record<string, unknown> } {
  return {
    url: `${FACEBOOK_GRAPH_BASE}/${args.pageId}/photos`,
    body: { url: args.imageUrl, caption: args.caption, access_token: args.accessToken },
  };
}

export function buildInstagramContainerRequest(args: {
  igAccountId: string;
  accessToken: string;
  imageUrl: string;
  caption: string;
  alsoShareToFacebook?: boolean;
}): { url: string; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {
    image_url: args.imageUrl,
    caption: args.caption,
    access_token: args.accessToken,
  };
  if (args.alsoShareToFacebook) {
    body.also_share_to_facebook = true;
  }
  return {
    url: `${INSTAGRAM_GRAPH_BASE}/${args.igAccountId}/media`,
    body,
  };
}

export function buildInstagramPublishRequest(args: {
  igAccountId: string;
  accessToken: string;
  creationId: string;
}): { url: string; body: Record<string, unknown> } {
  return {
    url: `${INSTAGRAM_GRAPH_BASE}/${args.igAccountId}/media_publish`,
    body: { creation_id: args.creationId, access_token: args.accessToken },
  };
}

/** GET URL to resolve a Facebook cross-post id from a published IG media id. */
export function buildInstagramMediaLookupUrl(args: {
  instagramPostId: string;
  accessToken: string;
}): string {
  const params = new URLSearchParams({
    fields: "id,timestamp,permalink,shares",
    access_token: args.accessToken,
  });
  return `${INSTAGRAM_GRAPH_BASE}/${args.instagramPostId}?${params.toString()}`;
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

/** Normalize legacy `YYYY-MM-DD HH:MM:SS` rows to ISO for reliable string compare. */
export function scheduledDateForCompare(scheduledDate: string): string {
  const s = scheduledDate.trim();
  if (s.includes("T")) return s;
  return `${s.replace(" ", "T")}Z`;
}

export function isScheduledDateDue(scheduledDate: string, nowIso: string): boolean {
  return scheduledDateForCompare(scheduledDate) <= nowIso;
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

async function recordPublishError(env: Env, postId: string, error: string): Promise<void> {
  const msg = error.trim().slice(0, 2000);
  if (!msg) return;
  await env.DB.prepare("UPDATE social_posts SET rejection_reason = ? WHERE id = ?")
    .bind(msg, postId)
    .run();
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

async function resolveInstagramAccountId(env: Env): Promise<string> {
  const configured = (await getSetting(env, SETTING_IG_ACCOUNT_ID))?.trim();
  return configured || DEFAULT_IG_BUSINESS_ACCOUNT_ID;
}

async function fetchFacebookCrosspostId(
  igMediaId: string,
  accessToken: string,
  postId?: string,
): Promise<string | null> {
  const url = buildInstagramMediaLookupUrl({ instagramPostId: igMediaId, accessToken });
  const res = await fetch(url);
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    console.warn(
      `[social-publish] facebook cross-post lookup invalid json post=${postId ?? igMediaId} instagram=${igMediaId}`,
    );
    return null;
  }
  if (!res.ok) {
    console.warn(
      `[social-publish] facebook cross-post lookup failed post=${postId ?? igMediaId} http=${res.status} response=${JSON.stringify(redactForLog(data))}`,
    );
    return null;
  }
  const fbId = parseInstagramPublishResponse(data).facebookPostId;
  if (!fbId) {
    console.warn(
      `[social-publish] facebook cross-post id missing post=${postId ?? igMediaId} instagram=${igMediaId} response=${JSON.stringify(redactForLog(data))}`,
    );
  }
  return fbId;
}

/** Strip tokens before logging Graph API payloads. */
function redactForLog(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactForLog);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = k === "access_token" ? "[REDACTED]" : redactForLog(v);
  }
  return out;
}

function logInstagramGraphFailure(
  stage: "container" | "publish",
  postId: string,
  httpStatus: number,
  data: unknown,
): void {
  console.error(
    `[social-publish] instagram ${stage} failed post=${postId} http=${httpStatus} response=${JSON.stringify(redactForLog(data))}`,
  );
}

/**
 * Publish via Instagram Graph API. When shareToFacebook is true, sets
 * also_share_to_facebook on the container so Meta cross-posts to the linked Page.
 */
async function attemptInstagramPublish(
  env: Env,
  post: SocialPostRow,
  mode: PublishMode,
  text: string,
  shareToFacebook: boolean,
): Promise<InstagramPublishResult> {
  if (mode !== "live") {
    console.log(
      `[social-publish] [SIMULATE] instagram post ${post.id}` +
        (shareToFacebook ? " + facebook cross-post" : ""),
    );
    return simulatedInstagramPublish(post.id, shareToFacebook);
  }

  const igId = await resolveInstagramAccountId(env);
  const token = await resolveInstagramAccessToken(env);
  const imageUrl = publicImageUrl(env, post);
  console.log(
    `[social-publish] instagram publish accountId=${igId} token=${token ? "set" : "missing"} crosspost_fb=${shareToFacebook}`,
  );
  if (!token || !imageUrl) {
    return { ok: false, error: "instagram_not_connected" };
  }

  try {
    const c = buildInstagramContainerRequest({
      igAccountId: igId,
      accessToken: token,
      imageUrl,
      caption: text,
      alsoShareToFacebook: shareToFacebook,
    });
    const cRes = await fetch(c.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c.body),
    });
    const cData = (await cRes.json()) as { id?: string; error?: { message?: string; code?: number } };
    if (!cRes.ok || cData.error || !cData.id) {
      logInstagramGraphFailure("container", post.id, cRes.status, cData);
      return {
        ok: false,
        error: cData.error?.message ?? `container_http_${cRes.status}`,
      };
    }

    const p = buildInstagramPublishRequest({ igAccountId: igId, accessToken: token, creationId: cData.id });
    const pRes = await fetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p.body),
    });
    const pData = (await pRes.json()) as Record<string, unknown> & {
      error?: { message?: string };
    };
    if (!pRes.ok || pData.error) {
      logInstagramGraphFailure("publish", post.id, pRes.status, pData);
      const err = pData.error as { message?: string } | undefined;
      return { ok: false, error: err?.message ?? `publish_http_${pRes.status}` };
    }

    let { instagramPostId, facebookPostId } = parseInstagramPublishResponse(pData);
    if (!instagramPostId) {
      logInstagramGraphFailure("publish", post.id, pRes.status, pData);
      return { ok: false, error: "publish_missing_instagram_id" };
    }

    if (shareToFacebook && !facebookPostId) {
      facebookPostId = await fetchFacebookCrosspostId(instagramPostId, token, post.id);
    }

    if (shareToFacebook && instagramPostId && !facebookPostId) {
      console.warn(
        `[social-publish] instagram published but facebook cross-post id unavailable post=${post.id} instagram=${instagramPostId}`,
      );
    }

    return {
      ok: true,
      instagramPostId,
      instagramUrl: `https://www.instagram.com/p/${instagramPostId}`,
      facebookPostId: facebookPostId ?? undefined,
      facebookUrl: facebookPostId ? `https://www.facebook.com/${facebookPostId}` : undefined,
    };
  } catch (e) {
    console.error(
      `[social-publish] instagram publish exception post=${post.id}:`,
      (e as Error).message,
      (e as Error).stack,
    );
    return { ok: false, error: (e as Error).message };
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

  // Per-platform idempotency: skip platforms already published.
  const needIg = targets.instagram && !post.instagram_post_id;
  const needFb = targets.facebook && !post.facebook_post_id;

  const outcomes: PlatformOutcome[] = [];
  let instagramPublishSucceeded = !!post.instagram_post_id;
  if (needIg || (needFb && !post.instagram_post_id)) {
    // All live paths go through Instagram; Facebook delivery is IG cross-post.
    const shareToFacebook = needFb;
    const hashtagPlatform: "facebook" | "instagram" =
      targets.instagram ? "instagram" : "facebook";
    const text = composePublishText(
      post.caption,
      pickHashtagsForPlatform(allTags, hashtagPlatform),
    );
    const result = await attemptInstagramPublish(env, post, mode, text, shareToFacebook);

    if (!result.ok) {
      if (needIg) outcomes.push({ platform: "instagram", ok: false, error: result.error });
      if (needFb) outcomes.push({ platform: "facebook", ok: false, error: result.error });
    } else {
      // Persist IG id whenever returned (idempotency + FB cross-post recovery).
      if (result.instagramPostId) {
        instagramPublishSucceeded = true;
        await env.DB.prepare(
          "UPDATE social_posts SET instagram_post_id = ?, instagram_url = ? WHERE id = ?",
        )
          .bind(result.instagramPostId, result.instagramUrl ?? null, postId)
          .run();
      }
      if (needIg && result.instagramPostId) {
        outcomes.push({
          platform: "instagram",
          ok: true,
          postId: result.instagramPostId,
          url: result.instagramUrl,
        });
      } else if (needIg) {
        outcomes.push({ platform: "instagram", ok: false, error: "publish_missing_instagram_id" });
      }
      if (needFb) {
        if (result.facebookPostId) {
          outcomes.push({
            platform: "facebook",
            ok: true,
            postId: result.facebookPostId,
            url: result.facebookUrl,
          });
        } else if (result.instagramPostId) {
          // IG publish succeeded — missing FB cross-post id is non-blocking.
          console.warn(
            `[social-publish] marking published without facebook_post_id post=${postId} instagram=${result.instagramPostId}`,
          );
        }
      }
    }
  } else if (needFb && post.instagram_post_id) {
    // IG already published — try once to recover the Facebook cross-post id.
    if (mode !== "live") {
      const sim = simulatedInstagramPublish(post.id, true);
      outcomes.push({
        platform: "facebook",
        ok: true,
        postId: sim.facebookPostId,
        url: sim.facebookUrl,
      });
    } else {
      const token = await resolveInstagramAccessToken(env);
      if (!token) {
        console.warn(
          `[social-publish] marking published without facebook_post_id (no token) post=${postId} instagram=${post.instagram_post_id}`,
        );
      } else {
        const fbId = await fetchFacebookCrosspostId(post.instagram_post_id, token, postId);
        if (fbId) {
          outcomes.push({
            platform: "facebook",
            ok: true,
            postId: fbId,
            url: `https://www.facebook.com/${fbId}`,
          });
        } else {
          console.warn(
            `[social-publish] marking published without facebook_post_id post=${postId} instagram=${post.instagram_post_id}`,
          );
        }
      }
    }
  }

  // When IG publish succeeded, missing FB cross-post id must not block completion.
  const blockingFailures = outcomes.filter(
    (o) => !o.ok && !(o.platform === "facebook" && instagramPublishSucceeded),
  );

  // Persist each platform's success immediately (so a later retry skips it).
  for (const o of outcomes) {
    if (!o.ok) continue;
    if (o.platform === "facebook") {
      await env.DB.prepare(
        "UPDATE social_posts SET facebook_post_id = ?, facebook_url = ? WHERE id = ?",
      )
        .bind(o.postId ?? null, o.url ?? null, postId)
        .run();
    } else if (needIg) {
      // IG id may already be persisted above when facebook_only cross-posted first.
      await env.DB.prepare(
        "UPDATE social_posts SET instagram_post_id = ?, instagram_url = ? WHERE id = ?",
      )
        .bind(o.postId ?? null, o.url ?? null, postId)
        .run();
    }
  }

  const prior = await loadDlq(env, postId);
  const priorRetryCount = prior?.retry_count ?? 0;
  const decision = decidePublishOutcome(blockingFailures, priorRetryCount);
  const errorSummary = blockingFailures
    .map((o) => `${o.platform}:${o.error}`)
    .join("; ");

  if (decision.finalStatus === "published") {
    await env.DB.prepare(
      `UPDATE social_posts SET status = 'published', published_date = datetime('now'),
              image_variation_index = 0, rejection_reason = NULL WHERE id = ?`,
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
    await env.DB.prepare(
      "UPDATE social_posts SET status = 'failed', rejection_reason = ? WHERE id = ?",
    )
      .bind(errorSummary.slice(0, 2000) || "Publish failed after max retries.", postId)
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

  await recordPublishError(env, postId, errorSummary);
  await logSocialAudit(env, actor, "social_post_publish_retry", postId, {
    mode,
    attempt: nextRetryCount,
    next_retry_at: decision.nextRetryAt,
    error: errorSummary,
  });
  return { ok: false, status: "approved", reason: "retry_scheduled", outcomes, mode };
}

export interface PublishSweepStats {
  eligible: number;
  scanned: number;
  published: number;
  retried: number;
  failed: number;
  skipped_backoff: number;
  duration_ms: number;
}

/**
 * SQL expression: compare scheduled_date to now regardless of legacy
 * `YYYY-MM-DD HH:MM:SS` vs ISO `...T...Z` storage formats.
 */
const SCHEDULED_DATE_COMPARE_SQL = `
  CASE WHEN instr(s.scheduled_date, 'T') > 0
       THEN s.scheduled_date
       ELSE replace(s.scheduled_date, ' ', 'T') || 'Z'
  END`;

/**
 * Cron drain: publish every approved post whose scheduled_date is due, honoring
 * any open backoff window. Folded into the existing 15-min handler (no new cron).
 */
export async function publishDuePosts(env: Env): Promise<PublishSweepStats> {
  const started = Date.now();
  const stats: PublishSweepStats = {
    eligible: 0,
    scanned: 0,
    published: 0,
    retried: 0,
    failed: 0,
    skipped_backoff: 0,
    duration_ms: 0,
  };
  const now = new Date().toISOString();
  const mode = await resolvePublishMode(env);

  const { results } = await env.DB.prepare(
    `SELECT s.id, s.scheduled_date, d.next_retry_at AS dlq_next, d.status AS dlq_status,
            d.error_message AS dlq_error
       FROM social_posts s
       LEFT JOIN dead_letter_queue d
         ON d.id = 'splpub:' || s.id AND d.operation = 'social_publish'
      WHERE s.status = 'approved'
        AND s.scheduled_date IS NOT NULL
        AND (${SCHEDULED_DATE_COMPARE_SQL}) <= ?
      ORDER BY s.scheduled_date ASC
      LIMIT 50`,
  )
    .bind(now)
    .all<{
      id: string;
      scheduled_date: string;
      dlq_next: string | null;
      dlq_status: string | null;
      dlq_error: string | null;
    }>();

  const rows = results ?? [];
  stats.eligible = rows.length;
  console.log(
    `[social-publish] cron start: eligible=${stats.eligible} now=${now} mode=${mode}` +
      (stats.eligible === 0 ? "" : ` ids=[${rows.map((r) => r.id.slice(0, 8)).join(",")}]`),
  );

  for (const row of rows) {
    // Respect an open backoff window.
    if (row.dlq_status === "pending" && row.dlq_next && row.dlq_next > now) {
      stats.skipped_backoff++;
      console.log(
        `[social-publish] skip backoff post=${row.id} scheduled=${row.scheduled_date} until=${row.dlq_next}` +
          (row.dlq_error ? ` last_error=${row.dlq_error.slice(0, 120)}` : ""),
      );
      continue;
    }
    stats.scanned++;
    try {
      const r = await publishPost(env, row.id, "cron:social_publisher");
      if (r.status === "published") stats.published++;
      else if (r.status === "failed") stats.failed++;
      else stats.retried++;
      if (!r.ok && r.reason) {
        console.warn(`[social-publish] post ${row.id} attempt: status=${r.status} reason=${r.reason}`);
      }
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[social-publish] post ${row.id} threw:`, message);
      await recordPublishError(env, row.id, message);
      try {
        const prior = await loadDlq(env, row.id);
        await upsertDlq(
          env,
          row.id,
          (prior?.retry_count ?? 0) + 1,
          "pending",
          new Date(Date.now() + nextBackoffMs(prior?.retry_count ?? 0)).toISOString(),
          message,
        );
      } catch (dlqErr) {
        console.error(`[social-publish] post ${row.id} dlq write failed:`, (dlqErr as Error).message);
      }
    }
  }

  stats.duration_ms = Date.now() - started;
  console.log(
    `[social-publish] cron done: eligible=${stats.eligible} scanned=${stats.scanned} published=${stats.published} retried=${stats.retried} failed=${stats.failed} backoff=${stats.skipped_backoff} in ${stats.duration_ms}ms`,
  );
  return stats;
}
