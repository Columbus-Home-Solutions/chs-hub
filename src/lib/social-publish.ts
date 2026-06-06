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
  SETTING_FB_PAGE_ID,
  SETTING_FB_TOKEN,
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
const FACEBOOK_GRAPH_BASE = "https://graph.facebook.com/v25.0";
/** Instagram error 9007: container still processing — wait before media_publish. */
const IG_CONTAINER_PROCESSING_WAIT_MS = 5000;
const IG_CONTAINER_NOT_READY_CODE = 9007;

/** Match IG publish time to a Page feed post within this window (ms). */
export const FB_CROSSPOST_TIMESTAMP_WINDOW_MS = 60_000;

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
  return { instagramPostId, facebookPostId };
}

export interface InstagramMediaLookup {
  id: string | null;
  timestampMs: number | null;
  permalink: string | null;
  isSharedToFeed: boolean | null;
}

export interface FacebookFeedPost {
  id: string;
  created_time: string;
  permalink_url?: string;
}

/** Parse ISO or unix Graph API timestamps to epoch ms. */
export function parseGraphTimestamp(value: unknown): number | null {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  return null;
}

export function parseInstagramMediaLookup(data: Record<string, unknown>): InstagramMediaLookup {
  return {
    id: typeof data.id === "string" ? data.id : null,
    timestampMs: parseGraphTimestamp(data.timestamp),
    permalink: typeof data.permalink === "string" ? data.permalink : null,
    isSharedToFeed: typeof data.is_shared_to_feed === "boolean" ? data.is_shared_to_feed : null,
  };
}

/** Find the Page feed post whose created_time is closest to the IG publish time. */
export function matchFacebookFeedPostByTimestamp(
  igTimestampMs: number,
  feedPosts: FacebookFeedPost[],
  windowMs: number = FB_CROSSPOST_TIMESTAMP_WINDOW_MS,
): { postId: string; url: string | null } | null {
  let best: { postId: string; url: string | null; delta: number } | null = null;
  for (const post of feedPosts) {
    if (!post.id) continue;
    const createdMs = parseGraphTimestamp(post.created_time);
    if (createdMs == null) continue;
    const delta = Math.abs(createdMs - igTimestampMs);
    if (delta <= windowMs && (!best || delta < best.delta)) {
      best = {
        postId: post.id,
        url: typeof post.permalink_url === "string" ? post.permalink_url : null,
        delta,
      };
    }
  }
  if (!best) return null;
  return { postId: best.postId, url: best.url };
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
  facebookPageId?: string;
}): { url: string; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {
    image_url: args.imageUrl,
    caption: args.caption,
    access_token: args.accessToken,
  };
  if (args.alsoShareToFacebook) {
    body.also_share_to_facebook = true;
    if (args.facebookPageId) {
      body.page_id = args.facebookPageId;
    }
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

/** GET URL to confirm a published IG media id and read its timestamp. */
export function buildInstagramMediaLookupUrl(args: {
  instagramPostId: string;
  accessToken: string;
}): string {
  const params = new URLSearchParams({
    fields: "id,timestamp,permalink,is_shared_to_feed",
    access_token: args.accessToken,
  });
  return `${INSTAGRAM_GRAPH_BASE}/${args.instagramPostId}?${params.toString()}`;
}

/** GET URL for recent Page feed posts (Facebook Page token). */
export function buildFacebookPageFeedUrl(args: {
  pageId: string;
  accessToken: string;
  limit?: number;
}): string {
  const params = new URLSearchParams({
    access_token: args.accessToken,
    limit: String(args.limit ?? 5),
    fields: "id,created_time,permalink_url",
  });
  return `${FACEBOOK_GRAPH_BASE}/${args.pageId}/feed?${params.toString()}`;
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

async function resolveFacebookCrosspostFromFeed(
  env: Env,
  igMediaId: string,
  igUserToken: string,
  postId?: string,
): Promise<{ facebookPostId: string | null; facebookUrl: string | null }> {
  const logRef = postId ?? igMediaId;

  const igRes = await fetch(
    buildInstagramMediaLookupUrl({ instagramPostId: igMediaId, accessToken: igUserToken }),
  );
  let igData: Record<string, unknown>;
  try {
    igData = (await igRes.json()) as Record<string, unknown>;
  } catch {
    console.warn(
      `[social-publish] instagram media lookup invalid json post=${logRef} instagram=${igMediaId}`,
    );
    return { facebookPostId: null, facebookUrl: null };
  }
  if (!igRes.ok) {
    console.warn(
      `[social-publish] instagram media lookup failed post=${logRef} http=${igRes.status} response=${JSON.stringify(redactForLog(igData))}`,
    );
    return { facebookPostId: null, facebookUrl: null };
  }

  const igMedia = parseInstagramMediaLookup(igData);
  if (!igMedia.id || igMedia.timestampMs == null) {
    console.warn(
      `[social-publish] instagram media lookup missing id/timestamp post=${logRef} response=${JSON.stringify(redactForLog(igData))}`,
    );
    return { facebookPostId: null, facebookUrl: null };
  }

  const pageId = (await getSetting(env, SETTING_FB_PAGE_ID))?.trim();
  const pageToken = (await getSetting(env, SETTING_FB_TOKEN))?.trim();
  if (!pageId || !pageToken) {
    console.warn(
      `[social-publish] facebook feed lookup skipped (page id/token missing) post=${logRef}`,
    );
    return { facebookPostId: null, facebookUrl: null };
  }

  const feedRes = await fetch(buildFacebookPageFeedUrl({ pageId, accessToken: pageToken, limit: 5 }));
  let feedData: Record<string, unknown>;
  try {
    feedData = (await feedRes.json()) as Record<string, unknown>;
  } catch {
    console.warn(`[social-publish] facebook feed lookup invalid json post=${logRef}`);
    return { facebookPostId: null, facebookUrl: null };
  }
  if (!feedRes.ok) {
    console.warn(
      `[social-publish] facebook feed lookup failed post=${logRef} http=${feedRes.status} response=${JSON.stringify(redactForLog(feedData))}`,
    );
    return { facebookPostId: null, facebookUrl: null };
  }

  const feedPosts = (feedData.data as FacebookFeedPost[] | undefined) ?? [];
  const match = matchFacebookFeedPostByTimestamp(igMedia.timestampMs, feedPosts);
  if (!match) {
    console.warn(
      `[social-publish] no facebook feed post within ${FB_CROSSPOST_TIMESTAMP_WINDOW_MS / 1000}s of instagram publish post=${logRef} instagram=${igMediaId} ig_ts=${igMedia.timestampMs} feed_count=${feedPosts.length}`,
    );
    return { facebookPostId: null, facebookUrl: null };
  }

  return {
    facebookPostId: match.postId,
    facebookUrl: match.url ?? `https://www.facebook.com/${match.postId}`,
  };
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
    const reasons: string[] = [];
    if (!token) reasons.push("missing_access_token");
    if (!imageUrl) reasons.push("missing_image_url");
    console.warn(
      `[social-publish] instagram_not_connected post=${post.id} reason=${reasons.join(",") || "unknown"} has_token=${!!token} has_image_url=${!!imageUrl}`,
    );
    return { ok: false, error: "instagram_not_connected" };
  }

  try {
    const socialFacebookPageId = shareToFacebook
      ? (await getSetting(env, SETTING_FB_PAGE_ID))?.trim()
      : undefined;
    if (shareToFacebook && !socialFacebookPageId) {
      console.warn(
        `[social-publish] facebook cross-post missing social_facebook_page_id post=${post.id}`,
      );
    }
    const c = buildInstagramContainerRequest({
      igAccountId: igId,
      accessToken: token,
      imageUrl,
      caption: text,
      alsoShareToFacebook: shareToFacebook,
      facebookPageId: socialFacebookPageId,
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

    await new Promise((resolve) => setTimeout(resolve, IG_CONTAINER_PROCESSING_WAIT_MS));

    const p = buildInstagramPublishRequest({ igAccountId: igId, accessToken: token, creationId: cData.id });
    const callMediaPublish = async () => {
      const pRes = await fetch(p.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p.body),
      });
      const pData = (await pRes.json()) as Record<string, unknown> & {
        error?: { message?: string; code?: number };
      };
      return { pRes, pData };
    };

    let { pRes, pData } = await callMediaPublish();
    const firstPublishErrorCode = pData.error?.code;
    if ((!pRes.ok || pData.error) && firstPublishErrorCode === IG_CONTAINER_NOT_READY_CODE) {
      console.warn(
        `[social-publish] instagram container not ready (9007), retrying after wait post=${post.id} creation_id=${cData.id}`,
      );
      await new Promise((resolve) => setTimeout(resolve, IG_CONTAINER_PROCESSING_WAIT_MS));
      ({ pRes, pData } = await callMediaPublish());
    }

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

    let facebookUrl: string | undefined;
    if (shareToFacebook && !facebookPostId) {
      const cross = await resolveFacebookCrosspostFromFeed(env, instagramPostId, token, post.id);
      facebookPostId = cross.facebookPostId;
      facebookUrl = cross.facebookUrl ?? undefined;
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
      facebookUrl: facebookUrl ?? (facebookPostId ? `https://www.facebook.com/${facebookPostId}` : undefined),
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
        const cross = await resolveFacebookCrosspostFromFeed(
          env,
          post.instagram_post_id,
          token,
          postId,
        );
        if (cross.facebookPostId) {
          outcomes.push({
            platform: "facebook",
            ok: true,
            postId: cross.facebookPostId,
            url: cross.facebookUrl ?? `https://www.facebook.com/${cross.facebookPostId}`,
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
