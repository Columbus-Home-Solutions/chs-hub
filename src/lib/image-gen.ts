/**
 * AI image generation for non-job posts (Sprint 16, Deliverable D).
 *
 * Provider: Google Imagen 3 via Vertex AI, authenticated with a service account.
 * Credentials resolve from GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY +
 * GOOGLE_PROJECT_ID secrets, or from GOOGLE_SERVICE_ACCOUNT_JSON (same SA as
 * Drive/Sheets). Gated on `image_gen_enabled` in system_settings when set.
 *
 * The bytes land in R2 under a deterministic key derived from the post id;
 * `ai_generated_image_url` is stamped to GET /api/social-posts/:id/image.
 */

import type { Env } from "../env.js";
import { putImage, streamObject } from "./r2.js";
import { bumpImageGenCount, getSetting, SETTING_IMAGE_GEN_ENABLED } from "./social.js";
import { getGoogleAccessToken } from "./google-auth.js";

/** Style suffix appended to every Imagen prompt (after sanitization). */
const IMAGEN_STYLE_SUFFIX =
  "Photorealistic, natural lighting, professional quality. " +
  "No text, no words, no letters, no watermarks, no logos. " +
  "Focus on the scene, materials, and craftsmanship.";

const VARIATION_SEEDS = [
  "Wide shot showing the full scope of the work.",
  "Close-up detail highlighting the quality of materials and finish.",
  "Natural daylight, warm tones, welcoming atmosphere.",
  "Dramatic angle emphasizing the transformation.",
  "Bright, airy feel — fresh and clean result.",
];

/** Strip text-overlay instructions that Imagen renders as garbled copy. */
export function sanitizeImagePrompt(prompt: string): string {
  const textPatterns = [
    /\b(text|words?|letters?|typography|font|caption|title|label|overlay|watermark|logo|banner|headline|copy)\b/gi,
    /add(ing)?\s+(text|words?|a\s+title)/gi,
    /with\s+(text|words?|the\s+(words?|text))/gi,
    /"[^"]*"/g,
  ];
  let sanitized = prompt;
  for (const pattern of textPatterns) {
    sanitized = sanitized.replace(pattern, "");
  }
  return sanitized.replace(/\s{2,}/g, " ").trim();
}

function pickVariation(): string {
  return VARIATION_SEEDS[Math.floor(Math.random() * VARIATION_SEEDS.length)]!;
}

function assembleImagenPrompt(callerPrompt: string): string {
  const base = sanitizeImagePrompt(callerPrompt);
  return [base, IMAGEN_STYLE_SUFFIX, pickVariation()].filter(Boolean).join(" ");
}

export function socialImageKey(postId: string): string {
  return `social-images/${postId}.png`;
}

interface GoogleServiceAccountCreds {
  clientEmail: string;
  privateKey: string;
  projectId: string;
}

/** Resolve Vertex/Imagen service account creds from env secrets or SA JSON blob. */
export function resolveGoogleServiceAccount(env: Env): GoogleServiceAccountCreds | null {
  const email = env.GOOGLE_CLIENT_EMAIL?.trim();
  const key = env.GOOGLE_PRIVATE_KEY?.trim();
  const project = env.GOOGLE_PROJECT_ID?.trim();
  if (email && key && project) {
    return { clientEmail: email, privateKey: key, projectId: project };
  }

  const jsonRaw = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!jsonRaw) return null;

  try {
    const parsed = JSON.parse(jsonRaw) as {
      client_email?: string;
      private_key?: string;
      project_id?: string;
    };
    if (parsed.client_email && parsed.private_key && parsed.project_id) {
      return {
        clientEmail: parsed.client_email,
        privateKey: parsed.private_key,
        projectId: parsed.project_id,
      };
    }
  } catch {
    /* invalid JSON */
  }
  return null;
}

/** True when Imagen credentials are present and image_gen_enabled is not off. */
export async function imageGenConfigured(env: Env): Promise<boolean> {
  const flag = (await getSetting(env, SETTING_IMAGE_GEN_ENABLED))?.trim().toLowerCase();
  if (flag === "false" || flag === "0") return false;
  return resolveGoogleServiceAccount(env) !== null;
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
  if (!(await imageGenConfigured(env))) {
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
  const creds = resolveGoogleServiceAccount(env);
  if (!creds) {
    throw new Error("Google service account credentials not configured");
  }

  const finalPrompt = assembleImagenPrompt(prompt);

  const accessToken = await getGoogleAccessToken(
    creds.clientEmail,
    creds.privateKey,
    "https://www.googleapis.com/auth/cloud-platform",
  );

  const endpoint =
    `https://us-central1-aiplatform.googleapis.com/v1/projects/` +
    `${creds.projectId}/locations/us-central1/publishers/google/` +
    `models/imagen-3.0-generate-001:predict`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      instances: [{ prompt: finalPrompt }],
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
