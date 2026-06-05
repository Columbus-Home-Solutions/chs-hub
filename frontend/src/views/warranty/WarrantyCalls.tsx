import type { RoutableProps } from "preact-router";
import { useEffect, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatDateTime, formatStatus } from "../../lib/format";

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
  notes: string | null;
}

interface JobOption {
  id: string;
  job_number: number | null;
  title: string | null;
  client_name?: string | null;
}

interface UserOption {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

type Tab = "open" | "scheduled" | "completed" | "all";
const TABS: { key: Tab; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "scheduled", label: "Scheduled" },
  { key: "completed", label: "Completed" },
  { key: "all", label: "All" },
];

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "error" | "info"> = {
  open: "warning",
  scheduled: "info",
  completed: "success",
  cancelled: "neutral",
};

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

function jobLabel(j: JobOption): string {
  const num = j.job_number != null ? `JOB-${String(j.job_number).padStart(3, "0")}` : "Job";
  const client = j.client_name ? ` · ${j.client_name}` : "";
  return `${num}${client}${j.title ? ` — ${j.title}` : ""}`;
}

export function WarrantyCalls(_props: RoutableProps) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("open");
  const [creating, setCreating] = useState(false);
  const [scheduling, setScheduling] = useState<WarrantyCall | null>(null);
  const [scheduleValue, setScheduleValue] = useState("");

  const { data, loading, error, refetch } = useApi<{ warranty_calls: WarrantyCall[] }>(
    `/api/warranty-calls?status=${tab}`,
  );
  const jobs = useApi<{ jobs: JobOption[] }>("/api/jobs");

  const complete = async (id: string) => {
    try {
      await api.patch(`/api/warranty-calls/${id}`, { status: "completed" });
      toast.push("success", "Warranty call completed");
      void refetch();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const saveSchedule = async () => {
    if (!scheduling) return;
    try {
      await api.patch(`/api/warranty-calls/${scheduling.id}`, {
        scheduled_date: scheduleValue ? new Date(scheduleValue).toISOString() : null,
        status: scheduleValue ? "scheduled" : scheduling.status,
      });
      toast.push("success", "Schedule updated");
      setScheduling(null);
      void refetch();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const calls = data?.warranty_calls ?? [];

  return (
    <div class="view">
      <div class="view-header">
        <div>
          <h1 class="view-title">Warranty Calls</h1>
          <p class="view-subtitle">Track and schedule post-job warranty work</p>
        </div>
        <div class="view-header__right">
          <Button variant="primary" onClick={() => setCreating(true)}>
            + New Warranty Call
          </Button>
        </div>
      </div>

      <div class="flex gap-xs" style={{ marginBottom: "var(--space-md)", flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            class={`job-tab${tab === t.key ? " job-tab--active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <Spinner center />
      ) : error ? (
        <div class="empty-state">
          <div class="empty-state__title">Could not load warranty calls</div>
          <div>{error}</div>
        </div>
      ) : calls.length === 0 ? (
        <Card title="No warranty calls">
          <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            No {tab === "all" ? "" : tab} warranty calls yet.
          </p>
        </Card>
      ) : (
        <div class="invoice-list">
          {calls.map((c) => (
            <div class="invoice-row" key={c.id}>
              <div class="invoice-row__main" style={{ flex: 1 }}>
                <div class="invoice-row__title">
                  {c.title}
                  <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{formatStatus(c.status)}</Badge>
                </div>
                <div class="invoice-row__meta">
                  <button
                    class="link-btn"
                    onClick={() => go(`/jobs/${c.job_id}`)}
                  >
                    {c.job_number != null ? `JOB-${String(c.job_number).padStart(3, "0")}` : "Job"}
                    {c.client_name ? ` · ${c.client_name}` : ""}
                  </button>
                  {" · "}
                  {c.assignee_name ?? "Unassigned"}
                  {" · "}
                  {c.scheduled_date ? formatDateTime(c.scheduled_date) : "Not scheduled"}
                </div>
              </div>
              <div class="flex gap-xs" style={{ flexShrink: 0 }}>
                {c.status !== "completed" && c.status !== "cancelled" && (
                  <Button variant="tertiary" size="sm" title="Mark completed" onClick={() => void complete(c.id)}>
                    ✓
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setScheduling(c);
                    setScheduleValue(c.scheduled_date ? c.scheduled_date.slice(0, 16) : "");
                  }}
                >
                  Schedule
                </Button>
                <Button variant="secondary" size="sm" onClick={() => go(`/warranty-calls/${c.id}`)}>
                  View
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <WarrantyFormModal
          jobs={jobs.data?.jobs ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void refetch();
          }}
        />
      )}

      {scheduling && (
        <Modal open title="Schedule warranty call" onClose={() => setScheduling(null)}>
          <FormField label="Date & time">
            <input
              type="datetime-local"
              class="input"
              value={scheduleValue}
              onInput={(e) => setScheduleValue((e.target as HTMLInputElement).value)}
            />
          </FormField>
          <div class="flex gap-sm" style={{ marginTop: "var(--space-md)" }}>
            <Button variant="primary" onClick={() => void saveSchedule()}>
              Save
            </Button>
            <Button variant="tertiary" onClick={() => setScheduling(null)}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function WarrantyFormModal({
  jobs,
  onClose,
  onSaved,
  presetJobId,
}: {
  jobs: JobOption[];
  onClose: () => void;
  onSaved: () => void;
  presetJobId?: string;
}) {
  const toast = useToast();
  const users = useApi<{ users: UserOption[] }>("/api/users");
  const [jobId, setJobId] = useState(presetJobId ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (presetJobId) setJobId(presetJobId);
  }, [presetJobId]);

  const save = async () => {
    const effectiveJobId = presetJobId ?? jobId;
    if (!effectiveJobId || !title.trim()) {
      toast.push("error", "Job and title are required");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/warranty-calls", {
        job_id: effectiveJobId,
        title: title.trim(),
        description: description.trim() || null,
        assigned_to: assignedTo || null,
        scheduled_date: scheduled ? new Date(scheduled).toISOString() : null,
      });
      toast.push("success", "Warranty call logged");
      onSaved();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title="New warranty call" onClose={onClose}>
      <FormField label="Job" required>
        {presetJobId ? (
          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
            Linked to current job
          </p>
        ) : (
          <Select
            value={jobId}
            placeholder="Select a job…"
            onChange={setJobId}
            options={jobs.map((j) => ({ value: j.id, label: jobLabel(j) }))}
          />
        )}
      </FormField>
      <FormField label="Title" required>
        <input class="input" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      </FormField>
      <FormField label="Description">
        <textarea
          class="input"
          rows={3}
          value={description}
          onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
        />
      </FormField>
      <FormField label="Scheduled date & time">
        <input
          type="datetime-local"
          class="input"
          value={scheduled}
          onInput={(e) => setScheduled((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <FormField label="Assign to">
        <Select
          value={assignedTo}
          placeholder="Unassigned"
          onChange={setAssignedTo}
          options={(users.data?.users ?? []).map((u) => ({
            value: u.id,
            label: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.id,
          }))}
        />
      </FormField>
      <div class="flex gap-sm" style={{ marginTop: "var(--space-md)" }}>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          Save
        </Button>
        <Button variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

export { WarrantyFormModal };
