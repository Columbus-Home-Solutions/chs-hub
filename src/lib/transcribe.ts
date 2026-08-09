/**
 * Visit-note audio transcription via Gemini on Vertex AI.
 *
 * Reuses the same service-account OAuth flow as Imagen (`google-auth.ts` +
 * `resolveGoogleServiceAccount`). Inline base64 audio (Vertex/Gemini inline
 * request ceiling ~20 MB — fine for short field voice notes).
 */

import type { Env } from "../env.js";
import { getGoogleAccessToken } from "./google-auth.js";
import { resolveGoogleServiceAccount } from "./image-gen.js";

/** Flash model with audio understanding on Vertex (us-central1). */
export const TRANSCRIBE_MODEL = "gemini-2.5-flash";
const VERTEX_LOCATION = "us-central1";

const DEFAULT_TRANSCRIBE_PROMPT =
  "Transcribe this voice note verbatim. " +
  "Return only the spoken words as plain text — no timestamps, no speaker labels, " +
  "no commentary, no markdown. If the audio is silent or unintelligible, return an empty string.";

const VISIT_TRANSCRIBE_PROMPT =
  "Transcribe this construction site visit voice note verbatim. " +
  "Return only the spoken words as plain text — no timestamps, no speaker labels, " +
  "no commentary, no markdown. If the audio is silent or unintelligible, return an empty string.";

/** R2 key for visit-capture audio (linked to an estimate request). Unchanged path. */
export function visitAudioR2Key(requestId: string, audioId: string, ext: string): string {
  const safeExt = ext.replace(/^\./, "").toLowerCase() || "m4a";
  return `visit-audio/${requestId}/${audioId}.${safeExt}`;
}

/**
 * R2 key for general voice notes (Smart Notes, etc.).
 * Scope is a simple slug like `smart-notes` — not tied to an estimate request.
 */
export function voiceNoteR2Key(scope: string, audioId: string, ext: string): string {
  const safeExt = ext.replace(/^\./, "").toLowerCase() || "m4a";
  const safeScope = scope.replace(/^\/+|\/+$/g, "").replace(/\.\./g, "") || "general";
  return `voice-notes/${safeScope}/${audioId}.${safeExt}`;
}

export async function transcribeConfigured(env: Env): Promise<boolean> {
  return resolveGoogleServiceAccount(env) !== null;
}

export type TranscribeResult =
  | { ok: true; transcript: string }
  | { ok: false; error: string; status?: number };

/**
 * Send audio bytes to Gemini generateContent on Vertex AI and return transcript text.
 */
export async function transcribeAudioViaGemini(
  env: Env,
  audioBytes: ArrayBuffer,
  mimeType: string,
  opts?: { prompt?: string; purpose?: "visit" | "general" },
): Promise<TranscribeResult> {
  const creds = resolveGoogleServiceAccount(env);
  if (!creds) {
    return { ok: false, error: "google_not_configured", status: 503 };
  }

  const maxBytes = 18 * 1024 * 1024; // stay under ~20 MB total request ceiling
  if (audioBytes.byteLength === 0) {
    return { ok: false, error: "empty_audio", status: 400 };
  }
  if (audioBytes.byteLength > maxBytes) {
    return { ok: false, error: "audio_too_large", status: 413 };
  }

  const prompt =
    opts?.prompt ??
    (opts?.purpose === "visit" ? VISIT_TRANSCRIBE_PROMPT : DEFAULT_TRANSCRIBE_PROMPT);

  try {
    const accessToken = await getGoogleAccessToken(
      creds.clientEmail,
      creds.privateKey,
      "https://www.googleapis.com/auth/cloud-platform",
    );

    const endpoint =
      `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/` +
      `${creds.projectId}/locations/${VERTEX_LOCATION}/publishers/google/` +
      `models/${TRANSCRIBE_MODEL}:generateContent`;

    const b64 = arrayBufferToBase64(audioBytes);
    const mime = normalizeAudioMime(mimeType);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: mime, data: b64 } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[transcribe] Vertex failed ${response.status}:`, errText.slice(0, 500));
      return {
        ok: false,
        error: `vertex_failed_${response.status}`,
        status: 502,
      };
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join("")
        .trim() ?? "";

    return { ok: true, transcript: text };
  } catch (e) {
    console.error("[transcribe] error:", (e as Error).message);
    return { ok: false, error: (e as Error).message, status: 500 };
  }
}

function normalizeAudioMime(raw: string): string {
  const m = (raw || "").trim().toLowerCase();
  if (!m) return "audio/mp4";
  if (m === "audio/m4a" || m === "audio/x-m4a") return "audio/mp4";
  if (m === "audio/mp3") return "audio/mpeg";
  if (m.startsWith("audio/")) return m;
  return "audio/mp4";
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
