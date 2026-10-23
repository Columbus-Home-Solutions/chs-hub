/**
 * Branded 1080×1080 review card. The quote is the customer's words
 * (whitespace-normalized) or a truncation of them. Nothing is paraphrased.
 *
 * Type steps down before any cut. A cut ends on a complete sentence when one
 * fits; otherwise it ends on a whole word. An ellipsis marks either cut.
 */

import opentype from "opentype.js";

export const REVIEW_CARD_SIZE = 1080;
/** Largest quote size, then smaller steps. Floor stays readable on a phone. */
export const REVIEW_CARD_FONT_STEPS = [46, 40, 34, 28] as const;
export const REVIEW_CARD_QUOTE_WIDTH = 880;
export const REVIEW_CARD_QUOTE_TOP = 210;
export const REVIEW_CARD_QUOTE_BOTTOM = 760;
export const REVIEW_CARD_LINE_HEIGHT = 1.36;
/** Instagram caption limit (caption + hashtags). Facebook's is far higher. */
export const INSTAGRAM_CAPTION_LIMIT = 2200;
export const FACEBOOK_CAPTION_LIMIT = 63206;

const BUSINESS_NAME =
  /\b(llc|l\.l\.c\.|inc|corp|co|company|services|solutions|roofing|construction|contracting|plumbing|electric|homes|group)\b/i;
const NAME_SUFFIX = /^(jr|sr|ii|iii|iv|v)$/i;

export interface TextMeasurer {
  width(text: string, fontSize: number, family: "body" | "display"): number;
  bodyFamily: string;
  displayFamily: string;
}

export interface ReviewCardInput {
  reviewerName: string;
  commentText: string | null;
  starRating: number;
}

export interface ReviewCardPlan {
  displayName: string;
  /** Whitespace-normalized comment. This is what the caption must carry when truncated. */
  fullText: string;
  /** Exact card quote: fullText, or a prefix of it plus an ellipsis. */
  cardText: string;
  truncated: boolean;
  fontSize: number;
  lines: string[];
  starRating: number;
}

export function normalizeReviewText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** True when there is customer text to put on a card. */
export function loadableReviewText(text: string | null | undefined): boolean {
  return Boolean(text && normalizeReviewText(text));
}

/** First name + last initial. One word, a business, or a name that does not split stays as written. */
export function reviewDisplayName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return "A customer";
  if (BUSINESS_NAME.test(name) || /\d/.test(name) || /[&@]/.test(name)) return name;
  const parts = name.split(" ");
  if (parts.length < 2) return name;
  const suffix = parts[parts.length - 1]!.replace(/\.$/, "");
  if (NAME_SUFFIX.test(suffix)) return name;
  const last = suffix;
  const leading = parts[0]!;
  if (!/^[A-Za-z][A-Za-z'’.-]*$/.test(last) || !/^[A-Za-z][A-Za-z'’.-]*$/.test(leading)) {
    return name;
  }
  const first = parts.slice(0, -1).join(" ");
  if (last.length === 1) return `${first} ${last.toUpperCase()}.`;
  return `${first} ${last[0]!.toUpperCase()}.`;
}

function quoteHeight(): number {
  return REVIEW_CARD_QUOTE_BOTTOM - REVIEW_CARD_QUOTE_TOP;
}

function wrapLines(text: string, fontSize: number, measure: TextMeasurer): string[] {
  const words = text.split(" ").filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (measure.width(next, fontSize, "body") <= REVIEW_CARD_QUOTE_WIDTH) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fits(lines: string[], fontSize: number): boolean {
  if (lines.length === 0) return false;
  return lines.length * fontSize * REVIEW_CARD_LINE_HEIGHT <= quoteHeight();
}

function withEllipsis(prefix: string): string {
  return `${prefix.replace(/\s+$/u, "")}…`;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/u).filter((part) => part.length > 0);
}

function fitWordPrefix(text: string, fontSize: number, measure: TextMeasurer): string {
  const words = text.split(" ").filter((w) => w.length > 0);
  let best = 1;
  let lo = 1;
  let hi = words.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = withEllipsis(words.slice(0, mid).join(" "));
    const lines = wrapLines(candidate, fontSize, measure);
    if (fits(lines, fontSize)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return withEllipsis(words.slice(0, best).join(" "));
}

/**
 * Null when the review has no written comment. A star rating alone does not get a card.
 */
export function planReviewCard(input: ReviewCardInput, measure: TextMeasurer): ReviewCardPlan | null {
  const fullText = input.commentText ? normalizeReviewText(input.commentText) : "";
  if (!fullText) return null;
  const displayName = reviewDisplayName(input.reviewerName);
  const starRating = Math.max(0, Math.min(5, Math.round(input.starRating)));
  const steps = REVIEW_CARD_FONT_STEPS;

  for (const fontSize of steps) {
    const lines = wrapLines(fullText, fontSize, measure);
    if (fits(lines, fontSize)) {
      return { displayName, fullText, cardText: fullText, truncated: false, fontSize, lines, starRating };
    }
  }

  const fontSize = steps[steps.length - 1]!;
  const parts = sentences(fullText);
  if (parts.length > 1) {
    for (let count = parts.length - 1; count >= 1; count -= 1) {
      const cardText = withEllipsis(parts.slice(0, count).join(" "));
      const lines = wrapLines(cardText, fontSize, measure);
      if (fits(lines, fontSize)) {
        return { displayName, fullText, cardText, truncated: true, fontSize, lines, starRating };
      }
    }
  }

  const cardText = fitWordPrefix(fullText, fontSize, measure);
  return {
    displayName,
    fullText,
    cardText,
    truncated: true,
    fontSize,
    lines: wrapLines(cardText, fontSize, measure),
    starRating,
  };
}

function fontFamilyName(font: ReturnType<typeof opentype.parse>, fallback: string): string {
  return font.names.windows?.fontFamily?.en || font.names.fontFamily?.en || fallback;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function measurerFromFonts(body: Uint8Array, display: Uint8Array): TextMeasurer {
  const bodyFont = opentype.parse(toArrayBuffer(body));
  const displayFont = opentype.parse(toArrayBuffer(display));
  return {
    bodyFamily: fontFamilyName(bodyFont, "DM Sans"),
    displayFamily: fontFamilyName(displayFont, "Outfit"),
    width(text, fontSize, family) {
      const font = family === "display" ? displayFont : bodyFont;
      return font.getAdvanceWidth(text, fontSize);
    },
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function starPoints(cx: number, cy: number, radius: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? radius : radius * 0.42;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`);
  }
  return pts.join(" ");
}

/** SVG for a planned card. The quote element is the customer's text only. */
export function buildReviewCardSvg(plan: ReviewCardPlan, logo: Uint8Array, measure: TextMeasurer): string {
  const size = REVIEW_CARD_SIZE;
  const lineHeight = plan.fontSize * REVIEW_CARD_LINE_HEIGHT;
  const blockHeight = plan.lines.length * lineHeight;
  const region = quoteHeight();
  const textTop = REVIEW_CARD_QUOTE_TOP + Math.max(0, (region - blockHeight) / 2);
  const anchorX = (size - REVIEW_CARD_QUOTE_WIDTH) / 2;
  const tspans = plan.lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : lineHeight;
      return `<tspan x="${anchorX}" dy="${dy.toFixed(1)}">${xmlEscape(line)}</tspan>`;
    })
    .join("");

  const starRadius = 26;
  const starGap = 72;
  const starY = 132;
  const starStart = size / 2 - ((5 - 1) * starGap) / 2;
  const stars = Array.from({ length: 5 }, (_, index) => {
    const filled = index < plan.starRating;
    const cx = starStart + index * starGap;
    const points = starPoints(cx, starY, starRadius);
    if (filled) {
      return `<polygon data-fill="1" points="${points}" fill="#f59e0b" stroke="#f59e0b" stroke-width="2" stroke-linejoin="round"/>`;
    }
    return `<polygon data-fill="0" points="${points}" fill="none" stroke="#f59e0b" stroke-width="3" stroke-linejoin="round"/>`;
  }).join("");

  const logoPx = pngSize(logo);
  const logoHeight = 148;
  const logoWidth = Math.round((logoPx.width / logoPx.height) * logoHeight);
  const logoX = Math.round((size - logoWidth) / 2);
  const logoY = 900;
  const logoHref = `data:image/png;base64,${bytesToBase64(logo)}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#0f172a"/>
  <rect x="44" y="44" width="992" height="992" rx="28" fill="#111827"/>
  <rect x="36" y="36" width="1008" height="1008" rx="32" fill="none" stroke="#f59e0b" stroke-width="8"/>
  ${stars}
  <text x="${anchorX}" y="${(textTop - 8).toFixed(1)}" font-family="${xmlEscape(measure.bodyFamily)}" font-size="64" fill="#f59e0b">“</text>
  <text id="review-body" x="${anchorX}" y="${(textTop + plan.fontSize).toFixed(1)}" font-family="${xmlEscape(measure.bodyFamily)}" font-size="${plan.fontSize}" fill="#f1f5f9">${tspans}</text>
  <text id="reviewer-name" x="${size / 2}" y="824" text-anchor="middle" font-family="${xmlEscape(measure.displayFamily)}" font-size="34" fill="#f59e0b">${xmlEscape(plan.displayName)}</text>
  <text id="google-review-label" x="${size / 2}" y="868" text-anchor="middle" font-family="${xmlEscape(measure.bodyFamily)}" font-size="20" fill="#94a3b8">Google Review</text>
  <image id="chs-logo" href="${logoHref}" x="${logoX}" y="${logoY}" width="${logoWidth}" height="${logoHeight}"/>
</svg>`;
}

export function reviewBodyFromSvg(svg: string): string {
  const match = svg.match(/<text id="review-body"[^>]*>([\s\S]*?)<\/text>/);
  if (!match) return "";
  const parts = [...match[1].matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((item) =>
    item[1]!
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&"),
  );
  return parts.join(" ");
}

/** Caption that carries the full review when the card had to truncate it. */
export function captionForReview(args: {
  displayName: string;
  starRating: number;
  plan: ReviewCardPlan | null;
  generatedCaption: string | null;
  reviewerName: string;
}): string {
  if (args.plan?.truncated) {
    return `${args.displayName} left a ${args.starRating}-star Google review.\n\n“${args.plan.fullText}”`;
  }
  const generated = args.generatedCaption?.trim() || "";
  if (!generated) {
    const quote = args.plan?.fullText ? `: “${args.plan.fullText.slice(0, 280)}”` : "";
    return `${args.displayName} left a ${args.starRating}-star review${quote}. Free estimates — call us!`;
  }
  if (args.displayName !== args.reviewerName.trim().replace(/\s+/g, " ")) {
    return generated.split(args.reviewerName).join(args.displayName);
  }
  return generated;
}

export function captionExceedsInstagram(caption: string, hashtags: string[]): boolean {
  const tags = hashtags.filter(Boolean).join(" ");
  const composed = tags ? `${caption}\n\n${tags}` : caption;
  return composed.length > INSTAGRAM_CAPTION_LIMIT;
}

export function composedCaptionLength(caption: string, hashtags: string[]): number {
  const tags = hashtags.filter(Boolean).join(" ");
  return tags ? `${caption}\n\n${tags}`.length : caption.length;
}
