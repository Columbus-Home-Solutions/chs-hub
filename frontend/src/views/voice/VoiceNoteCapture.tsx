/**
 * Global voice note capture (Sprint 33).
 * Route: /app/voice-note (?job_id= optional)
 */

import { useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useApi } from "../../hooks/useApi";
import { useSpeechRecognition } from "../../lib/speech-recognition";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import "../../styles/voice-note.css";

const VOICE_NOTE_URL = "https://dashboard.homesolutionsar.com/app/voice-note";

interface ActiveJob {
  id: string;
  title: string | null;
  client_name: string | null;
  address: string | null;
}

type Phase = "capture" | "saving" | "saved";

export function VoiceNoteCapture() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const prefilledJobId = query.get("job_id");
  const fromQuickCapture = Boolean(prefilledJobId);

  const [transcript, setTranscript] = useState("");
  const [selectedJobId, setSelectedJobId] = useState(prefilledJobId ?? "");
  const [phase, setPhase] = useState<Phase>("capture");
  const [saveResult, setSaveResult] = useState<{
    matched: boolean;
    jobTitle: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const jobsApi = useApi<{ jobs: ActiveJob[] }>("/api/jobs/active");
  const jobDetailApi = useApi<{ job: { id: string; title: string | null } }>(
    prefilledJobId ? `/api/jobs/${prefilledJobId}` : null,
  );

  const appendFinal = (chunk: string) => {
    setTranscript((prev) => (prev.trim() ? `${prev.trim()} ${chunk.trim()}` : chunk.trim()));
  };

  const { recording, interimTranscript, micDenied, supported, toggleRecording, flushAndStop } =
    useSpeechRecognition(appendFinal);

  const prefilledTitle = jobDetailApi.data?.job.title ?? "Job";

  const jobOptions = useMemo(() => {
    const jobs = jobsApi.data?.jobs ?? [];
    return [
      { value: "", label: "Select job (or leave blank)" },
      ...jobs.map((j) => ({
        value: j.id,
        label: [j.title, j.client_name].filter(Boolean).join(" · ") || j.id,
      })),
    ];
  }, [jobsApi.data]);

  useEffect(() => {
    if (prefilledJobId) setSelectedJobId(prefilledJobId);
  }, [prefilledJobId]);

  const displayTranscript =
    transcript + (interimTranscript ? (transcript ? " " : "") + interimTranscript : "");

  const canSave = displayTranscript.trim().length > 0 && phase === "capture";

  const save = async () => {
    if (!canSave && !transcript.trim() && !interimTranscript.trim() && !recording) return;
    setPhase("saving");
    setError(null);
    let finalText = transcript.trim();
    if (recording) {
      const chunk = flushAndStop();
      if (chunk) finalText = finalText ? `${finalText} ${chunk}` : chunk;
    } else if (interimTranscript.trim()) {
      finalText = finalText ? `${finalText} ${interimTranscript.trim()}` : interimTranscript.trim();
    }
    if (!finalText) {
      setPhase("capture");
      return;
    }
    const jobId = selectedJobId || null;
    try {
      const res = await api.post<{
        note_id: string;
        job_id: string | null;
        matched: boolean;
      }>("/api/voice-notes", {
        transcript: finalText,
        job_id: jobId,
        entered_via: fromQuickCapture ? "quick_capture" : "siri",
      });

      let jobTitle: string | null = null;
      if (res.job_id) {
        const match = jobsApi.data?.jobs.find((j) => j.id === res.job_id);
        jobTitle = match?.title ?? prefilledTitle ?? null;
        if (!jobTitle && res.job_id) {
          try {
            const j = await api.get<{ job: { title: string | null } }>(`/api/jobs/${res.job_id}`);
            jobTitle = j.job.title;
          } catch {
            jobTitle = null;
          }
        }
      }

      setSaveResult({ matched: res.matched, jobTitle });
      setPhase("saved");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setPhase("capture");
    }
  };

  if (phase === "saved" && saveResult) {
    return (
      <div class="voice-capture">
        <div class="voice-capture__saved">
          <div class="voice-capture__saved-icon">✓</div>
          <h1 class="view-title">
            {saveResult.matched
              ? `Note saved and attached to ${saveResult.jobTitle ?? "job"}`
              : "Note saved"}
          </h1>
          {!saveResult.matched && (
            <p class="text--muted" style={{ marginBottom: "var(--space-lg)" }}>
              We couldn't match this note to a job automatically.
            </p>
          )}
          <div class="flex gap-sm justify-center" style={{ flexWrap: "wrap" }}>
            {!saveResult.matched && (
              <Button variant="primary" onClick={() => go("/voice-notes/unmatched")}>
                Assign a job
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                setTranscript("");
                setSaveResult(null);
                setPhase("capture");
              }}
            >
              Record another
            </Button>
            <Button variant="tertiary" onClick={() => go("/")}>
              Done
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="voice-capture">
      <div class="voice-capture__header">
        <Button variant="tertiary" onClick={() => (history.length > 1 ? history.back() : go("/"))}>
          ← Back
        </Button>
        <h1 class="view-title" style={{ margin: 0, fontSize: "1.1rem" }}>
          New Voice Note
        </h1>
        <span style={{ width: "4rem" }} />
      </div>

      <div class="voice-capture__mic-wrap">
        <button
          type="button"
          class={`voice-capture__mic${recording ? " voice-capture__mic--recording" : ""}`}
          onClick={toggleRecording}
          disabled={!supported || phase === "saving"}
          aria-label={recording ? "Stop recording" : "Start recording"}
        >
          🎤
        </button>
        <p class="voice-capture__hint">
          {!supported
            ? "Voice isn't supported in this browser — type your note below."
            : recording
              ? "Recording… tap to stop"
              : "Tap to record"}
        </p>
      </div>

      {micDenied && (
        <div class="callout callout--warning" style={{ marginBottom: "var(--space-md)" }}>
          Microphone access was denied. Enable the mic in browser settings or type your note below.
        </div>
      )}

      <FormField label="Transcript">
        <textarea
          class={`voice-capture__transcript${recording ? " voice-capture__transcript--recording" : ""}`}
          rows={6}
          value={displayTranscript}
          placeholder="Your words appear here as you speak…"
          onInput={(e) => {
            if (!recording) setTranscript((e.target as HTMLTextAreaElement).value);
          }}
          readOnly={recording}
        />
        {recording && interimTranscript && (
          <p class="voice-capture__interim text--muted">{interimTranscript}</p>
        )}
      </FormField>

      <div class="voice-capture__job">
        {prefilledJobId ? (
          <FormField label="Job">
            <div class="form-input" style={{ background: "var(--color-surface-muted)" }}>
              Job: {prefilledTitle}
            </div>
          </FormField>
        ) : (
          <FormField label="Job">
            <Select
              value={selectedJobId}
              options={jobOptions}
              onChange={setSelectedJobId}
            />
          </FormField>
        )}
      </div>

      {error && <div class="callout callout--warning">{error}</div>}

      <div class="voice-capture__footer">
        <Button
          variant="primary"
          disabled={!canSave || phase === "saving"}
          onClick={save}
          style={{ width: "100%", minHeight: "48px", fontSize: "1.05rem" }}
        >
          {phase === "saving" ? "Saving…" : "Save Note"}
        </Button>
      </div>
    </div>
  );
}

export { VOICE_NOTE_URL };
