/**
 * Social AI — caption + hashtag generation (Sprint 16, Deliverable B).
 *
 * A thin module over the EXISTING Claude wrapper (src/lib/claude.ts) — no second
 * AI client. AI here is owner-facing and already live in prod (no SIMULATE gate,
 * unlike notifications). A failed Claude call degrades gracefully: the caller
 * gets a clear "AI unavailable" result and falls back to manual entry / a varied
 * default hashtag set — it never blocks post creation.
 *
 * Business rules enforced here:
 *   #8  hashtags VARY per post (the prompt instructs variety; the local fallback
 *       rotates a seeded selection so the feed never looks spammy).
 *   #9  NEVER a client's street address — captions get city/neighborhood only.
 *       The prompt shape literally cannot carry a street address, and the system
 *       prompt forbids it as a backstop.
 */

import type { Env } from "../env.js";
import { claudeMessages, extractJson } from "./claude.js";
import { getBrandVoice, getSetting, SETTING_HASHTAG_POOL, type Platform } from "./social.js";

// ─── caption context (city-only — NO street address, business rule 9) ─────────

export interface JobCaptionContext {
  kind: "job_completion";
  jobType: string | null;
  /** Scope summary derived from estimate line items (free text, no address). */
  scope?: string | null;
  /** City / neighborhood ONLY. Never the street address. */
  city?: string | null;
  beforeDescription?: string | null;
  afterDescription?: string | null;
}

export interface TopicCaptionContext {
  kind: "seasonal_tips" | "tips_tricks" | "promotion" | "review_highlight" | "manual";
  topic: string;
  season?: string | null;
  /** Free-text supporting detail (e.g. a review quote, a promotion blurb). */
  detail?: string | null;
}

export type CaptionContext = JobCaptionContext | TopicCaptionContext;

const CTA = "Free estimates — call us!";

// ─── system prompt (the brand-voice backstop) ─────────────────────────────────

export function buildCaptionSystemPrompt(brandVoice: string): string {
  return (
    `${brandVoice}\n\n` +
    "Rules you MUST follow:\n" +
    "- NEVER include a client's street address. Refer to a job's location by " +
    "city or neighborhood only.\n" +
    "- Keep captions to 1–3 short paragraphs suitable for Facebook and Instagram.\n" +
    "- Sound like a proud local craftsman, not a marketer.\n" +
    'Respond ONLY with JSON of the shape {"captions": ["option one", "option two", "option three"]}. ' +
    "Provide 2–3 distinct options."
  );
}

export function buildCaptionUserPrompt(ctx: CaptionContext): string {
  if (ctx.kind === "job_completion") {
    const lines = [
      "Write captions for a just-completed remodeling/home-improvement project.",
      ctx.jobType ? `Project type: ${ctx.jobType}.` : "",
      ctx.scope ? `Scope of work: ${ctx.scope}.` : "",
      ctx.city ? `Location (city/neighborhood only): ${ctx.city}.` : "",
      ctx.beforeDescription ? `Before photo: ${ctx.beforeDescription}.` : "",
      ctx.afterDescription ? `After photo: ${ctx.afterDescription}.` : "",
      `End every option with a call to action like "${CTA}".`,
    ];
    return lines.filter(Boolean).join("\n");
  }
  const lines = [
    ctx.kind === "review_highlight"
      ? "Write captions highlighting a happy customer review."
      : ctx.kind === "promotion"
        ? "Write captions for a seasonal promotion / offer."
        : "Write educational, helpful captions for a home-improvement tip post.",
    `Topic: ${ctx.topic}.`,
    ctx.season ? `Season / timing: ${ctx.season}.` : "",
    ctx.detail ? `Supporting detail: ${ctx.detail}.` : "",
    "Keep an informative, friendly tone aimed at central-Arkansas homeowners.",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Pull caption options out of a Claude reply, tolerating prose/format drift. */
export function parseCaptions(text: string | null): string[] {
  const obj = extractJson<{ captions?: unknown }>(text);
  if (obj && Array.isArray(obj.captions)) {
    const opts = obj.captions.map((c) => String(c).trim()).filter(Boolean);
    if (opts.length > 0) return opts.slice(0, 3);
  }
  // Fallback: split a plain reply into non-empty lines (drop list markers).
  if (text) {
    const lines = text
      .split(/\n{2,}/)
      .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
      .filter((l) => l.length > 20);
    if (lines.length > 0) return lines.slice(0, 3);
  }
  return [];
}

// ─── hashtags ─────────────────────────────────────────────────────────────────

export interface HashtagPool {
  brand?: string[];
  general?: string[];
  craftsmanship?: string[];
  trades?: string[];
  local?: string[];
  trust?: string[];
}

/** Load curated hashtag pool from system_settings (null → free-form Claude prompt). */
export async function loadHashtagPool(env: Env): Promise<HashtagPool | null> {
  const raw = await getSetting(env, SETTING_HASHTAG_POOL);
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as HashtagPool;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export const LOCAL_HASHTAGS = [
  "#LittleRock",
  "#NorthLittleRock",
  "#CentralArkansas",
  "#Conway",
  "#ArkansasHomes",
  "#LittleRockContractor",
  "#ARremodel",
];
export const TRADE_HASHTAGS = [
  "#HomeRemodel",
  "#GarageConversion",
  "#BeforeAndAfter",
  "#KitchenRemodel",
  "#BathroomRemodel",
  "#HomeRenovation",
  "#HomeImprovement",
  "#Craftsmanship",
  "#GeneralContractor",
];
export const GENERAL_HASHTAGS = [
  "#ContractorLife",
  "#DreamHome",
  "#HomeGoals",
  "#QualityWork",
  "#LocallyOwned",
  "#SupportLocal",
  "#HomeSweetHome",
];

/**
 * Deterministic-but-varied fallback hashtag set (10–15). Rotating `seed` (e.g. a
 * post id or an incrementing index) shifts the selection so two posts don't get
 * the same tags — business rule #8 without needing the AI to be reachable.
 */
export function fallbackHashtags(seed: string, jobType?: string | null): string[] {
  const h = hashSeed(seed);
  const rot = <T>(arr: T[], by: number, take: number): T[] => {
    const out: T[] = [];
    for (let i = 0; i < take && i < arr.length; i++) out.push(arr[(by + i) % arr.length]);
    return out;
  };
  const tags = [
    ...rot(LOCAL_HASHTAGS, h % LOCAL_HASHTAGS.length, 4),
    ...rot(TRADE_HASHTAGS, (h >> 2) % TRADE_HASHTAGS.length, 5),
    ...rot(GENERAL_HASHTAGS, (h >> 4) % GENERAL_HASHTAGS.length, 3),
  ];
  if (jobType) {
    const jt = "#" + jobType.replace(/[^a-z0-9]+/gi, "");
    if (jt.length > 1 && !tags.includes(jt)) tags.unshift(jt);
  }
  // De-dupe, clamp to 10–15.
  const unique = [...new Set(tags)];
  return unique.slice(0, Math.max(10, Math.min(15, unique.length)));
}

function hashSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

export function buildHashtagPrompt(
  ctx: CaptionContext,
  platform: Platform = "both",
  pool?: HashtagPool | null,
): string {
  const topic =
    ctx.kind === "job_completion"
      ? `a completed ${ctx.jobType ?? "home improvement"} project`
      : (ctx as TopicCaptionContext).topic;

  if (!pool) {
    return (
      `Generate 10–15 social hashtags for ${topic}. ` +
      "Mix local central-Arkansas tags (#LittleRock, #NorthLittleRock, #CentralArkansas), " +
      "trade-specific tags (#HomeRemodel, #GarageConversion, #BeforeAndAfter), and general tags " +
      "(#ContractorLife). VARY the selection so repeated posts don't look identical. " +
      'Respond ONLY with JSON of the shape {"hashtags": ["#Tag1", "#Tag2", ...]}.'
    );
  }

  const platformLine =
    platform === "facebook_only"
      ? "For Facebook: use only 3-5 hashtags total (less is more on Facebook)."
      : platform === "instagram_only"
        ? "For Instagram: use 10-15 hashtags."
        : 'For platform "both": respond with {"facebook_hashtags": [...3-5 tags...], "instagram_hashtags": [...10-15 tags...]}.';

  return (
    `Select hashtags for this post about ${topic}.\n\n` +
    `ALWAYS include:\n` +
    `- 2-3 brand tags\n` +
    `- 2-3 local tags\n\n` +
    `THEN pick from:\n` +
    `- 3-4 general home improvement tags\n` +
    `- 2-3 craftsmanship tags\n` +
    `- 1-2 trade-specific tags ONLY if they match the post content (e.g. don't use #Flooring for a painting post)\n` +
    `- 1-2 trust tags if appropriate\n\n` +
    `${platformLine}\n\n` +
    `Hashtag pool:\n${JSON.stringify(pool, null, 2)}\n\n` +
    "Return hashtags as JSON. Do not invent hashtags outside the pool unless the post topic has a " +
    "highly specific trade keyword not covered (e.g. #ConcreteRepair, #DrywallRepair)."
  );
}

function normalizeHashtagList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const normalized = raw
    .map(String)
    .map((t) => t.trim())
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .filter((t) => t.length > 1);
  return [...new Set(normalized)].slice(0, max);
}

/** Parse Claude hashtag JSON with platform-aware limits. */
export function parseHashtagsForPlatform(text: string | null, platform: Platform): string[] {
  const obj = extractJson<{
    hashtags?: unknown;
    facebook_hashtags?: unknown;
    instagram_hashtags?: unknown;
  }>(text);

  if (platform === "both") {
    if (obj && Array.isArray(obj.instagram_hashtags)) {
      const ig = normalizeHashtagList(obj.instagram_hashtags, 15);
      if (ig.length >= 8) return ig;
    }
    if (obj && Array.isArray(obj.facebook_hashtags)) {
      const fb = normalizeHashtagList(obj.facebook_hashtags, 5);
      if (fb.length >= 3) return fb;
    }
  }
  if (platform === "facebook_only" && obj && Array.isArray(obj.facebook_hashtags)) {
    const fb = normalizeHashtagList(obj.facebook_hashtags, 5);
    if (fb.length >= 3) return fb;
  }
  if (platform === "instagram_only" && obj && Array.isArray(obj.instagram_hashtags)) {
    const ig = normalizeHashtagList(obj.instagram_hashtags, 15);
    if (ig.length >= 8) return ig;
  }

  const max = platform === "facebook_only" ? 5 : 15;
  const min = platform === "facebook_only" ? 3 : 8;
  const tags = parseHashtags(text);
  if (tags.length >= min) return tags.slice(0, max);
  return tags;
}

export function parseHashtags(text: string | null): string[] {
  const obj = extractJson<{ hashtags?: unknown }>(text);
  let raw: string[] = [];
  if (obj && Array.isArray(obj.hashtags)) {
    raw = obj.hashtags.map(String);
  } else if (text) {
    raw = text.match(/#[A-Za-z0-9_]+/g) ?? [];
  }
  const normalized = raw
    .map((t) => t.trim())
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .filter((t) => t.length > 1);
  return [...new Set(normalized)].slice(0, 15);
}

// ─── public generation entry points ───────────────────────────────────────────

export interface CaptionResult {
  ok: boolean;
  options: string[];
  unavailable: boolean;
  error: string | null;
}

export async function generateCaptions(env: Env, ctx: CaptionContext): Promise<CaptionResult> {
  const brandVoice = await getBrandVoice(env);
  const res = await claudeMessages(env, {
    system: buildCaptionSystemPrompt(brandVoice),
    messages: [{ role: "user", content: buildCaptionUserPrompt(ctx) }],
    maxTokens: 900,
  });
  if (!res.ok) {
    return { ok: false, options: [], unavailable: true, error: res.error };
  }
  const options = parseCaptions(res.text);
  if (options.length === 0) {
    return { ok: false, options: [], unavailable: true, error: "no_captions_parsed" };
  }
  return { ok: true, options, unavailable: false, error: null };
}

export interface HashtagResult {
  ok: boolean;
  hashtags: string[];
  /** True when the AI path failed and we returned the seeded fallback set. */
  fallback: boolean;
}

export async function generateHashtags(
  env: Env,
  ctx: CaptionContext,
  seed: string,
  platform: Platform = "both",
): Promise<HashtagResult> {
  const pool = await loadHashtagPool(env);
  const res = await claudeMessages(env, {
    system: "You generate social media hashtags. Respond ONLY with JSON.",
    messages: [{ role: "user", content: buildHashtagPrompt(ctx, platform, pool) }],
    maxTokens: 400,
  });
  if (res.ok) {
    const tags = parseHashtagsForPlatform(res.text, platform);
    const min = platform === "facebook_only" ? 3 : 8;
    if (tags.length >= min) return { ok: true, hashtags: tags, fallback: false };
  }
  const jobType = ctx.kind === "job_completion" ? ctx.jobType : null;
  return { ok: true, hashtags: fallbackHashtags(seed, jobType), fallback: true };
}

// ─── image subject prompts (Imagen) ───────────────────────────────────────────

export const SUBJECT_ANGLES = [
  "Show the finished result from the homeowner's perspective standing in the room.",
  "Focus on a close-up detail — texture of materials, quality of the finish, precise craftsmanship.",
  "Wide establishing shot showing the full scope of the completed work in context.",
  "Capture the transformation — emphasize the contrast between old and new.",
  "Show the space as it will be used — lived-in, warm, inviting.",
] as const;

/** Static Imagen subject line with a concrete visual angle (Claude fallback). */
export function buildImagePromptFromContext(ctx: CaptionContext, variationIndex = 0): string {
  const angle = SUBJECT_ANGLES[variationIndex % SUBJECT_ANGLES.length]!;
  if (ctx.kind === "job_completion") {
    const place = ctx.city ? ` in a ${ctx.city} area home` : " in a central Arkansas home";
    return (
      `A photorealistic image of a completed ${ctx.jobType ?? "home improvement"} project${place}. ` +
      `${angle} Bright natural lighting, no text overlays, no watermarks.`
    );
  }
  return buildImagePrompt(ctx, variationIndex);
}

/** Ask Claude for a concrete Imagen frame description; falls back to template. */
export async function generateImageSubjectPrompt(
  env: Env,
  ctx: CaptionContext,
  variationIndex: number,
): Promise<string> {
  const angle = SUBJECT_ANGLES[variationIndex % SUBJECT_ANGLES.length]!;
  const topic =
    ctx.kind === "job_completion"
      ? `a completed ${ctx.jobType ?? "home improvement"} project` +
        (ctx.scope ? ` (${ctx.scope})` : "") +
        (ctx.city ? ` in ${ctx.city}` : " in central Arkansas")
      : `${(ctx as TopicCaptionContext).topic}` +
        ((ctx as TopicCaptionContext).season ? ` (${(ctx as TopicCaptionContext).season})` : "");

  const res = await claudeMessages(env, {
    system:
      "You write concrete Imagen image prompts for home-improvement social posts. " +
      "Never include client names, street addresses, or text/watermarks in the scene. " +
      "Respond with a single paragraph only — no JSON.",
    messages: [
      {
        role: "user",
        content:
          `Generate an image description for Imagen with this specific visual angle: ${angle}\n` +
          "The description must be concrete and specific — describe exactly what is in the frame, " +
          "not abstract style words.\n\n" +
          `Post topic: ${topic}.`,
      },
    ],
    maxTokens: 350,
  });

  const text = res.ok ? res.text?.trim() : "";
  if (text && text.length > 40) return text;
  return buildImagePromptFromContext(ctx, variationIndex);
}

/** Build the image-generation prompt for a non-job post from its topic. */
export function buildImagePrompt(ctx: TopicCaptionContext, variationIndex = 0): string {
  const angle = SUBJECT_ANGLES[variationIndex % SUBJECT_ANGLES.length]!;
  return (
    `A clean, professional, photorealistic image for a home-improvement social post about ${ctx.topic}` +
    (ctx.season ? ` (${ctx.season})` : "") +
    `. ${angle} Bright natural lighting, residential setting, no text overlays, no watermarks.`
  );
}

export { CTA };
