import type { RoutableProps } from "preact-router";
import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatDateTime, formatStatus } from "../../lib/format";

interface DetailProps extends RoutableProps {
  id?: string;
}

interface WarrantyCall {
  id: string;
  job_id: string;
  job_number: number | null;
  job_title: string | null;
  client_name: string | null;
  title: string;
  description: string | null;
  status: string;
  assigned_to: string | null;
  assignee_name: string | null;
  scheduled_date: string | null;
  scheduled_end: string | null;
  completed_date: string | null;
  notes: string | null;
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

export function WarrantyCallDetail({ id }: DetailProps) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi<{ warranty_call: WarrantyCall }>(
    id ? `/api/warranty-calls/${id}` : null,
  );
  const users = useApi<{ users: Array<{ id: string; first_name: string | null; last_name: string | null }> }>(
    "/api/users",
  );
  const [notesDraft, setNotesDraft] = useState("");
  const [notesBusy, setNotesBusy] = useState(false);

  if (loading) return <Spinner center />;
  if (error || !data?.warranty_call) {
    return (
      <div class="empty-state">
        <div class="empty-state__title">Warranty call not found</div>
        <Button variant="secondary" onClick={() => go("/warranty-calls")}>
          Back to list
        </Button>
      </div>
    );
  }

  const c = data.warranty_call;

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api.patch(`/api/warranty-calls/${c.id}`, body);
      toast.push("success", "Saved");
      void refetch();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const appendNote = async () => {
    if (!notesDraft.trim()) return;
    setNotesBusy(true);
    const stamp = new Date().toLocaleString();
    const next = [c.notes, `[${stamp}] ${notesDraft.trim()}`].filter(Boolean).join("\n");
    try {
      await api.patch(`/api/warranty-calls/${c.id}`, { notes: next });
      setNotesDraft("");
      toast.push("success", "Note added");
      void refetch();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setNotesBusy(false);
    }
  };

  return (
    <div class="view">
      <div class="view-header">
        <div>
          <Button variant="tertiary" size="sm" onClick={() => go("/warranty-calls")}>
            ← Warranty Calls
          </Button>
          <h1 class="view-title" style={{ marginTop: "var(--space-sm)" }}>
            {c.title}
          </h1>
          <p class="view-subtitle">
            <button class="link-btn" onClick={() => go(`/jobs/${c.job_id}`)}>
              {c.job_number != null ? `JOB-${String(c.job_number).padStart(3, "0")}` : "Job"}
              {c.client_name ? ` · ${c.client_name}` : ""}
            </button>
          </p>
        </div>
        <div class="flex gap-xs">
          {c.status !== "completed" && (
            <Button variant="primary" size="sm" onClick={() => void patch({ status: "completed" })}>
              Mark completed
            </Button>
          )}
          {c.status === "open" && (
            <Button variant="secondary" size="sm" onClick={() => void patch({ status: "scheduled" })}>
              Mark scheduled
            </Button>
          )}
        </div>
      </div>

      <Card title="Details">
        <div class="kv">
          <div class="kv__row">
            <span class="kv__label">Status</span>
            <span class="kv__value">
              <Badge tone={c.status === "completed" ? "success" : c.status === "open" ? "warning" : "info"}>
                {formatStatus(c.status)}
              </Badge>
            </span>
          </div>
          <div class="kv__row">
            <span class="kv__label">Assigned to</span>
            <span class="kv__value">
              <Select
                value={c.assigned_to ?? ""}
                placeholder="Unassigned"
                onChange={(v) => void patch({ assigned_to: v || null })}
                options={(users.data?.users ?? []).map((u) => ({
                  value: u.id,
                  label: [u.first_name, u.last_name].filter(Boolean).join(" "),
                }))}
              />
            </span>
          </div>
          <div class="kv__row">
            <span class="kv__label">Scheduled</span>
            <span class="kv__value">{c.scheduled_date ? formatDateTime(c.scheduled_date) : "Not scheduled"}</span>
          </div>
          {c.completed_date && (
            <div class="kv__row">
              <span class="kv__label">Completed</span>
              <span class="kv__value">{formatDateTime(c.completed_date)}</span>
            </div>
          )}
        </div>
        <div style={{ marginTop: "var(--space-md)" }}>
          <FormField label="Description">
            <textarea
              class="input"
              rows={3}
              defaultValue={c.description ?? ""}
              onBlur={(e) => {
                const v = (e.target as HTMLTextAreaElement).value.trim();
                if (v !== (c.description ?? "")) void patch({ description: v || null });
              }}
            />
          </FormField>
        </div>
      </Card>

      <Card title="Notes">
        {c.notes ? (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontSize: "var(--text-sm)",
              margin: "0 0 var(--space-md)",
              fontFamily: "inherit",
            }}
          >
            {c.notes}
          </pre>
        ) : (
          <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            No notes yet.
          </p>
        )}
        <FormField label="Add note">
          <textarea
            class="input"
            rows={2}
            value={notesDraft}
            onInput={(e) => setNotesDraft((e.target as HTMLTextAreaElement).value)}
          />
        </FormField>
        <Button variant="secondary" size="sm" disabled={notesBusy} onClick={() => void appendNote()}>
          Append note
        </Button>
      </Card>
    </div>
  );
}
