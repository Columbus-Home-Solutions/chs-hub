/**
 * Photo capture helpers for the web app (Sprint 8).
 *
 * Mirrors the CHS Capture PWA: downscale a chosen photo to a ~800px JPEG thumb
 * client-side (the Worker can't resize without Cloudflare Images), then upload
 * the full image + thumb to POST /api/photos. GPS is best-effort and optional
 * (business rule #1).
 */

const THUMB_MAX_EDGE = 800;
const THUMB_QUALITY = 0.85;

export interface CaptureMeta {
  job_id?: string | null;
  photo_type?: string;
  caption?: string | null;
  task_id?: string | null;
  daily_log_id?: string | null;
}

/** Downscale a File/Blob to a JPEG thumbnail Blob. Falls back to the original on failure. */
export async function makeThumb(file: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", THUMB_QUALITY),
    );
    return blob ?? file;
  } catch {
    return file;
  }
}

/** Best-effort current position. Resolves to null quickly if denied/unavailable. */
export function getPosition(timeoutMs = 4000): Promise<GeolocationPosition | null> {
  if (!("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 },
    );
  });
}

export interface UploadResult {
  id: string;
  thumb_url: string;
  original_url: string;
  duplicate?: boolean;
}

/** Upload one photo (full + client thumb) to POST /api/photos. */
export async function uploadPhoto(
  file: Blob,
  meta: CaptureMeta,
  opts: { withGps?: boolean } = {},
): Promise<UploadResult> {
  const thumb = await makeThumb(file);
  const form = new FormData();
  form.append("image", file, "capture.jpg");
  form.append("thumb", thumb, "thumb.jpg");
  if (meta.job_id) form.append("job_id", meta.job_id);
  form.append("photo_type", meta.photo_type ?? "job_progress");
  if (meta.caption) form.append("caption", meta.caption);
  if (meta.task_id) form.append("task_id", meta.task_id);
  if (meta.daily_log_id) form.append("daily_log_id", meta.daily_log_id);
  form.append("taken_at", new Date().toISOString());
  form.append("entered_via", "web");
  form.append("capture_uuid", crypto.randomUUID());

  if (opts.withGps) {
    const pos = await getPosition();
    if (pos) {
      form.append("latitude", String(pos.coords.latitude));
      form.append("longitude", String(pos.coords.longitude));
      if (pos.coords.accuracy != null) form.append("location_accuracy", String(pos.coords.accuracy));
    }
  }

  const res = await fetch("/api/photos", { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const data = (await res.json()) as { photo: UploadResult };
  return data.photo;
}

/** Upload a receipt photo to POST /api/photos/receipt → returns photo + receipt extraction. */
export async function uploadReceipt(
  file: Blob,
  meta: CaptureMeta,
): Promise<{ photo: UploadResult; receipt: ReceiptResult }> {
  const form = new FormData();
  form.append("image", file, "receipt.jpg");
  if (meta.job_id) form.append("job_id", meta.job_id);
  form.append("taken_at", new Date().toISOString());
  form.append("entered_via", "web");
  const res = await fetch("/api/photos/receipt", { method: "POST", body: form });
  if (!res.ok) throw new Error(`receipt upload failed: ${res.status}`);
  return res.json();
}

export interface ReceiptResult {
  id: string;
  processing_status: string;
  ai_vendor: string | null;
  ai_amount: number | null;
  ai_date: string | null;
  ai_category: string | null;
  ai_confidence: number | null;
  error?: string | null;
}
