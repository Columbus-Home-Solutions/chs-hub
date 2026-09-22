/**
 * AI image generation for non-job posts (Sprint 16, Deliverable D).
 *
 * Provider: Gemini image generation via Vertex AI (`gemini-2.5-flash-image`).
 * Vertex generative model IDs are retired periodically — a 404 here usually
 * means the model ID went stale, not a permissions problem.
 *
 * Auth is the same service-account flow as transcription (`google-auth.ts`):
 * GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY + GOOGLE_PROJECT_ID, or
 * GOOGLE_SERVICE_ACCOUNT_JSON. Gated on `image_gen_enabled` when set.
 *
 * The bytes land in R2 under a deterministic key derived from the post id;
 * `ai_generated_image_url` is stamped to GET /api/social-posts/:id/image.
 */

import type { Env } from "../env.js";
import { putImage, streamObject } from "./r2.js";
import {
  bumpImageGenCount,
  getSetting,
  SETTING_IMAGE_GEN_ENABLED,
  SETTING_IMAGE_GEN_MODEL,
} from "./social.js";
import { getGoogleAccessToken } from "./google-auth.js";

/**
 * Fallback when `image_gen_model_id` is unset. Confirmed GA on Vertex
 * (docs 2026-09-21), available in us-central1. Retirement: 2027-03-15.
 * Vertex generative model IDs are retired periodically — a 404 here usually
 * means this ID went stale, not a permissions problem. Change the setting;
 * do not treat a missing model as an IAM issue.
 */
export const IMAGE_GEN_MODEL = "gemini-2.5-flash-image";
const VERTEX_LOCATION = "us-central1";

/** Style suffix appended to every image prompt (after sanitization). */
const IMAGE_STYLE_SUFFIX =
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

/** Strip text-overlay instructions that the model renders as garbled copy. */
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

export function assembleImagePrompt(callerPrompt: string): string {
  const base = sanitizeImagePrompt(callerPrompt);
  return [base, IMAGE_STYLE_SUFFIX, pickVariation()].filter(Boolean).join(" ");
}

export function socialImageKey(postId: string): string {
  return `social-images/${postId}.png`;
}

interface GoogleServiceAccountCreds {
  clientEmail: string;
  privateKey: string;
  projectId: string;
}

/** Resolve Vertex service account creds from env secrets or SA JSON blob. */
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

/**
 * Model ID actually called. Reads `image_gen_model_id`; falls back to
 * {@link IMAGE_GEN_MODEL} when the row is missing or blank.
 */
export async function resolveImageGenModel(env: Env): Promise<string> {
  const configured = (await getSetting(env, SETTING_IMAGE_GEN_MODEL))?.trim();
  return configured || IMAGE_GEN_MODEL;
}

/**
 * Plant the default model-id row when it is missing so Settings → Integrations
 * can edit it (PUT /api/settings/:key 404s on an unknown key). Same upsert
 * pattern as the monthly image-gen counter — a data row, not a migration.
 */
export async function ensureImageGenModelSetting(env: Env): Promise<string> {
  const model = await resolveImageGenModel(env);
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'string', 'social', 'Image generation model', 'Vertex AI model ID for social image generation. Update this when Google retires the current model.', datetime('now'))
     ON CONFLICT(key) DO NOTHING`,
  )
    .bind(SETTING_IMAGE_GEN_MODEL, model)
    .run();
  return model;
}

/** True when Vertex credentials are present and image_gen_enabled is not off. */
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
    const { bytes, mimeType } = await generateImageViaGemini(prompt, env);
    const r2Key = socialImageKey(postId);
    await putImage(env, r2Key, bytes, mimeType);
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

interface GeminiInlineData {
  data?: string;
  mimeType?: string;
  mime_type?: string;
}

interface GeminiPart {
  text?: string;
  inlineData?: GeminiInlineData;
  inline_data?: GeminiInlineData;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
  }>;
}

/** Pull the first inline image out of a Vertex generateContent response. */
export function extractGeminiImage(data: GeminiGenerateContentResponse): {
  b64: string;
  mimeType: string;
} | null {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part.inlineData ?? part.inline_data;
    const b64 = inline?.data;
    if (!b64) continue;
    const mimeType = inline.mimeType ?? inline.mime_type ?? "image/png";
    return { b64, mimeType };
  }
  return null;
}

/** Vertex generateContent URL for a project + model. Location stays us-central1. */
export function imageGenEndpoint(projectId: string, modelId: string): string {
  return (
    `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/` +
    `${projectId}/locations/${VERTEX_LOCATION}/publishers/google/` +
    `models/${modelId}:generateContent`
  );
}

export function decodeBase64Bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Generate image bytes and return them. Callers that only need a liveness check discard the bytes. */
export async function generateImageViaGemini(
  prompt: string,
  env: Env,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const creds = resolveGoogleServiceAccount(env);
  if (!creds) {
    throw new Error("Google service account credentials not configured");
  }

  let finalPrompt = assembleImagePrompt(prompt);
  finalPrompt = `${finalPrompt} Style variant ${Math.floor(Math.random() * 99999)}.`;

  const accessToken = await getGoogleAccessToken(
    creds.clientEmail,
    creds.privateKey,
    "https://www.googleapis.com/auth/cloud-platform",
  );

  const model = await resolveImageGenModel(env);
  const endpoint = imageGenEndpoint(creds.projectId, model);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: finalPrompt }],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "1:1" },
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini image API failed: ${response.status} ${err}`);
  }

  const data = (await response.json()) as GeminiGenerateContentResponse;
  const extracted = extractGeminiImage(data);
  if (!extracted) throw new Error("No image in Gemini response");

  return { bytes: decodeBase64Bytes(extracted.b64), mimeType: extracted.mimeType };
}
