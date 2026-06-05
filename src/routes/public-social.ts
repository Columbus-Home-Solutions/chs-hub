/**
 * Public social media assets for Facebook/Instagram Graph API fetches.
 *
 * Unauthenticated — gated by post/photo linkage, not Access. Served on
 * client.homesolutionsar.com (APP_PUBLIC_ORIGIN) alongside pay/quote/portal.
 */

import type { Env } from "../env.js";
import { handlePhotoStream } from "./photos.js";
import { streamSocialImage } from "../lib/image-gen.js";

const PUBLISHABLE_STATUSES = ["approved", "scheduled", "published", "failed"] as const;

function jsonErr(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** GET /api/public/social-posts/:id/image */
export async function handlePublicSocialImage(env: Env, postId: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT id, status, ai_generated_image_url FROM social_posts WHERE id = ?",
  )
    .bind(postId)
    .first<{ id: string; status: string; ai_generated_image_url: string | null }>();
  if (!row?.ai_generated_image_url) return jsonErr(404, "not_found");
  if (!PUBLISHABLE_STATUSES.includes(row.status as (typeof PUBLISHABLE_STATUSES)[number])) {
    return jsonErr(404, "not_found");
  }
  const res = await streamSocialImage(env, postId);
  if (!res) return jsonErr(404, "object_missing");
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(res.body, { status: res.status, headers });
}

/** GET /api/public/social/photos/:id — original, only when linked to a publishable post. */
export async function handlePublicSocialPhoto(env: Env, photoId: string): Promise<Response> {
  const link = await env.DB.prepare(
    `SELECT 1 AS ok FROM social_posts sp, json_each(sp.photo_ids) je
     WHERE je.value = ?
       AND sp.status IN ('approved','scheduled','published','failed')
     LIMIT 1`,
  )
    .bind(photoId)
    .first<{ ok: number }>();
  if (!link) return jsonErr(404, "not_found");
  return handlePhotoStream(env, photoId, "original");
}
