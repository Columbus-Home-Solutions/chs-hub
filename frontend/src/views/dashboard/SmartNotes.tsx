import { useRef, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatDateTime } from "../../lib/format";
import {
  cancelGeminiVoiceCapture,
  friendlyVoiceError,
  geminiVoiceAvailable,
  startGeminiVoiceCapture,
  stopGeminiVoiceCapture,
  uploadAndTranscribeAudio,
  type VoiceCaptureMode,
} from "../../lib/voice-transcribe";

interface SmartNote {
  id: string;
  job_id: string | null;
  raw_content: string;
  ai_summary: string | null;
  ai_category: string | null;
  processing_status: string | null;
  ai_extracted_tasks: { title: string }[];
  created_at: string;
}

const CATEGORIES = [
  { value: "", label: "General" },
  { value: "meeting", label: "Meeting Notes" },
];

export function SmartNotes() {
  const toast = useToast();
  const { data, loading, refetch } = useApi<{ notes: SmartNote[] }>(
    "/api/smart-notes?limit=3",
  );
  const notes = data?.notes?.slice(0, 3) ?? [];

  const [text, setText] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [notesCollapsed, setNotesCollapsed] = useState(true);
  const [enteredViaVoice, setEnteredViaVoice] = useState(false);
  const captureModeRef = useRef<VoiceCaptureMode | null>(null);

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

  const processNote = async () => {
    const content = text.trim();
    if (!content) {
      toast.push("info", "Type a note above first.");
      return;
    }
    if (recording) {
      toast.push("info", "Stop recording before processing.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ ai_ok: boolean }>("/api/smart-notes", {
        raw_content: content,
        entered_via: enteredViaVoice ? "voice" : "text",
        category: category || "general",
      });
      toast.push(
        res.ai_ok ? "success" : "info",
        res.ai_ok ? "Note saved + analyzed by Claude" : "Note saved (AI unavailable)",
      );
      setText("");
      setCategory("");
      setEnteredViaVoice(false);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveOnly = async () => {
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
      await api.post("/api/smart-notes", {
        raw_content: content,
        entered_via: enteredViaVoice ? "voice" : "text",
        category: category || "general",
        skip_ai: true,
      });
      toast.push("success", "Note saved");
      setText("");
      setCategory("");
      setEnteredViaVoice(false);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const micLabel = transcribing
    ? "Transcribing…"
    : recording
      ? "■ Stop"
      : "🎤";

  return (
    <div class="dash-card">
      <div class="dash-card__header">
        <h2 class="dash-card__title">Smart Notes</h2>
      </div>
      <div class="dash-card__body">
        <textarea
          class="smart-notes__input"
          rows={3}
          value={text}
          placeholder="Write your notes here. Claude will summarize, extract tasks, and save everything automatically."
          onInput={(e) => {
            setText((e.target as HTMLTextAreaElement).value);
            setEnteredViaVoice(false);
          }}
        />

        <div class="smart-notes__controls">
          <select
            class="smart-notes__category"
            value={category}
            onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>

          <div class="smart-notes__buttons">
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
              onClick={() => void processNote()}
            >
              {busy ? "Processing…" : "Process with Claude"}
            </button>
            <button
              type="button"
              class="btn btn--sm btn--tertiary"
              disabled={busy || recording || transcribing}
              onClick={() => void saveOnly()}
            >
              Save Only
            </button>
          </div>
        </div>

        {/* Recent notes — collapsible */}
        <div
          style={{
            marginTop: "var(--space-sm)",
            borderTop: "1px solid var(--color-border)",
            paddingTop: "var(--space-xs)",
          }}
        >
          <button
            class="link-btn"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-xs)",
              fontSize: "var(--text-sm)",
              color: "var(--color-text-muted)",
              width: "100%",
              textAlign: "left",
              padding: "var(--space-xs) 0",
            }}
            onClick={() => setNotesCollapsed((v) => !v)}
          >
            <span
              style={{
                transition: "transform 0.2s",
                display: "inline-block",
                transform: notesCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
              }}
            >
              ▾
            </span>
            Recent Notes
            {notes.length > 0 && (
              <span style={{ marginLeft: "auto", opacity: 0.6 }}>{notes.length}</span>
            )}
          </button>

          {!notesCollapsed && (
            loading ? (
              <div class="smart-notes__recent--skeleton" aria-hidden="true" />
            ) : notes.length === 0 ? (
              <div class="smart-notes__empty">No notes yet — capture a thought above.</div>
            ) : (
              <div class="smart-notes__recent">
                {notes.map((n) => (
                  <div key={n.id} class="smart-note-preview">
                    <div class="smart-note-preview__meta">
                      <span class="smart-note-preview__time">{formatDateTime(n.created_at)}</span>
                      {n.ai_extracted_tasks?.length > 0 && (
                        <span class="smart-note-preview__tasks">
                          {n.ai_extracted_tasks.length} task{n.ai_extracted_tasks.length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <div class="smart-note-preview__summary">
                      {n.ai_summary ?? n.raw_content.slice(0, 80)}
                      {!n.ai_summary && n.raw_content.length > 80 ? "…" : ""}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
