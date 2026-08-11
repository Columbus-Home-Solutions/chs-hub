import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { NewNoteModal } from "../../components/notes/NewNoteModal";
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

/**
 * Job-scoped notes history. Creation goes through NewNoteModal (native audio +
 * Gemini transcription + Claude) — not the old webkitSpeechRecognition form.
 */
export function SmartNotesPanel({ jobId }: { jobId: string }) {
  const toast = useToast();
  const { data, loading, refetch } = useApi<{ notes: SmartNote[] }>(`/api/smart-notes?job_id=${jobId}`);
  const notes = data?.notes ?? [];
  const [composerOpen, setComposerOpen] = useState(false);

  return (
    <div class="stack">
      <div class="flex items-center justify-between gap-sm" style={{ flexWrap: "wrap" }}>
        <div>
          <h2 class="view-title" style={{ fontSize: "var(--text-lg)", margin: 0 }}>Field Notes</h2>
          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "4px 0 0" }}>
            Job notes — create with New Note (voice or text).
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setComposerOpen(true)}>
          New Note
        </Button>
      </div>

      <NewNoteModal
        open={composerOpen}
        jobId={jobId}
        enteredVia="text"
        onClose={() => {
          setComposerOpen(false);
          refetch();
        }}
      />

      {loading ? (
        <Spinner center />
      ) : notes.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__icon">🗒️</div>
          <div class="empty-state__title">No notes yet</div>
          <div>Capture a thought from the field — it becomes one-tap tasks, expenses and change orders.</div>
          <div class="mt-md">
            <Button variant="primary" size="sm" onClick={() => setComposerOpen(true)}>
              New Note
            </Button>
          </div>
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
