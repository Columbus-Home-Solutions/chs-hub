/**
 * AI image generation for non-job posts (Sprint 16, Deliverable D).
 *
 * Gated on a configured key (env.REPLICATE_API_KEY, or a settings fallback). No
 * key → callers return a "configure image API / attach manually" state and the
 * post still flows through the queue. Per-image cost means generation is NEVER
 * speculative (business rule #7): it fires only on an explicit "Generate Image"
 * request or as part of an owner-initiated schedule, and bumps the monthly
 * cost counter on success.
 *
 * The bytes land in R2 under a deterministic key derived from the post id
 * (no new column needed); `ai_generated_image_url` is stamped to the app path
 * GET /api/social-posts/:id/image which streams that object.
 */

import type { Env } from "../env.js";
import { putImage, streamObject } from "./r2.js";
import { bumpImageGenCount, getSetting, SETTING_REPLICATE_KEY } from "./social.js";

const REPLICATE_BASE = "https://api.replicate.com/v1";
// Flux 1.1 Pro (Black Forest Labs) via Replicate, per the module spec.
const FLUX_MODEL = "black-forest-labs/flux-1.1-pro";

/** Deterministic R2 key for a post's generated image. */
export function socialImageKey(postId: string): string {
  return `social-images/${postId}.png`;
}

/** Resolve the Replicate key: env secret first, settings fallback. */
async function resolveReplicateKey(env: Env): Promise<string | null> {
  const fromEnv = (env.REPLICATE_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  const fromSettings = (await getSetting(env, SETTING_REPLICATE_KEY))?.trim();
  return fromSettings || null;
}

export async function imageGenConfigured(env: Env): Promise<boolean> {
  return Boolean(await resolveReplicateKey(env));
}

export interface ImageGenResult {
  ok: boolean;
  /** App path stamped onto ai_generated_image_url when ok. */
  url: string | null;
  /** True when no key is configured (degrade to "configure image API"). */
  unconfigured: boolean;
  error: string | null;
  /** This month's running count after a successful generation. */
  monthly_count?: number;
}

/**
 * Generate an image for `postId` from `prompt`, store it in R2, and stamp
 * `ai_generated_image_url`. The real Replicate call shape is written here but is
 * only exercised when a key is present; with no key it degrades.
 */
export async function generateAndStoreImage(
  env: Env,
  postId: string,
  prompt: string,
): Promise<ImageGenResult> {
  const key = await resolveReplicateKey(env);
  if (!key) {
    return { ok: false, url: null, unconfigured: true, error: "replicate_not_configured" };
  }

  try {
    const bytes = await callReplicateFlux(key, prompt);
    if (!bytes) {
      return { ok: false, url: null, unconfigured: false, error: "image_generation_failed" };
    }
    const r2Key = socialImageKey(postId);
    await putImage(env, r2Key, bytes, "image/png");
    const appUrl = `/api/social-posts/${postId}/image`;
    await env.DB.prepare("UPDATE social_posts SET ai_generated_image_url = ? WHERE id = ?")
      .bind(appUrl, postId)
      .run();
    const monthly = await bumpImageGenCount(env);
    return { ok: true, url: appUrl, unconfigured: false, error: null, monthly_count: monthly };
  } catch (e) {
    return { ok: false, url: null, unconfigured: false, error: (e as Error).message };
  }
}

/** Stream a post's generated image from R2 (GET /api/social-posts/:id/image). */
export async function streamSocialImage(env: Env, postId: string): Promise<Response | null> {
  return streamObject(env, socialImageKey(postId));
}

/**
 * Call Replicate Flux 1.1 Pro and return the rendered PNG bytes. Uses the
 * `Prefer: wait` synchronous-prediction header so we don't have to poll inside
 * a Worker invocation. Returns null on a non-image / error response.
 *
 * NOTE: only ever called when a REPLICATE_API_KEY is present (see the gate
 * above). The request shape follows Replicate's documented predictions API.
 */
async function callReplicateFlux(apiKey: string, prompt: string): Promise<Uint8Array | null> {
  const res = await fetch(`${REPLICATE_BASE}/models/${FLUX_MODEL}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({
      input: {
        prompt,
        aspect_ratio: "1:1",
        output_format: "png",
        safety_tolerance: 2,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`replicate_http_${res.status}`);
  }
  const data = (await res.json()) as { output?: string | string[]; status?: string };
  const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
  if (!outputUrl) return null;
  const img = await fetch(outputUrl);
  if (!img.ok) throw new Error(`replicate_output_http_${img.status}`);
  return new Uint8Array(await img.arrayBuffer());
}
