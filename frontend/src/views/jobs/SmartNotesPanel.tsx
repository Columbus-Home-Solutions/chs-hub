import { useRef, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatDateTime } from "../../lib/format";

interface ExtractedTask { title: string; task_group?: string | null }
interface ExtractedExpense { vendor: string | null; amount: number | null; category: string | null; description: string | null }
interface ExtractedCO { title: string | null; description: string | null; amount: number | null }
interface SmartNote {
  id: string;
  job_id: string | null;
  raw_content: string;
  ai_summary: string | null;
  ai_category: string | null;
  ai_extracted_tasks: ExtractedTask[];
  ai_extracted_expense: ExtractedExpense | null;
  ai_extracted_change_order: ExtractedCO | null;
  processing_status: string | null;
  created_at: string;
}

const CAT_TONE: Record<string, "neutral" | "info" | "success" | "warning"> = {
  task: "info",
  expense: "warning",
  change_order: "warning",
  scheduling: "info",
  client_communication: "neutral",
  general: "neutral",
};

// Minimal Web Speech typing (browser-only; carries forward the PWA approach).
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
};

export function SmartNotesPanel({ jobId }: { jobId: string }) {
  const toast = useToast();
  const { data, loading, refetch } = useApi<{ notes: SmartNote[] }>(`/api/smart-notes?job_id=${jobId}`);
  const notes = data?.notes ?? [];

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  const toggleVoice = () => {
    const Ctor =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
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
    rec.onend = () => { setRecording(false); recRef.current = null; };
    recRef.current = rec;
    rec.start();
    setRecording(true);
  };

  const save = async () => {
    const content = text.trim();
    if (!content) return;
    if (recording) recRef.current?.stop();
    setBusy(true);
    try {
      const res = await api.post<{ ai_ok: boolean }>("/api/smart-notes", {
        job_id: jobId,
        raw_content: content,
        entered_via: recording ? "voice" : "text",
      });
      toast.push(res.ai_ok ? "success" : "info", res.ai_ok ? "Note saved + analyzed" : "Note saved (AI unavailable)");
      setText("");
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack">
      <Card title="New field note">
        <div class="stack">
          <textarea
            class="form-input"
            rows={3}
            value={text}
            placeholder="Type or dictate a note — Claude will summarize and suggest tasks, expenses or change orders."
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          />
          <div class="flex gap-sm items-center">
            <Button variant={recording ? "danger" : "secondary"} size="sm" onClick={toggleVoice}>
              {recording ? "■ Stop" : "🎤 Voice"}
            </Button>
            <Button variant="primary" size="sm" disabled={busy || !text.trim()} onClick={save}>
              {busy ? "Saving…" : "Save Note"}
            </Button>
          </div>
        </div>
      </Card>

      {loading ? (
        <Spinner center />
      ) : notes.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__icon">🗒️</div>
          <div class="empty-state__title">No notes yet</div>
          <div>Capture a thought from the field — it becomes one-tap tasks, expenses and change orders.</div>
        </div>
      ) : (
        notes.map((n) => <NoteCard key={n.id} note={n} onChanged={refetch} toast={toast} />)
      )}
    </div>
  );
}

function NoteCard({ note, onChanged, toast }: { note: SmartNote; onChanged: () => void; toast: ReturnType<typeof useToast> }) {
  const [busy, setBusy] = useState(false);

  const accept = async (kind: "task" | "expense" | "change-order") => {
    setBusy(true);
    try {
      await api.post(`/api/smart-notes/${note.id}/accept-${kind}`, {});
      toast.push("success", `Created ${kind.replace("-", " ")}`);
      onChanged();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tasks = note.ai_extracted_tasks ?? [];
  const exp = note.ai_extracted_expense;
  const co = note.ai_extracted_change_order;

  return (
    <Card
      title={
        <span class="flex items-center gap-sm">
          {note.ai_category && <Badge tone={CAT_TONE[note.ai_category] ?? "neutral"}>{note.ai_category.replace(/_/g, " ")}</Badge>}
          {note.processing_status === "failed" && <Badge tone="warning">AI unavailable</Badge>}
        </span>
      }
      actions={<span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>{formatDateTime(note.created_at)}</span>}
    >
      <div class="stack">
        {note.ai_summary && <div>{note.ai_summary}</div>}
        <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>{note.raw_content}</div>

        {(tasks.length > 0 || exp || co) && (
          <div class="suggestion-list stack">
            {tasks.map((t, i) => (
              <div class="suggestion" key={i}>
                <div>✅ Task: <strong>{t.title}</strong>{t.task_group ? <span class="text--muted"> · {t.task_group}</span> : null}</div>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => accept("task")}>Accept</Button>
              </div>
            ))}
            {exp && (
              <div class="suggestion">
                <div>💵 Expense: <strong>{exp.vendor ?? "—"}</strong>{exp.amount != null ? ` · $${exp.amount}` : ""}{exp.category ? ` · ${exp.category}` : ""}</div>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => accept("expense")}>Accept</Button>
              </div>
            )}
            {co && (
              <div class="suggestion">
                <div>🧾 Change order: <strong>{co.title ?? "—"}</strong>{co.amount != null ? ` · $${co.amount}` : ""}</div>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => accept("change-order")}>Accept (draft)</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
