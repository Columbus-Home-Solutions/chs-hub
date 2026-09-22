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
    'Respond ONLY with JSON of the shape {"captions": ["option one", "option two", "option three"], ' +
    '"headline": "six words max", "trade_tags": ["#tagone", "#tagtwo"]}. ' +
    "Provide 2–3 distinct caption options. headline is a short overlay title, not a hashtag. " +
    "trade_tags must be exactly 2 tags chosen only from this pool: " +
    "#contractorsofinsta, #remodelingideas, #generalcontractor, #homerenovation, #beforeandafter, #contractorlife. " +
    "Do not include #HomeSolutionsAR or any city tag — those are added in code."
  );
}

export function buildCaptionUserPrompt(ctx: CaptionContext): string {
  if (ctx.kind === "job_completion") {
    const lines = [
      "Write captions for a just-completed remodeling/home-improvement project.",
      ctx.jobType ? `Project type: ${ctx.jobType}.` : "",
      ctx.scope ? `Scope of work: ${ctx.scope}.` : "",
      ctx.city ? `Location (city/neighborhood only): ${ctx.city}.` : "",
      ctx.city && /sherwood|jacksonville/i.test(ctx.city)
        ? `Name ${ctx.city} in the caption itself. Do not invent a hashtag for that city.`
        : "",
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

/** Claude sometimes emits `#tag"` without the opening quote. Repair that before parse. */
function repairLooseHashtagJson(text: string): string {
  return text.replace(/,\s*#([A-Za-z0-9_]+)"/g, ', "#$1"');
}

/** Pull caption options, the overlay headline, and trade tags from one Claude reply. */
export function parseGeneratedCopy(text: string | null): {
  captions: string[];
  headline: string | null;
  tradeTags: string[];
} {
  const obj = extractJson<{ captions?: unknown; headline?: unknown; trade_tags?: unknown }>(
    text ? repairLooseHashtagJson(text) : text,
  );
  const captions = parseCaptions(text);
  let headline: string | null = null;
  if (obj && typeof obj.headline === "string") {
    const h = obj.headline.replace(/#/g, "").replace(/\s+/g, " ").trim();
    if (h) headline = h.split(" ").slice(0, 8).join(" ");
  }
  const tradeTags = normalizeHashtagList(obj?.trade_tags, 8).filter((t) => isVettedTradeTag(t)).slice(0, 2);
  return { captions, headline, tradeTags };
}

/** Pull caption options out of a Claude reply, tolerating prose/format drift. */
export function parseCaptions(text: string | null): string[] {
  const obj = extractJson<{ captions?: unknown }>(text ? repairLooseHashtagJson(text) : text);
  if (obj && Array.isArray(obj.captions)) {
    const opts = obj.captions.map((c) => String(c).trim()).filter(Boolean);
    if (opts.length > 0) return opts.slice(0, 3);
  }
  // A raw JSON blob is not a caption. Callers fall back to a plain sentence.
  if (text && /```|"captions"\s*:/.test(text)) return [];
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

/** Always appended in code. Never left to the model. */
export const BRAND_HASHTAG = "#HomeSolutionsAR";

/** Trade tags with real mid-size search volume. Mega-tags stay out. */
export const TRADE_TAG_POOL = [
  "#contractorsofinsta",
  "#remodelingideas",
  "#generalcontractor",
  "#homerenovation",
  "#beforeandafter",
  "#contractorlife",
] as const;

export function isVettedTradeTag(tag: string): boolean {
  const n = tag.trim().toLowerCase();
  return TRADE_TAG_POOL.some((t) => t === n);
}

/**
 * Two location tags from the job city. Sherwood and Jacksonville have no
 * established home-services tag, so they share the North Little Rock metro tag.
 * No city (seasonal / tips / promotion) uses the Little Rock pair.
 */
export function locationHashtags(city: string | null | undefined): [string, string] {
  const raw = (city ?? "").toLowerCase();
  const compact = raw.replace(/[^a-z]/g, "");
  if (
    compact.includes("northlittlerock") ||
    /\bnlr\b/.test(raw) ||
    compact.includes("sherwood") ||
    compact.includes("jacksonville")
  ) {
    return ["#littlerock", "#northlittlerock"];
  }
  return ["#littlerock", "#littlerockarkansas"];
}

export function cityFromContext(ctx: CaptionContext): string | null {
  return ctx.kind === "job_completion" ? (ctx.city ?? null) : null;
}

/** Exactly 5 tags: brand + 2 location + 2 vetted trade tags. */
export function assembleHashtags(
  city: string | null | undefined,
  tradeTags: string[],
  seed: string,
): string[] {
  return [BRAND_HASHTAG, ...locationHashtags(city), ...pickTradeTags(tradeTags, seed)];
}

export function pickTradeTags(raw: string[], seed: string): [string, string] {
  const chosen: string[] = [];
  for (const tag of raw) {
    const canon = TRADE_TAG_POOL.find((p) => p === tag.trim().toLowerCase());
    if (canon && !chosen.includes(canon)) chosen.push(canon);
    if (chosen.length === 2) break;
  }
  const h = hashSeed(seed);
  let i = 0;
  while (chosen.length < 2) {
    const next = TRADE_TAG_POOL[(h + i) % TRADE_TAG_POOL.length]!;
    i += 1;
    if (!chosen.includes(next)) chosen.push(next);
  }
  return [chosen[0]!, chosen[1]!];
}

/** Fallback when Claude is down: still exactly 5, still the vetted set. */
export function fallbackHashtags(seed: string, city?: string | null): string[] {
  return assembleHashtags(city ?? null, [], seed);
}

function hashSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

export function buildHashtagPrompt(
  ctx: CaptionContext,
  _platform: Platform = "both",
  _pool?: HashtagPool | null,
): string {
  const topic =
    ctx.kind === "job_completion"
      ? `a completed ${ctx.jobType ?? "home improvement"} project`
      : (ctx as TopicCaptionContext).topic;

  return (
    `Pick exactly 2 trade hashtags for a post about ${topic}. ` +
    `Choose only from this pool: ${TRADE_TAG_POOL.join(", ")}. ` +
    "Do not add a brand tag or a city tag. " +
    'Respond ONLY with JSON {"trade_tags": ["#one", "#two"]}.'
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

/** Pull the two trade tags Claude was asked for. Brand and city tags are not parsed here. */
export function parseHashtagsForPlatform(text: string | null, _platform: Platform): string[] {
  const obj = extractJson<{ trade_tags?: unknown; hashtags?: unknown }>(
    text ? repairLooseHashtagJson(text) : text,
  );
  const fromTrade = normalizeHashtagList(obj?.trade_tags, 8).filter((t) => isVettedTradeTag(t)).slice(0, 2);
  if (fromTrade.length > 0) return fromTrade;
  return normalizeHashtagList(obj?.hashtags, 8).filter((t) => isVettedTradeTag(t)).slice(0, 2);
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
  return [...new Set(normalized)].slice(0, 5);
}

// ─── public generation entry points ───────────────────────────────────────────

export interface CaptionResult {
  ok: boolean;
  options: string[];
  /** Short overlay title from the same Claude call. Null when the model omitted it. */
  headline: string | null;
  /** Up to 2 vetted trade tags from the same Claude call. May be empty. */
  tradeTags: string[];
  unavailable: boolean;
  error: string | null;
}

export function captionWithHeadline(headline: string | null, body: string): string {
  const h = (headline ?? "").replace(/\s+/g, " ").trim();
  const b = body.trim();
  if (!h) return b;
  if (b.toLowerCase().startsWith(h.toLowerCase())) return b;
  return `${h}\n\n${b}`;
}

export async function generateCaptions(env: Env, ctx: CaptionContext): Promise<CaptionResult> {
  const brandVoice = await getBrandVoice(env);
  const res = await claudeMessages(env, {
    system: buildCaptionSystemPrompt(brandVoice),
    messages: [{ role: "user", content: buildCaptionUserPrompt(ctx) }],
    maxTokens: 900,
  });
  if (!res.ok) {
    return { ok: false, options: [], headline: null, tradeTags: [], unavailable: true, error: res.error };
  }
  const parsed = parseGeneratedCopy(res.text);
  if (parsed.captions.length === 0) {
    return { ok: false, options: [], headline: null, tradeTags: [], unavailable: true, error: "no_captions_parsed" };
  }
  return {
    ok: true,
    options: parsed.captions,
    headline: parsed.headline,
    tradeTags: parsed.tradeTags,
    unavailable: false,
    error: null,
  };
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
    system: "You pick two trade hashtags from a fixed pool. Respond ONLY with JSON.",
    messages: [{ role: "user", content: buildHashtagPrompt(ctx, platform, pool) }],
    maxTokens: 200,
  });
  const trade = res.ok ? parseHashtagsForPlatform(res.text, platform) : [];
  return {
    ok: true,
    hashtags: assembleHashtags(cityFromContext(ctx), trade, seed),
    fallback: !res.ok || trade.length < 2,
  };
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
