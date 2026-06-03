/**
 * Photo annotation overlay — frontend mirror of the worker contract
 * (src/lib/annotation.ts). The shape model + coordinate system MUST match the
 * server so a round-trip (draw → save → reload → render) is lossless and the
 * web view composites identically to the HTML photo report.
 *
 * Coordinates are ABSOLUTE PIXELS in the photo's natural image space
 * (`image.width` × `image.height`). The editor converts pointer coords using the
 * displayed/natural scale factor; the viewer scales the whole SVG uniformly.
 */

export const ANNOTATION_VERSION = 1;

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

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cropOf(d: AnnotationData) {
  const c = d.shapes.find((s): s is Extract<AnnotationShape, { type: "crop" }> => s.type === "crop");
  if (c) {
    const w = Math.min(c.w, d.image.width - c.x);
    const h = Math.min(c.h, d.image.height - c.y);
    return { x: Math.max(0, c.x), y: Math.max(0, c.y), w: Math.max(1, w), h: Math.max(1, h) };
  }
  return { x: 0, y: 0, w: d.image.width, h: d.image.height };
}

/** Markup-only SVG fragment (no <image>, no <svg> wrapper) — shared by editor preview. */
export function renderAnnotationShapes(d: AnnotationData): string {
  const parts: string[] = [];
  let arrowDefs = false;
  for (const s of d.shapes) {
    switch (s.type) {
      case "pen":
        parts.push(
          `<path d="${s.points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]} ${p[1]}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`,
        );
        break;
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
        break;
    }
  }
  return parts.join("");
}

/** Self-contained SVG (image + overlay + crop) — used by the read-only view. */
export function renderAnnotatedImageSvg(imageHref: string, d: AnnotationData): string {
  const crop = cropOf(d);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${crop.x} ${crop.y} ${crop.w} ${crop.h}" ` +
    `preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">` +
    `<image href="${esc(imageHref)}" x="0" y="0" width="${d.image.width}" height="${d.image.height}" preserveAspectRatio="none"/>` +
    renderAnnotationShapes(d) +
    `</svg>`
  );
}

export function emptyAnnotation(width: number, height: number): AnnotationData {
  return { version: ANNOTATION_VERSION, image: { width, height }, shapes: [] };
}
