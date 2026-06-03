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
import { getBrandVoice } from "./social.js";

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

export function buildHashtagPrompt(ctx: CaptionContext): string {
  const topic =
    ctx.kind === "job_completion"
      ? `a completed ${ctx.jobType ?? "home improvement"} project`
      : (ctx as TopicCaptionContext).topic;
  return (
    `Generate 10–15 social hashtags for ${topic}. ` +
    "Mix local central-Arkansas tags (#LittleRock, #NorthLittleRock, #CentralArkansas), " +
    "trade-specific tags (#HomeRemodel, #GarageConversion, #BeforeAndAfter), and general tags " +
    "(#ContractorLife). VARY the selection so repeated posts don't look identical. " +
    'Respond ONLY with JSON of the shape {"hashtags": ["#Tag1", "#Tag2", ...]}.'
  );
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
): Promise<HashtagResult> {
  const res = await claudeMessages(env, {
    system: "You generate social media hashtags. Respond ONLY with JSON.",
    messages: [{ role: "user", content: buildHashtagPrompt(ctx) }],
    maxTokens: 300,
  });
  if (res.ok) {
    const tags = parseHashtags(res.text);
    if (tags.length >= 8) return { ok: true, hashtags: tags, fallback: false };
  }
  const jobType = ctx.kind === "job_completion" ? ctx.jobType : null;
  return { ok: true, hashtags: fallbackHashtags(seed, jobType), fallback: true };
}

/** Build the image-generation prompt for a non-job post from its topic. */
export function buildImagePrompt(ctx: TopicCaptionContext): string {
  return (
    `A clean, professional, photorealistic image for a home-improvement social post about ${ctx.topic}` +
    (ctx.season ? ` (${ctx.season})` : "") +
    ". Bright natural lighting, residential setting, no text overlays, no watermarks."
  );
}

export { CTA };
