/**
 * Shared native/web voice capture → Gemini transcription upload.
 * Used by Smart Notes (and available for other mic surfaces).
 * Visit Capture keeps its own wiring; this reuses the same Capgo + Filesystem path.
 */

import {
  cancelNativeAudioRecording,
  isNativePlatform,
  nativeAudioRecorderAvailable,
  startNativeAudioRecording,
  stopNativeAudioRecording,
} from "./native";

export type VoiceCaptureMode = "native" | "web";

let webRec: MediaRecorder | null = null;
let webChunks: Blob[] = [];

function webMediaRecorderSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

export function geminiVoiceAvailable(): boolean {
  return (
    (isNativePlatform() && nativeAudioRecorderAvailable()) || webMediaRecorderSupported()
  );
}

export async function startGeminiVoiceCapture(): Promise<VoiceCaptureMode> {
  if (isNativePlatform() && nativeAudioRecorderAvailable()) {
    await startNativeAudioRecording();
    return "native";
  }
  if (!webMediaRecorderSupported()) {
    throw new Error("Voice capture isn't supported in this browser — type your note.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "";
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  webChunks = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) webChunks.push(e.data);
  };
  webRec = rec;
  rec.start();
  return "web";
}

export async function stopGeminiVoiceCapture(
  mode: VoiceCaptureMode,
): Promise<{ blob: Blob; mimeType: string }> {
  if (mode === "native") {
    const { blob, mimeType } = await stopNativeAudioRecording();
    return { blob, mimeType };
  }
  return new Promise((resolve, reject) => {
    const rec = webRec;
    if (!rec) {
      reject(new Error("No active recording"));
      return;
    }
    rec.onstop = () => {
      const mimeType = rec.mimeType || "audio/webm";
      const blob = new Blob(webChunks, { type: mimeType });
      webChunks = [];
      webRec = null;
      for (const track of rec.stream.getTracks()) track.stop();
      resolve({ blob, mimeType });
    };
    rec.stop();
  });
}

export async function cancelGeminiVoiceCapture(): Promise<void> {
  void cancelNativeAudioRecording();
  if (webRec) {
    try {
      for (const track of webRec.stream.getTracks()) track.stop();
      webRec.stop();
    } catch {
      /* ignore */
    }
    webRec = null;
    webChunks = [];
  }
}

/**
 * Upload audio to a transcription endpoint and return transcript text.
 * Default: POST /api/transcribe (Smart Notes / general).
 */
export async function uploadAndTranscribeAudio(
  blob: Blob,
  mimeType: string,
  opts?: { url?: string; scope?: string; filename?: string },
): Promise<string> {
  const form = new FormData();
  const ext = mimeType.includes("webm")
    ? "webm"
    : mimeType.includes("wav")
      ? "wav"
      : "m4a";
  form.append("audio", blob, opts?.filename ?? `voice-note.${ext}`);
  form.append("mime_type", mimeType);
  if (opts?.scope) form.append("scope", opts.scope);

  const res = await fetch(opts?.url ?? "/api/transcribe", {
    method: "POST",
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as {
    transcript?: string;
    error?: string;
    details?: string;
  };
  if (!res.ok) {
    throw new Error(data.details || data.error || `Transcription failed (${res.status})`);
  }
  return (data.transcript ?? "").trim();
}

export function friendlyVoiceError(raw: string, fallback: string): string {
  if (raw === "Load failed" || raw === "Failed to fetch") {
    return "Could not upload recording (network/file read failed). Try again.";
  }
  return raw || fallback;
}
