/**
 * Visit Capture voice notes — thin wrapper around shared transcription.
 *
 *   POST /api/estimate-requests/:id/transcribe
 *     → same contract as before; implementation lives in routes/transcribe.ts
 */

export { handleVisitAudioTranscribe } from "./transcribe.js";
