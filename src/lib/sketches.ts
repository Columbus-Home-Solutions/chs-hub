/**
 * Field sketch R2 storage helpers (Sprint 29).
 *
 * Sketch metadata lives in `estimate_requests.sketches` (JSON array).
 * tldraw document JSON and PNG thumbnails live in env.FILES (chs-hub-files).
 */

export interface SketchMeta {
  id: string;
  label: string;
  data_key: string;
  thumbnail_key: string;
  created_at: string;
  updated_at: string;
}

export function sketchDataKey(requestId: string, sketchId: string): string {
  return `sketches/${requestId}/${sketchId}.json`;
}

export function sketchThumbnailKey(requestId: string, sketchId: string): string {
  return `sketches/${requestId}/${sketchId}.thumb.png`;
}

function isSketchMeta(v: unknown): v is SketchMeta {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.label === "string" &&
    typeof o.data_key === "string" &&
    typeof o.thumbnail_key === "string" &&
    typeof o.created_at === "string" &&
    typeof o.updated_at === "string"
  );
}

/** Read all sketch metadata from the DB column. */
export function parseSketches(raw: string | null): SketchMeta[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSketchMeta);
  } catch {
    return [];
  }
}

/** Write tldraw document JSON to R2. */
export async function saveSketchData(
  r2: R2Bucket,
  requestId: string,
  sketchId: string,
  data: string,
): Promise<void> {
  await r2.put(sketchDataKey(requestId, sketchId), new TextEncoder().encode(data), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** Read tldraw document JSON from R2; null when not found. */
export async function getSketchData(
  r2: R2Bucket,
  requestId: string,
  sketchId: string,
): Promise<string | null> {
  const obj = await r2.get(sketchDataKey(requestId, sketchId));
  if (!obj) return null;
  return obj.text();
}

/** Save thumbnail PNG to R2. */
export async function saveSketchThumbnail(
  r2: R2Bucket,
  requestId: string,
  sketchId: string,
  pngBytes: ArrayBuffer,
): Promise<void> {
  await r2.put(sketchThumbnailKey(requestId, sketchId), pngBytes, {
    httpMetadata: { contentType: "image/png" },
  });
}

/** Delete both data and thumbnail from R2 for a sketch. */
export async function deleteSketchFiles(
  r2: R2Bucket,
  requestId: string,
  sketchId: string,
): Promise<void> {
  await Promise.all([
    r2.delete(sketchDataKey(requestId, sketchId)),
    r2.delete(sketchThumbnailKey(requestId, sketchId)),
  ]);
}
