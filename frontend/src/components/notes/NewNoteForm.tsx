import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import {
  cancelGeminiVoiceCapture,
  friendlyVoiceError,
  geminiVoiceAvailable,
  startGeminiVoiceCapture,
  stopGeminiVoiceCapture,
  uploadAndTranscribeAudio,
  type VoiceCaptureMode,
} from "../../lib/voice-transcribe";

interface ActiveJob {
  id: string;
  title: string | null;
  client_name: string | null;
}

const CATEGORIES = [
  { value: "", label: "General" },
  { value: "meeting", label: "Meeting Notes" },
];

export type NewNoteEnteredVia = "quick_capture" | "siri" | "voice" | "text";

export function NewNoteForm({
  initialJobId = null,
  enteredVia = "quick_capture",
  onSaved,
}: {
  /** Prefill when launched from `/app/jobs/:id/*` — skips Claude job match. */
  initialJobId?: string | null;
  enteredVia?: NewNoteEnteredVia;
  onSaved?: (result: { matched: boolean; jobId: string | null }) => void;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [category, setCategory] = useState("");
  const [jobId, setJobId] = useState(initialJobId ?? "");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [enteredViaVoice, setEnteredViaVoice] = useState(false);
  const captureModeRef = useRef<VoiceCaptureMode | null>(null);

  const jobsApi = useApi<{ jobs: ActiveJob[] }>("/api/jobs/active");
  const jobDetailApi = useApi<{ job: { id: string; title: string | null } }>(
    initialJobId ? `/api/jobs/${initialJobId}` : null,
  );

  useEffect(() => {
    if (initialJobId) setJobId(initialJobId);
  }, [initialJobId]);

  const jobOptions = useMemo(() => {
    const jobs = jobsApi.data?.jobs ?? [];
    return [
      { value: "", label: "No job (general note)" },
      ...jobs.map((j) => ({
        value: j.id,
        label: [j.title, j.client_name].filter(Boolean).join(" · ") || j.id,
      })),
    ];
  }, [jobsApi.data]);

  const prefilledTitle = jobDetailApi.data?.job.title ?? "Job";
  const jobLocked = Boolean(initialJobId);

  const appendTranscript = (transcript: string) => {
    const chunk = transcript.trim();
    if (!chunk) {
      toast.push("info", "No speech detected in recording");
      return;
    }
    setText((prev) => (prev.trim() ? `${prev.trim()} ${chunk}` : chunk));
    setEnteredViaVoice(true);
    toast.push("success", "Voice note added");
  };

  const toggleVoice = async () => {
    if (transcribing || busy) return;

    if (recording) {
      setRecording(false);
      const mode = captureModeRef.current;
      captureModeRef.current = null;
      setTranscribing(true);
      try {
        if (!mode) throw new Error("No active recording");
        const { blob, mimeType } = await stopGeminiVoiceCapture(mode);
        const transcript = await uploadAndTranscribeAudio(blob, mimeType, {
          scope: "smart-notes",
        });
        appendTranscript(transcript);
      } catch (err) {
        const raw = err instanceof Error ? err.message : "Transcription failed";
        toast.push("error", friendlyVoiceError(raw, "Transcription failed"));
      } finally {
        setTranscribing(false);
      }
      return;
    }

    if (!geminiVoiceAvailable()) {
      toast.push("error", "Voice capture isn't supported in this browser — type your note.");
      return;
    }

    try {
      const mode = await startGeminiVoiceCapture();
      captureModeRef.current = mode;
      setRecording(true);
    } catch (err) {
      void cancelGeminiVoiceCapture();
      captureModeRef.current = null;
      const msg = err instanceof Error ? err.message : "Could not start recording";
      toast.push("error", msg);
    }
  };

  const save = async (skipAi: boolean) => {
    const content = text.trim();
    if (!content) {
      toast.push("info", "Type a note above first.");
      return;
    }
    if (recording) {
      toast.push("info", "Stop recording before saving.");
      return;
    }
    setBusy(true);
    try {
      const via =
        enteredVia === "siri" || enteredVia === "quick_capture"
          ? enteredVia
          : enteredViaVoice
            ? "voice"
            : "text";
      const selectedJob = jobId.trim() || null;
      const res = await api.post<{
        ai_ok: boolean;
        matched: boolean;
        job_id: string | null;
      }>("/api/smart-notes", {
        raw_content: content,
        entered_via: via,
        category: category || "general",
        job_id: selectedJob,
        // Only auto-match when the user left the job field blank (and not job-context).
        auto_match_job: !selectedJob,
        skip_ai: skipAi,
      });
      toast.push(
        skipAi
          ? "success"
          : res.ai_ok
            ? "success"
            : "info",
        skipAi
          ? "Note saved"
          : res.ai_ok
            ? "Note saved + analyzed by Claude"
            : "Note saved (AI unavailable)",
      );
      setText("");
      setCategory("");
      setEnteredViaVoice(false);
      if (!jobLocked) setJobId("");
      onSaved?.({ matched: res.matched, jobId: res.job_id ?? null });
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const micLabel = transcribing ? "Transcribing…" : recording ? "■ Stop" : "🎤";

  return (
    <div class="new-note-form">
      <textarea
        class="smart-notes__input"
        rows={4}
        value={text}
        placeholder="Type or dictate a note. Leave job blank to auto-match from the text, or pick a job."
        onInput={(e) => {
          setText((e.target as HTMLTextAreaElement).value);
          setEnteredViaVoice(false);
        }}
      />

      <div class="new-note-form__row">
        <label class="new-note-form__field">
          <span class="new-note-form__label">Category</span>
          <select
            class="smart-notes__category"
            value={category}
            onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value || "general"} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label class="new-note-form__field">
          <span class="new-note-form__label">Job</span>
          {jobLocked ? (
            <div class="form-input new-note-form__job-locked">{prefilledTitle}</div>
          ) : (
            <select
              class="smart-notes__category"
              value={jobId}
              onChange={(e) => setJobId((e.target as HTMLSelectElement).value)}
              disabled={jobsApi.loading}
            >
              {jobOptions.map((o) => (
                <option key={o.value || "none"} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </label>
      </div>

      <div class="smart-notes__buttons new-note-form__actions">
        <button
          type="button"
          class={`btn btn--sm ${recording ? "btn--danger" : "btn--secondary"}`}
          disabled={transcribing || busy}
          aria-label={
            transcribing ? "Transcribing" : recording ? "Stop recording" : "Start voice input"
          }
          onClick={() => void toggleVoice()}
        >
          {micLabel}
        </button>
        <button
          type="button"
          class="btn btn--sm btn--primary"
          disabled={busy || recording || transcribing}
          onClick={() => void save(false)}
        >
          {busy ? "Processing…" : "Process with Claude"}
        </button>
        <button
          type="button"
          class="btn btn--sm btn--tertiary"
          disabled={busy || recording || transcribing}
          onClick={() => void save(true)}
        >
          Save Only
        </button>
      </div>
    </div>
  );
}
