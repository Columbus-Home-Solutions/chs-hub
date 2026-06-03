/**
 * Photo annotation overlay — the JSON↔render contract (Sprint 18, deliverable A).
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH for how a non-destructive photo markup is
 * (a) serialized to photos.annotation_data, (b) re-rendered over the original on
 * the web, and (c) composited into the HTML photo report. Web and report MUST
 * render identically — they both call renderAnnotatedImageSvg() with the same
 * data, so there is exactly one mapping to get right.
 *
 * ── Coordinate contract ──────────────────────────────────────────────────────
 * All shape coordinates are ABSOLUTE PIXELS in the annotation-time image space
 * (`image.width` × `image.height`, the photo's natural pixel size when the user
 * drew). The renderer emits an SVG whose viewBox is that pixel space, so any
 * display size scales the whole overlay UNIFORMLY (aspect-ratio preserved) and
 * the markup lands on exactly the same spot at any zoom, on any device, in the
 * report. Storing absolute px (not normalized) makes the round-trip lossless:
 * what the canvas produced is exactly what we store and re-render.
 *
 * ── Non-destructive (business rule 1) ────────────────────────────────────────
 * The original R2 object is NEVER modified. `crop` is a RENDER-TIME viewBox
 * change only — the pixels outside the crop still exist in the stored original;
 * removing the annotation restores the full image. The annotated image is always
 * recomposited from (original bytes + this JSON).
 */

export const ANNOTATION_VERSION = 1;
export const MAX_SHAPES = 500;
export const MAX_PEN_POINTS = 5000;
export const MAX_TEXT_LEN = 500;

export type AnnotationShape =
  | { type: "pen"; points: Array<[number, number]>; color: string; width: number }
  | { type: "rect"; x: number; y: number; w: number; h: number; color: string; width: number }
  | { type: "ellipse"; cx: number; cy: number; rx: number; ry: number; color: string; width: number }
  | { type: "arrow"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { type: "text"; x: number; y: number; text: string; color: string; size: number }
  | { type: "crop"; x: number; y: number; w: number; h: number };

export interface AnnotationData {
  version: number;
  image: { width: number; height: number };
  shapes: AnnotationShape[];
}

// ─── validation / sanitization ───────────────────────────────────────────────

function n(v: unknown, fallback = 0): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}
/** Clamp + round to keep coordinates sane and the JSON compact. */
function px(v: unknown): number {
  return Math.round(n(v) * 100) / 100; // 2dp — sub-pixel precision, no float noise
}
/** Only allow #rgb / #rrggbb (optionally #rrggbbaa) colors — never arbitrary CSS. */
function color(v: unknown, fallback = "#c8102e"): string {
  const s = String(v ?? "").trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s) ? s : fallback;
}
function strokeWidth(v: unknown): number {
  const w = n(v, 3);
  return Math.min(64, Math.max(1, Math.round(w * 100) / 100));
}

/**
 * Parse + sanitize raw client input (or a stored row) into a canonical
 * AnnotationData, or null if it isn't a usable overlay. Drops unknown shape
 * types, clamps counts, coerces numbers, and whitelists colors — so a hostile
 * or malformed payload can never inject markup into the SVG.
 */
export function validateAnnotationData(raw: unknown): AnnotationData | null {
  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  } else {
    return null;
  }

  const img = (obj.image ?? {}) as Record<string, unknown>;
  const width = Math.max(1, Math.round(n(img.width)));
  const height = Math.max(1, Math.round(n(img.height)));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;

  const rawShapes = Array.isArray(obj.shapes) ? obj.shapes : [];
  const shapes: AnnotationShape[] = [];
  for (const s of rawShapes.slice(0, MAX_SHAPES)) {
    const shape = sanitizeShape(s as Record<string, unknown>);
    if (shape) shapes.push(shape);
  }

  return { version: ANNOTATION_VERSION, image: { width, height }, shapes };
}

function sanitizeShape(s: Record<string, unknown>): AnnotationShape | null {
  switch (s.type) {
    case "pen": {
      const pts = Array.isArray(s.points) ? s.points : [];
      const points: Array<[number, number]> = [];
      for (const p of pts.slice(0, MAX_PEN_POINTS)) {
        if (Array.isArray(p) && p.length >= 2) points.push([px(p[0]), px(p[1])]);
      }
      if (points.length < 2) return null;
      return { type: "pen", points, color: color(s.color), width: strokeWidth(s.width) };
    }
    case "rect":
      return { type: "rect", x: px(s.x), y: px(s.y), w: px(s.w), h: px(s.h), color: color(s.color), width: strokeWidth(s.width) };
    case "ellipse":
      return { type: "ellipse", cx: px(s.cx), cy: px(s.cy), rx: px(s.rx), ry: px(s.ry), color: color(s.color), width: strokeWidth(s.width) };
    case "arrow":
      return { type: "arrow", x1: px(s.x1), y1: px(s.y1), x2: px(s.x2), y2: px(s.y2), color: color(s.color), width: strokeWidth(s.width) };
    case "text": {
      const text = String(s.text ?? "").slice(0, MAX_TEXT_LEN);
      if (!text.trim()) return null;
      const size = Math.min(512, Math.max(8, Math.round(n(s.size, 24))));
      return { type: "text", x: px(s.x), y: px(s.y), text, color: color(s.color, "#ffd400"), size };
    }
    case "crop":
      return { type: "crop", x: px(s.x), y: px(s.y), w: Math.max(1, px(s.w)), h: Math.max(1, px(s.h)) };
    default:
      return null;
  }
}

/** Is there any markup at all (shapes or a crop)? Drives the is_annotated flag. */
export function hasMarkup(data: AnnotationData): boolean {
  return data.shapes.length > 0;
}

// ─── rendering ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The first crop shape, if any, defines the render viewBox (non-destructive). */
function cropOf(data: AnnotationData): { x: number; y: number; w: number; h: number } {
  const c = data.shapes.find((s): s is Extract<AnnotationShape, { type: "crop" }> => s.type === "crop");
  if (c) {
    const w = Math.min(c.w, data.image.width - c.x);
    const h = Math.min(c.h, data.image.height - c.y);
    return { x: Math.max(0, c.x), y: Math.max(0, c.y), w: Math.max(1, w), h: Math.max(1, h) };
  }
  return { x: 0, y: 0, w: data.image.width, h: data.image.height };
}

/** SVG fragment for the markup layer (shapes only; no <image>, no <svg> wrapper). */
export function renderAnnotationShapes(data: AnnotationData): string {
  const parts: string[] = [];
  let arrowDefs = false;
  for (const s of data.shapes) {
    switch (s.type) {
      case "pen": {
        const d = s.points
          .map((p, i) => `${i === 0 ? "M" : "L"}${p[0]} ${p[1]}`)
          .join(" ");
        parts.push(
          `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`,
        );
        break;
      }
      case "rect":
        parts.push(
          `<rect x="${s.x}" y="${s.y}" width="${Math.abs(s.w)}" height="${Math.abs(s.h)}" fill="none" stroke="${s.color}" stroke-width="${s.width}"/>`,
        );
        break;
      case "ellipse":
        parts.push(
          `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${Math.abs(s.rx)}" ry="${Math.abs(s.ry)}" fill="none" stroke="${s.color}" stroke-width="${s.width}"/>`,
        );
        break;
      case "arrow": {
        if (!arrowDefs) {
          parts.unshift(
            `<defs><marker id="chs-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>`,
          );
          arrowDefs = true;
        }
        parts.push(
          `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="round" marker-end="url(#chs-arrow)"/>`,
        );
        break;
      }
      case "text":
        parts.push(
          `<text x="${s.x}" y="${s.y}" fill="${s.color}" font-size="${s.size}" font-family="-apple-system,Segoe UI,Roboto,Arial,sans-serif" font-weight="700" paint-order="stroke" stroke="#00000088" stroke-width="${Math.max(1, s.size / 12)}">${esc(s.text)}</text>`,
        );
        break;
      case "crop":
        break; // crop affects viewBox only (handled by the caller)
    }
  }
  return parts.join("");
}

/**
 * A single, self-contained SVG that composites the original image + the markup
 * overlay (and applies any crop as a viewBox change). Used by BOTH the web
 * annotated-view and the HTML photo report so they render identically.
 *
 * `imageHref` is a URL the consuming document can load (e.g. /api/photos/:id or
 * a portal proxy URL). The original bytes are referenced, never rewritten.
 */
export function renderAnnotatedImageSvg(
  imageHref: string,
  data: AnnotationData,
  opts: { className?: string } = {},
): string {
  const crop = cropOf(data);
  const cls = opts.className ? ` class="${esc(opts.className)}"` : "";
  return (
    `<svg${cls} xmlns="http://www.w3.org/2000/svg" viewBox="${crop.x} ${crop.y} ${crop.w} ${crop.h}" ` +
    `preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">` +
    `<image href="${esc(imageHref)}" x="0" y="0" width="${data.image.width}" height="${data.image.height}" preserveAspectRatio="none"/>` +
    renderAnnotationShapes(data) +
    `</svg>`
  );
}
