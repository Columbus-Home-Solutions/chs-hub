/**
 * Social Media Engine — shared helpers (Sprint 16).
 *
 * The social tables (`social_posts`, `content_schedules`) and the
 * `v_content_schedule_counts` view already exist (migration 0021 + 0023). This
 * sprint is pure code over that schema — no migration. This module centralises
 * the row shaping, photo resolution, settings access, and audit logging that
 * the social-post / content-schedule / publish routes all share, so none of
 * them drift.
 *
 * Conventions mirror jobs-api.ts: thin handlers, parameterized D1, audit-log on
 * every state transition, role enforcement via guard().
 */

import type { Env } from "../env.js";

// ─── domain constants ─────────────────────────────────────────────────────────

export const POST_TYPES = [
  "job_completion",
  "seasonal_tips",
  "tips_tricks",
  "promotion",
  "review_highlight",
  "manual",
] as const;
export type PostType = (typeof POST_TYPES)[number];

export const POST_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "published",
  "rejected",
  "failed",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const PLATFORMS = ["both", "facebook_only", "instagram_only"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Posts that pull from real job photos (used for calendar colour-coding etc.). */
export const PHOTO_BACKED_TYPES = new Set<PostType>(["job_completion", "review_highlight"]);

// ─── system_settings keys (seeded locally; reads default gracefully) ──────────

export const SETTING_BRAND_VOICE = "social_brand_voice";
export const SETTING_PUBLISH_MODE = "social_publish_mode";
export const SETTING_FB_PAGE_ID = "social_facebook_page_id";
export const SETTING_FB_TOKEN = "social_facebook_page_token";
export const SETTING_IG_ACCOUNT_ID = "social_instagram_account_id";
/** Instagram User access token for Graph API container + media_publish (not the Page token). */
export const SETTING_IG_USER_TOKEN = "social_instagram_user_token";
export const SETTING_GEMINI_KEY = "social_gemini_api_key";
/** @deprecated Use SETTING_GEMINI_KEY — kept for migration reference only. */
export const SETTING_REPLICATE_KEY = SETTING_GEMINI_KEY;
/** When "false" / "0", disables Imagen even if Google credentials are present. */
export const SETTING_IMAGE_GEN_ENABLED = "image_gen_enabled";
export const SETTING_IMAGE_GEN_COUNT = "social_image_gen_count";
export const SETTING_HASHTAG_POOL = "social_hashtag_pool";

/** Default brand voice — owner can override via the settings row without a deploy. */
export const DEFAULT_BRAND_VOICE =
  "You write social media posts for Columbus Home Solutions, a residential " +
  "remodeling and home-improvement contractor serving central Arkansas " +
  "(Little Rock, North Little Rock, Conway, and the surrounding area). The " +
  "voice is professional, warm, and genuinely proud of quality craftsmanship. " +
  "You speak to local homeowners as a trustworthy neighbor, never salesy or " +
  "spammy. Keep it concise and authentic.";

// ─── shared HTTP helpers ──────────────────────────────────────────────────────

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Parse a stored JSON-array column (photo_ids / hashtags) to a string[]. */
export function parseJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // hashtags may be stored as a space-separated string for hand-entered posts.
    return String(s)
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

// ─── audit ─────────────────────────────────────────────────────────────────────

export async function logSocialAudit(
  env: Env,
  userEmail: string,
  action: string,
  entityId: string,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
  )
    .bind(crypto.randomUUID(), userEmail, action, "social_post", entityId, JSON.stringify(details))
    .run();
}

// ─── row shaping ─────────────────────────────────────────────────────────────

export interface SocialPostRow {
  id: string;
  post_type: string;
  status: string;
  caption: string;
  hashtags: string | null;
  platform: string;
  scheduled_date: string | null;
  published_date: string | null;
  job_id: string | null;
  photo_ids: string | null;
  ai_generated_image_url: string | null;
  facebook_post_id: string | null;
  instagram_post_id: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  engagement_data: string | null;
  rejection_reason: string | null;
  generated_by: string;
  approved_by: string | null;
  approved_date: string | null;
  created_at: string;
  image_variation_index?: number | null;
}

export function shapeSocialPost(row: SocialPostRow) {
  return {
    id: row.id,
    post_type: row.post_type,
    status: row.status,
    caption: row.caption,
    hashtags: parseJsonArray(row.hashtags),
    platform: row.platform,
    scheduled_date: row.scheduled_date,
    published_date: row.published_date,
    job_id: row.job_id,
    photo_ids: parseJsonArray(row.photo_ids),
    ai_generated_image_url: row.ai_generated_image_url,
    facebook_post_id: row.facebook_post_id,
    instagram_post_id: row.instagram_post_id,
    facebook_url: row.facebook_url,
    instagram_url: row.instagram_url,
    rejection_reason: row.rejection_reason,
    generated_by: row.generated_by,
    approved_by: row.approved_by,
    approved_date: row.approved_date,
    created_at: row.created_at,
    image_variation_index: row.image_variation_index ?? 0,
    // engagement_data stays a future seam (analytics not built this sprint).
    has_image: Boolean(row.ai_generated_image_url) || parseJsonArray(row.photo_ids).length > 0,
  };
}

export interface ResolvedPhoto {
  id: string;
  caption: string | null;
  photo_type: string | null;
  is_before_photo: boolean;
  is_after_photo: boolean;
  thumb_url: string;
  original_url: string;
}

/** Resolve a post's photo_ids → light photo records with R2 stream URLs. */
export async function resolvePhotoRefs(env: Env, photoIds: string[]): Promise<ResolvedPhoto[]> {
  if (photoIds.length === 0) return [];
  const placeholders = photoIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, caption, photo_type, is_before_photo, is_after_photo
       FROM photos WHERE id IN (${placeholders})`,
  )
    .bind(...photoIds)
    .all<{
      id: string;
      caption: string | null;
      photo_type: string | null;
      is_before_photo: number | null;
      is_after_photo: number | null;
    }>();
  const byId = new Map((results ?? []).map((r) => [r.id, r]));
  // Preserve the caller's ordering (photo_ids order = before/after order).
  return photoIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({
      id: r.id,
      caption: r.caption,
      photo_type: r.photo_type,
      is_before_photo: Boolean(r.is_before_photo),
      is_after_photo: Boolean(r.is_after_photo),
      thumb_url: `/api/photos/${r.id}/thumb`,
      original_url: `/api/photos/${r.id}`,
    }));
}

// ─── settings access (all reads default gracefully when the row is absent) ────

export async function getSetting(env: Env, key: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
      .bind(key)
      .first<{ value: string | null }>();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** Instagram Graph API token: prefer User token, fall back to Page token when unset. */
export async function resolveInstagramAccessToken(env: Env): Promise<string | null> {
  const igUserRaw = (await getSetting(env, SETTING_IG_USER_TOKEN))?.trim() ?? "";
  if (igUserRaw) {
    console.log(
      `[social] resolveInstagramAccessToken social_instagram_user_token found=true length=${igUserRaw.length} source=social_instagram_user_token`,
    );
    return igUserRaw;
  }
  const pageRaw = (await getSetting(env, SETTING_FB_TOKEN))?.trim() ?? "";
  console.log(
    `[social] resolveInstagramAccessToken social_instagram_user_token found=false length=0 fallback=social_facebook_page_token found=${pageRaw.length > 0} length=${pageRaw.length}`,
  );
  return pageRaw || null;
}

/** Brand-voice system prompt: settings row → env → built-in default. */
export async function getBrandVoice(env: Env): Promise<string> {
  const fromSettings = await getSetting(env, SETTING_BRAND_VOICE);
  return (fromSettings && fromSettings.trim()) || DEFAULT_BRAND_VOICE;
}

/** Current YYYY-MM bucket key for the monthly image-gen counter. */
export function imageGenMonthKey(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Read the monthly image-gen counters ({ "2026-06": 3 }). */
export async function getImageGenCounts(env: Env): Promise<Record<string, number>> {
  const raw = await getSetting(env, SETTING_IMAGE_GEN_COUNT);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Increment this month's image-gen counter (cost monitoring — business rule 7). */
export async function bumpImageGenCount(env: Env): Promise<number> {
  const counts = await getImageGenCounts(env);
  const key = imageGenMonthKey();
  counts[key] = (counts[key] ?? 0) + 1;
  const value = JSON.stringify(counts);
  // Upsert: create the row if the local seed never planted it (prod-safe).
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'json', 'social', 'Image generation count', 'Monthly AI image-generation counter for cost monitoring.', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  )
    .bind(SETTING_IMAGE_GEN_COUNT, value)
    .run();
  return counts[key];
}
