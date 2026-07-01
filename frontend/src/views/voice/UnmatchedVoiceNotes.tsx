/**
 * Unassigned voice notes review (Sprint 33).
 * Route: /app/voice-notes/unmatched
 */

import { useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatDateTime } from "../../lib/format";
import "../../styles/voice-note.css";

const DISMISS_KEY = "chs_voice_notes_dismissed";

interface UnmatchedNote {
  id: string;
  raw_content: string;
  entered_via: string;
  created_at: string;
  processing_status: string | null;
}

interface ActiveJob {
  id: string;
  title: string | null;
  client_name: string | null;
}

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<string>) {
  localStorage.setItem(DISMISS_KEY, JSON.stringify([...ids]));
}

export function UnmatchedVoiceNotes() {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi<{ notes: UnmatchedNote[] }>(
    "/api/voice-notes/unmatched",
  );
  const jobsApi = useApi<{ jobs: ActiveJob[] }>("/api/jobs/active");
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());
  const [assignJob, setAssignJob] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const jobOptions = useMemo(() => {
    const jobs = jobsApi.data?.jobs ?? [];
    return [
      { value: "", label: "Select job…" },
      ...jobs.map((j) => ({
        value: j.id,
        label: [j.title, j.client_name].filter(Boolean).join(" · ") || j.id,
      })),
    ];
  }, [jobsApi.data]);

  const visible = (data?.notes ?? []).filter((n) => !dismissed.has(n.id));

  const dismiss = (id: string) => {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    saveDismissed(next);
    toast.push("info", "Note dismissed");
  };

  const assign = async (noteId: string) => {
    const jobId = assignJob[noteId];
    if (!jobId) {
      toast.push("error", "Select a job first");
      return;
    }
    setBusyId(noteId);
    try {
      await api.put(`/api/voice-notes/${noteId}/assign`, { job_id: jobId });
      toast.push("success", "Note assigned to job");
      refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div class="view-page" style={{ maxWidth: "720px", margin: "0 auto" }}>
      <div class="view-header">
        <Button variant="tertiary" onClick={() => go("/")}>
          ← Back
        </Button>
        <h1 class="view-title">Unassigned Voice Notes</h1>
      </div>

      <p class="text--muted" style={{ marginBottom: "var(--space-lg)" }}>
        These notes couldn't be matched to a job. Assign each one or dismiss it.
      </p>

      {loading ? (
        <Spinner center />
      ) : error ? (
        <div class="empty-state">
          <div class="empty-state__title">Couldn't load notes</div>
          <div>{error}</div>
        </div>
      ) : visible.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__icon">🎤</div>
          <div class="empty-state__title">No unassigned voice notes</div>
          <div>You're all caught up!</div>
        </div>
      ) : (
        visible.map((note) => (
          <div class="voice-unmatched__card" key={note.id}>
            <div class="voice-unmatched__meta">🎤 {formatDateTime(note.created_at)}</div>
            <div class="voice-unmatched__text">&ldquo;{note.raw_content}&rdquo;</div>
            <div class="voice-unmatched__actions">
              <FormField label="Assign to job">
                <Select
                  value={assignJob[note.id] ?? ""}
                  options={jobOptions}
                  onChange={(v) => setAssignJob((prev) => ({ ...prev, [note.id]: v }))}
                />
              </FormField>
              <Button
                variant="primary"
                size="sm"
                disabled={busyId === note.id}
                onClick={() => assign(note.id)}
              >
                {busyId === note.id ? "Saving…" : "Assign"}
              </Button>
              <Button variant="tertiary" size="sm" onClick={() => dismiss(note.id)}>
                Dismiss
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
