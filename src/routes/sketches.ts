/**
 * Field sketch API — estimate request visit capture (Sprint 29).
 *
 *   GET    /api/estimate-requests/:id/sketches              list metadata
 *   POST   /api/estimate-requests/:id/sketches              create blank slot
 *   PUT    /api/estimate-requests/:id/sketches/:sketchId    save data + optional thumb
 *   GET    /api/estimate-requests/:id/sketches/:sketchId/data       load sketch JSON
 *   GET    /api/estimate-requests/:id/sketches/:sketchId/thumbnail  PNG preview
 *   DELETE /api/estimate-requests/:id/sketches/:sketchId            remove sketch + R2 files
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import {
  deleteSketchFiles,
  getSketchData,
  parseSketches,
  saveSketchData,
  saveSketchThumbnail,
  sketchDataKey,
  sketchThumbnailKey,
  type SketchMeta,
} from "../lib/sketches.js";

const SKETCH_ROLES = ["owner", "project_manager"] as const;
const MAX_SKETCHES = 10;
const MAX_DATA_BYTES = 2 * 1024 * 1024;

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function err(status: number, error: string): Response {
  return json({ error }, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

async function loadRequest(
  env: Env,
  id: string,
): Promise<{ id: string; sketches: string | null } | null> {
  return env.DB.prepare("SELECT id, sketches FROM estimate_requests WHERE id = ?")
    .bind(id)
    .first<{ id: string; sketches: string | null }>();
}

async function saveSketches(env: Env, requestId: string, sketches: SketchMeta[]): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE estimate_requests SET sketches = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(sketches), now, requestId)
    .run();
}

function findSketch(sketches: SketchMeta[], sketchId: string): SketchMeta | undefined {
  return sketches.find((s) => s.id === sketchId);
}

/** GET /api/estimate-requests/:id/sketches */
export async function handleSketchesList(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...SKETCH_ROLES]);
  if (guarded instanceof Response) return guarded;

  const row = await loadRequest(env, requestId);
  if (!row) return err(404, "Estimate request not found");

  return json({ sketches: parseSketches(row.sketches) });
}

/** POST /api/estimate-requests/:id/sketches */
export async function handleSketchCreate(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...SKETCH_ROLES]);
  if (guarded instanceof Response) return guarded;

  const row = await loadRequest(env, requestId);
  if (!row) return err(404, "Estimate request not found");

  const sketches = parseSketches(row.sketches);
  if (sketches.length >= MAX_SKETCHES) {
    return err(400, "Maximum of 10 sketches per request.");
  }

  const body = (await readJson(request)) ?? {};
  const sketchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const label = str(body.label) ?? `Page ${sketches.length + 1}`;

  const sketch: SketchMeta = {
    id: sketchId,
    label,
    data_key: sketchDataKey(requestId, sketchId),
    thumbnail_key: sketchThumbnailKey(requestId, sketchId),
    created_at: now,
    updated_at: now,
  };

  sketches.push(sketch);
  await saveSketches(env, requestId, sketches);

  return json({ sketch }, { status: 201 });
}

/** PUT /api/estimate-requests/:id/sketches/:sketchId */
export async function handleSketchSave(
  request: Request,
  env: Env,
  requestId: string,
  sketchId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...SKETCH_ROLES]);
  if (guarded instanceof Response) return guarded;

  const row = await loadRequest(env, requestId);
  if (!row) return err(404, "Estimate request not found");

  const sketches = parseSketches(row.sketches);
  const index = sketches.findIndex((s) => s.id === sketchId);
  if (index < 0) return err(404, "Sketch not found");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return err(400, "Body must be multipart/form-data");
  }

  const dataEntry = form.get("data");
  if (dataEntry === null) {
    return err(400, "data field is required");
  }

  let data: string;
  if (typeof dataEntry === "string") {
    data = dataEntry;
  } else if (dataEntry instanceof Blob) {
    data = await dataEntry.text();
  } else {
    return err(400, "data field is required");
  }

  const dataBytes = new TextEncoder().encode(data).byteLength;
  if (dataBytes > MAX_DATA_BYTES) {
    return err(413, "Sketch data too large.");
  }

  await saveSketchData(env.FILES, requestId, sketchId, data);

  const thumbnailEntry = form.get("thumbnail");
  if (thumbnailEntry instanceof Blob && thumbnailEntry.size > 0) {
    await saveSketchThumbnail(env.FILES, requestId, sketchId, await thumbnailEntry.arrayBuffer());
  }

  const updatedAt = new Date().toISOString();
  sketches[index] = { ...sketches[index], updated_at: updatedAt };
  await saveSketches(env, requestId, sketches);

  return json({ success: true, updated_at: updatedAt });
}

/** GET /api/estimate-requests/:id/sketches/:sketchId/thumbnail */
export async function handleSketchThumbnailGet(
  request: Request,
  env: Env,
  requestId: string,
  sketchId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...SKETCH_ROLES]);
  if (guarded instanceof Response) return guarded;

  const row = await loadRequest(env, requestId);
  if (!row) return err(404, "Estimate request not found");

  const sketches = parseSketches(row.sketches);
  const sketch = findSketch(sketches, sketchId);
  if (!sketch) return err(404, "Sketch not found");

  const obj = await env.FILES.get(sketch.thumbnail_key);
  if (!obj) return err(404, "Thumbnail not found");

  const headers = new Headers();
  headers.set("Content-Type", "image/png");
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(obj.body, { headers });
}

/** GET /api/estimate-requests/:id/sketches/:sketchId/data */
export async function handleSketchDataGet(
  request: Request,
  env: Env,
  requestId: string,
  sketchId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...SKETCH_ROLES]);
  if (guarded instanceof Response) return guarded;

  const row = await loadRequest(env, requestId);
  if (!row) return err(404, "Estimate request not found");

  const sketches = parseSketches(row.sketches);
  if (!findSketch(sketches, sketchId)) {
    return err(404, "Sketch not found");
  }

  const data = await getSketchData(env.FILES, requestId, sketchId);
  return json({ data });
}

/** DELETE /api/estimate-requests/:id/sketches/:sketchId */
export async function handleSketchDelete(
  request: Request,
  env: Env,
  requestId: string,
  sketchId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...SKETCH_ROLES]);
  if (guarded instanceof Response) return guarded;

  const row = await loadRequest(env, requestId);
  if (!row) return err(404, "Estimate request not found");

  const sketches = parseSketches(row.sketches);
  const next = sketches.filter((s) => s.id !== sketchId);
  if (next.length === sketches.length) {
    return err(404, "Sketch not found");
  }

  await deleteSketchFiles(env.FILES, requestId, sketchId);
  await saveSketches(env, requestId, next);

  return json({ success: true });
}
