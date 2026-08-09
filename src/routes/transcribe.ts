/**
 * Shared Gemini transcription upload handler.
 *
 *   POST /api/transcribe
 *     multipart: audio (file), optional mime_type, optional scope (default smart-notes)
 *     → stores raw audio in R2 under voice-notes/{scope}/…, returns { transcript, … }
 *
 * Visit Capture keeps POST /api/estimate-requests/:id/transcribe (same core).
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { putImage } from "../lib/r2.js";
import {
  transcribeAudioViaGemini,
  transcribeConfigured,
  voiceNoteR2Key,
  visitAudioR2Key,
} from "../lib/transcribe.js";

const NOTE_ROLES = ["owner", "project_manager", "field_crew", "office_admin"] as const;
const VISIT_ROLES = ["owner", "project_manager"] as const;

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("aac")) return "aac";
  return "m4a";
}

async function parseAudioForm(request: Request): Promise<
  | { ok: true; form: FormData; audioBlob: Blob; mimeType: string }
  | { ok: false; response: Response }
> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, response: err(400, "invalid_form_data") };
  }

  const audio = form.get("audio") as unknown as Blob | string | null;
  if (!audio || typeof audio === "string" || !(audio as Blob).size) {
    return { ok: false, response: err(400, "audio_required", "Provide multipart field `audio`") };
  }
  const audioBlob = audio as Blob;
  const mimeHint = String(form.get("mime_type") ?? "").trim();
  const mimeType = mimeHint || audioBlob.type || "audio/mp4";
  return { ok: true, form, audioBlob, mimeType };
}

async function storeAndTranscribe(
  env: Env,
  audioBlob: Blob,
  mimeType: string,
  r2Key: string,
  purpose: "visit" | "general",
): Promise<Response> {
  if (!(await transcribeConfigured(env))) {
    return err(503, "google_not_configured", "Vertex AI service account is not configured");
  }

  const bytes = await audioBlob.arrayBuffer();
  const audioId = r2Key.split("/").pop()?.replace(/\.[^.]+$/, "") ?? crypto.randomUUID();

  try {
    await putImage(env, r2Key, bytes, mimeType);
  } catch (e) {
    console.error("[transcribe] R2 put failed:", (e as Error).message);
    return err(500, "r2_failed", "Could not store audio recording");
  }

  const result = await transcribeAudioViaGemini(env, bytes, mimeType, { purpose });
  if (!result.ok) {
    return err(result.status ?? 502, result.error, "Transcription failed; audio was saved");
  }

  return json({
    transcript: result.transcript,
    audio_id: audioId,
    r2_key: r2Key,
    mime_type: mimeType,
  });
}

/** POST /api/transcribe — Smart Notes / general voice (no estimate_request_id). */
export async function handleGeneralTranscribe(
  request: Request,
  env: Env,
): Promise<Response> {
  const guarded = await guard(request, env, [...NOTE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const parsed = await parseAudioForm(request);
  if (!parsed.ok) return parsed.response;

  const scopeRaw = String(parsed.form.get("scope") ?? "smart-notes").trim() || "smart-notes";
  const scope = /^[a-z0-9][a-z0-9_-]{0,62}$/i.test(scopeRaw) ? scopeRaw : "smart-notes";
  const audioId = crypto.randomUUID();
  const r2Key = voiceNoteR2Key(scope, audioId, extFromMime(parsed.mimeType));

  return storeAndTranscribe(env, parsed.audioBlob, parsed.mimeType, r2Key, "general");
}

/** POST /api/estimate-requests/:id/transcribe — Visit Capture contract unchanged. */
export async function handleVisitAudioTranscribe(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...VISIT_ROLES]);
  if (guarded instanceof Response) return guarded;

  const exists = await env.DB.prepare("SELECT id FROM estimate_requests WHERE id = ?")
    .bind(requestId)
    .first<{ id: string }>();
  if (!exists) return err(404, "not_found", "Estimate request not found");

  const parsed = await parseAudioForm(request);
  if (!parsed.ok) return parsed.response;

  const audioId = crypto.randomUUID();
  const r2Key = visitAudioR2Key(requestId, audioId, extFromMime(parsed.mimeType));

  return storeAndTranscribe(env, parsed.audioBlob, parsed.mimeType, r2Key, "visit");
}
