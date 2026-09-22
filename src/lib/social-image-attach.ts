/**
 * Attach a Gemini image to a non-job social draft.
 *
 * Monthly schedule inserts used to save the caption only, so Seasonal/Tips
 * posts showed an empty tile. Replicate was never wired; the live generator
 * is Gemini (src/lib/image-gen.ts). A failure here does not roll back the post.
 */

import type { Env } from "../env.js";
import { generateAndStoreImage, imageGenConfigured } from "./image-gen.js";
import { generateImageSubjectPrompt, type CaptionContext } from "./social-ai.js";

const AI_IMAGE_TYPES = new Set(["seasonal_tips", "tips_tricks", "promotion"]);

export function postTypeUsesAiImage(postType: string): boolean {
  return AI_IMAGE_TYPES.has(postType);
}

export async function attachAiImageIfNeeded(
  env: Env,
  postId: string,
  postType: string,
  ctx: CaptionContext,
): Promise<boolean> {
  if (!postTypeUsesAiImage(postType)) return false;
  if (!(await imageGenConfigured(env))) return false;
  try {
    const prompt = await generateImageSubjectPrompt(env, ctx, 0);
    const result = await generateAndStoreImage(env, postId, prompt);
    if (!result.ok) {
      console.error("[social] image gen failed:", result.error ?? "unknown");
      return false;
    }
    return true;
  } catch (err) {
    console.error("[social] image gen threw:", (err as Error).message);
    return false;
  }
}
