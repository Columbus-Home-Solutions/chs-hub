import { useRef, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatDateTime } from "../../lib/format";

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

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
};

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
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  const toggleVoice = () => {
    const Ctor =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
        .webkitSpeechRecognition;
    if (!Ctor) {
      toast.push("error", "Voice capture isn't supported in this browser — type your note.");
      return;
    }
    if (recording) {
      recRef.current?.stop();
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let chunk = "";
      for (let i = 0; i < e.results.length; i++) chunk += e.results[i][0].transcript + " ";
      setText((prev) => (prev ? prev + " " : "") + chunk.trim());
    };
    rec.onend = () => {
      setRecording(false);
      recRef.current = null;
    };
    recRef.current = rec;
    rec.start();
    setRecording(true);
  };

  const processNote = async () => {
    const content = text.trim();
    if (!content) return;
    if (recording) recRef.current?.stop();
    setBusy(true);
    try {
      const res = await api.post<{ ai_ok: boolean }>("/api/smart-notes", {
        raw_content: content,
        entered_via: recording ? "voice" : "text",
        category: category || "general",
      });
      toast.push(
        res.ai_ok ? "success" : "info",
        res.ai_ok ? "Note saved + analyzed by Claude" : "Note saved (AI unavailable)",
      );
      setText("");
      setCategory("");
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveOnly = async () => {
    const content = text.trim();
    if (!content) return;
    if (recording) recRef.current?.stop();
    setBusy(true);
    try {
      await api.post("/api/smart-notes", {
        raw_content: content,
        entered_via: "text",
        category: category || "general",
        skip_ai: true,
      });
      toast.push("success", "Note saved");
      setText("");
      setCategory("");
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
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
              class={`btn btn--sm ${recording ? "btn--danger" : "btn--secondary"}`}
              onClick={toggleVoice}
            >
              {recording ? "■ Stop" : "🎤"}
            </button>
            <button
              class="btn btn--sm btn--primary"
              disabled={busy || !text.trim()}
              onClick={processNote}
            >
              {busy ? "Processing…" : "Process with Claude"}
            </button>
            <button
              class="btn btn--sm btn--tertiary"
              disabled={busy || !text.trim()}
              onClick={saveOnly}
            >
              Save Only
            </button>
          </div>
        </div>

        {loading ? (
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
        )}
      </div>
    </div>
  );
}
