/**
 * R2 storage helpers (Sprint 8).
 *
 * The photo/expense routes historically inlined their R2 writes. This module
 * centralises the key layout + put/get/copy primitives so the photo capture
 * path, batch sync, and receipt flow all agree on where bytes live.
 *
 * Bucket layout (binding: env.FILES → chs-hub-files):
 *   photos/{job|"general"}/{YYYY-MM-DD}/{uuid}.jpg          full-size original
 *   photos-thumbs/{job|"general"}/{YYYY-MM-DD}/{uuid}.jpg   ~400-800px thumb
 *
 * Thumbnails are generated client-side (the Workers runtime has no image
 * resize without Cloudflare Images, which this plan doesn't enable). When a
 * caller has no thumb, point the thumbnail key at the full-size object so the
 * UI still renders — business rule #8 (thumbnail failure is non-fatal).
 */

import type { Env } from "../env.js";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** YYYY-MM-DD bucket from an ISO timestamp; falls back to today if absent/bad. */
export function dateBucket(takenAt: string | null | undefined): string {
  const d = takenAt ? new Date(takenAt) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function photoOriginalKey(jobId: string | null, bucket: string, id: string): string {
  return `photos/${jobId ?? "general"}/${bucket}/${id}.jpg`;
}

export function photoThumbKey(jobId: string | null, bucket: string, id: string): string {
  return `photos-thumbs/${jobId ?? "general"}/${bucket}/${id}.jpg`;
}

/** Write an image blob/bytes to R2 with a sane content type. */
export async function putImage(
  env: Env,
  key: string,
  body: ArrayBuffer | Uint8Array,
  contentType?: string,
): Promise<void> {
  await env.FILES.put(key, body, {
    httpMetadata: { contentType: contentType || "image/jpeg" },
  });
}

/** Stream an R2 object back as a Response, or null when it's missing. */
export async function streamObject(env: Env, key: string): Promise<Response | null> {
  const obj = await env.FILES.get(key);
  if (!obj) return null;
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.get("content-type")) headers.set("content-type", "image/jpeg");
  headers.set("cache-control", "private, max-age=300");
  return new Response(obj.body, { headers });
}
