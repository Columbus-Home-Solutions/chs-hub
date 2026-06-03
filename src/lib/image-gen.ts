/**
 * AI image generation for non-job posts (Sprint 16, Deliverable D).
 *
 * Provider: Google Imagen 3 via Vertex AI, authenticated with a service account.
 * Requires GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_PROJECT_ID secrets.
 *
 * Gated on configured credentials: absent secrets → callers receive a
 * "configure image API / attach manually" state and the post still flows through
 * the queue. Per-image cost means generation is NEVER speculative (business
 * rule #7): it fires only on an explicit "Generate Image" request or as part of
 * an owner-initiated schedule, and bumps the monthly cost counter on success.
 *
 * The bytes land in R2 under a deterministic key derived from the post id;
 * `ai_generated_image_url` is stamped to GET /api/social-posts/:id/image.
 */

import type { Env } from "../env.js";
import { putImage, streamObject } from "./r2.js";
import { bumpImageGenCount } from "./social.js";
import { getGoogleAccessToken } from "./google-auth.js";

/** Deterministic R2 key for a post's generated image. */
export function socialImageKey(postId: string): string {
  return `social-images/${postId}.png`;
}

export function imageGenConfigured(env: Env): boolean {
  return !!(
    env.GOOGLE_CLIENT_EMAIL &&
    env.GOOGLE_PRIVATE_KEY &&
    env.GOOGLE_PROJECT_ID
  );
}

export interface ImageGenResult {
  ok: boolean;
  /** App path stamped onto ai_generated_image_url when ok. */
  url: string | null;
  /** True when no credentials are configured (degrade to "configure image API"). */
  unconfigured: boolean;
  error: string | null;
  /** This month's running count after a successful generation. */
  monthly_count?: number;
}

/**
 * Generate an image for `postId` from `prompt`, store it in R2, and stamp
 * `ai_generated_image_url`. Degrades to unconfigured when service account
 * secrets are absent.
 */
export async function generateAndStoreImage(
  env: Env,
  postId: string,
  prompt: string,
): Promise<ImageGenResult> {
  if (!imageGenConfigured(env)) {
    return { ok: false, url: null, unconfigured: true, error: "imagen_not_configured" };
  }

  try {
    const bytes = await generateImageViaImagen(prompt, env);
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

async function generateImageViaImagen(prompt: string, env: Env): Promise<Uint8Array> {
  const { GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_PROJECT_ID } = env;

  if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY || !GOOGLE_PROJECT_ID) {
    throw new Error("Google service account credentials not configured");
  }

  const accessToken = await getGoogleAccessToken(
    GOOGLE_CLIENT_EMAIL,
    GOOGLE_PRIVATE_KEY,
    "https://www.googleapis.com/auth/cloud-platform",
  );

  const endpoint =
    `https://us-central1-aiplatform.googleapis.com/v1/projects/` +
    `${GOOGLE_PROJECT_ID}/locations/us-central1/publishers/google/` +
    `models/imagen-3.0-generate-001:predict`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1, aspectRatio: "1:1" },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Imagen API failed: ${response.status} ${err}`);
  }

  const data = (await response.json()) as {
    predictions?: Array<{ bytesBase64Encoded?: string }>;
  };

  const b64 = data.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error("No image in Imagen response");

  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
