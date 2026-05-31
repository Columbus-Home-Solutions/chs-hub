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
import { Timeline } from "../../components/Timeline";
import { CommunicationModal } from "../clients/ClientDetail";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatCurrency, formatDate, formatDateTime, formatPhone, formatStatus } from "../../lib/format";
import {
  JOB_STAGES,
  JOB_BACKWARD_EXCEPTIONS,
  type BillingScheduleRow,
  type Communication,
  type JobDetailResponse,
  type JobStatus,
  type Task,
  type TaskGroup,
} from "../../types";

interface DetailProps extends RoutableProps {
  id?: string;
}

type TabKey = "overview" | "tasks" | "activity" | "schedule" | "daily_logs" | "change_orders" | "files";

const TABS: { key: TabKey; label: string; stub?: boolean }[] = [
  { key: "overview", label: "Overview" },
  { key: "tasks", label: "Tasks" },
  { key: "activity", label: "Activity" },
  { key: "schedule", label: "Schedule", stub: true },
  { key: "daily_logs", label: "Daily Logs", stub: true },
  { key: "change_orders", label: "Change Orders", stub: true },
  { key: "files", label: "Files & Photos", stub: true },
];

// Legal status targets from the current status: every later stage (forward-only)
// plus the one sanctioned backward exception. The API re-validates and gates
// punch-list / unpaid-invoice rules.
function statusTargets(status: JobStatus): JobStatus[] {
  const order = JOB_STAGES.map((s) => s.key);
  const i = order.indexOf(status);
  const forward = i === -1 ? [] : order.slice(i + 1);
  const back = JOB_BACKWARD_EXCEPTIONS[status];
  return back ? [back, ...forward] : forward;
}

export function JobDetail({ id }: DetailProps) {
  const { data, loading, error, refetch } = useApi<JobDetailResponse>(id ? `/api/jobs/${id}` : null);
  const toast = useToast();
  const [tab, setTab] = useState<TabKey>("overview");

  if (loading) return <Spinner center />;
  if (error || !data) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">🔍</div>
        <div class="empty-state__title">Job not found</div>
        <div>{error ?? "This job doesn't exist."}</div>
        <div class="mt-md">
          <Button variant="secondary" onClick={() => go("/jobs")}>
            Back to pipeline
          </Button>
        </div>
      </div>
    );
  }

  const job = data.job;
  const fullAddress = [job.property_address, job.property_city, job.property_state, job.property_zip]
    .filter(Boolean)
    .join(", ");

  return (
    <div>
      <div class="view-header">
        <div>
          <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
            <h1 class="view-title">{job.title ?? job.client_name ?? "Job"}</h1>
            <span class={`er-status job-status--${job.status}`}>{formatStatus(job.status)}</span>
            {!job.conversion_complete && <Badge tone="warning">Setup pending</Badge>}
            {job.overdue && <Badge tone="error">Overdue</Badge>}
          </div>
          <p class="view-subtitle">
            {job.job_display ?? "JOB"}
            {job.client_name ? ` · ${job.client_name}` : ""}
            {fullAddress ? ` · ${fullAddress}` : ""}
          </p>
        </div>
        <div class="view-header__right">
          <Button variant="tertiary" onClick={() => go("/jobs")}>
            ← Pipeline
          </Button>
        </div>
      </div>

      <div class="job-tabs">
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

      {tab === "overview" && <OverviewTab data={data} refetch={refetch} toast={toast} />}
      {tab === "tasks" && id && <TasksTab jobId={id} groups={data.task_groups} refetch={refetch} toast={toast} />}
      {tab === "activity" && (
        <ActivityTab activity={data.activity} jobId={id} clientId={data.job.client_id} />
      )}
      {(tab === "schedule" || tab === "daily_logs" || tab === "change_orders" || tab === "files") && (
        <StubTab tab={tab} />
      )}
    </div>
  );
}

type ToastApi = ReturnType<typeof useToast>;

// ─── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({
  data,
  refetch,
  toast,
}: {
  data: JobDetailResponse;
  refetch: () => void;
  toast: ToastApi;
}) {
  const job = data.job;
  const targets = statusTargets(job.status);

  const changeStatus = async (status: string) => {
    try {
      await api.put(`/api/jobs/${job.id}/status`, { status });
      toast.push("success", `Moved to ${formatStatus(status)}`);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <div class="detail-grid">
      <div class="stack">
        <Card title="Client">
          <div class="kv">
            <div class="kv__row">
              <span class="kv__label">Name</span>
              <span class="kv__value">{job.client_name ?? "—"}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Phone</span>
              <span class="kv__value">{formatPhone(job.client_phone)}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Email</span>
              <span class="kv__value">{job.client_email ?? "—"}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Job Type</span>
              <span class="kv__value">{formatStatus(job.job_type)}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Days in Status</span>
              <span class="kv__value">{job.days_in_status}</span>
            </div>
          </div>
        </Card>

        <Card title="Financial">
          <div class="kv">
            <div class="kv__row">
              <span class="kv__label">Billing Model</span>
              <span class="kv__value">{formatStatus(job.billing_model)}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Contract Total</span>
              <span class="kv__value">{formatCurrency(data.financial.contract_total)}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Deposit</span>
              <span class="kv__value">{formatCurrency(data.financial.deposit_amount)}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Collected to Date</span>
              <span class="kv__value">{formatCurrency(data.financial.deposit_paid_to_date)}</span>
            </div>
          </div>
        </Card>

        <BillingScheduleCard rows={data.billing_schedule} />

        <DatesCard data={data} refetch={refetch} toast={toast} />
      </div>

      <div class="stack">
        <Card title="Status">
          <div class="stack">
            <div class="flex items-center gap-sm">
              <span class={`er-status job-status--${job.status}`}>{formatStatus(job.status)}</span>
            </div>
            {targets.length > 0 ? (
              <FormField label="Move to">
                <Select
                  value=""
                  placeholder="Select status…"
                  options={targets.map((t) => ({ value: t, label: stageLabel(t) }))}
                  onChange={(v) => v && changeStatus(v)}
                />
              </FormField>
            ) : (
              <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                This job is closed — no further status changes.
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function BillingScheduleCard({ rows }: { rows: BillingScheduleRow[] }) {
  return (
    <Card title="Billing Schedule">
      {rows.length === 0 ? (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          No billing schedule yet.
        </p>
      ) : (
        <div class="billing-list">
          {rows.map((b) => (
            <div class="billing-list__row" key={b.id}>
              <div>
                <div class="billing-list__label">{b.label}</div>
                <div class="billing-list__meta">
                  {formatStatus(b.trigger_type)}
                  {b.percentage != null ? ` · ${b.percentage}%` : ""}
                  {b.period_start ? ` · ${formatDate(b.period_start)}–${formatDate(b.period_end)}` : ""}
                </div>
              </div>
              <div class="billing-list__amount">
                {b.amount != null ? formatCurrency(b.amount) : "—"}
                <Badge tone="neutral">{formatStatus(b.status)}</Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function DatesCard({
  data,
  refetch,
  toast,
}: {
  data: JobDetailResponse;
  refetch: () => void;
  toast: ToastApi;
}) {
  const job = data.job;
  const [start, setStart] = useState(job.start_date ?? "");
  const [target, setTarget] = useState(job.target_end_date ?? "");

  useEffect(() => {
    setStart(job.start_date ?? "");
    setTarget(job.target_end_date ?? "");
  }, [job.id, job.start_date, job.target_end_date]);

  const save = async (field: "start_date" | "target_end_date", value: string) => {
    const current = field === "start_date" ? job.start_date : job.target_end_date;
    if ((current ?? "") === value) return;
    try {
      await api.put(`/api/jobs/${job.id}`, { [field]: value || null });
      toast.push("success", "Dates updated");
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <Card title="Schedule Dates">
      <div class="stack">
        <FormField label="Start date">
          <input
            class="form-input"
            type="date"
            value={start}
            onInput={(e) => setStart((e.target as HTMLInputElement).value)}
            onBlur={() => save("start_date", start)}
          />
        </FormField>
        <FormField label="Target end date">
          <input
            class="form-input"
            type="date"
            value={target}
            onInput={(e) => setTarget((e.target as HTMLInputElement).value)}
            onBlur={() => save("target_end_date", target)}
          />
        </FormField>
        {job.actual_end_date && (
          <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            Completed {formatDate(job.actual_end_date)}
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

function TasksTab({
  jobId,
  groups,
  refetch,
  toast,
}: {
  jobId: string;
  groups: TaskGroup[];
  refetch: () => void;
  toast: ToastApi;
}) {
  const [addOpen, setAddOpen] = useState(false);

  const complete = async (task: Task) => {
    try {
      await api.put(`/api/tasks/${task.id}/complete`, {});
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const reopen = async (task: Task) => {
    try {
      await api.put(`/api/tasks/${task.id}`, { status: "pending" });
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const existingGroups = groups.map((g) => g.group);

  return (
    <div class="stack">
      <div class="flex items-center justify-between gap-sm">
        <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          {groups.reduce((n, g) => n + g.tasks.length, 0)} tasks across {groups.length} group(s)
        </span>
        <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
          + Add Task
        </Button>
      </div>

      {groups.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__icon">📋</div>
          <div class="empty-state__title">No tasks yet</div>
          <div>Add a task to start tracking this job's work.</div>
        </div>
      ) : (
        groups.map((g) => (
          <Card key={g.group} title={g.group}>
            <div class="task-list">
              {g.tasks.map((t) => {
                const done = t.status === "complete";
                return (
                  <div class={`task-row${done ? " task-row--done" : ""}`} key={t.id}>
                    <input
                      type="checkbox"
                      class="task-row__check"
                      checked={done}
                      onChange={() => (done ? reopen(t) : complete(t))}
                    />
                    <div class="task-row__body">
                      <div class="task-row__title">
                        {t.title}
                        {t.is_punch_list && <Badge tone="warning">Punch</Badge>}
                      </div>
                      <div class="task-row__meta">
                        {formatStatus(t.status)}
                        {t.assigned_to ? ` · ${t.assigned_to}` : ""}
                        {t.scheduled_date ? ` · ${formatDate(t.scheduled_date)}` : ""}
                        {done && t.completed_date ? ` · done ${formatDate(t.completed_date)}` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        ))
      )}

      <AddTaskModal
        open={addOpen}
        jobId={jobId}
        existingGroups={existingGroups}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          setAddOpen(false);
          refetch();
        }}
        toast={toast}
      />
    </div>
  );
}

function AddTaskModal({
  open,
  jobId,
  existingGroups,
  onClose,
  onAdded,
  toast,
}: {
  open: boolean;
  jobId: string;
  existingGroups: string[];
  onClose: () => void;
  onAdded: () => void;
  toast: ToastApi;
}) {
  const [title, setTitle] = useState("");
  const [group, setGroup] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [punch, setPunch] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle("");
      setGroup(existingGroups[0] ?? "");
      setNewGroup("");
      setPunch(false);
      setBusy(false);
    }
  }, [open, existingGroups]);

  const NEW = "__new__";
  const resolvedGroup = group === NEW || existingGroups.length === 0 ? newGroup.trim() : group;
  const valid = title.trim() && resolvedGroup;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.post(`/api/jobs/${jobId}/tasks`, {
        title: title.trim(),
        task_group: resolvedGroup,
        is_punch_list: punch,
      });
      toast.push("success", "Task added");
      onAdded();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
      setBusy(false);
    }
  };

  const groupOptions = [
    ...existingGroups.map((g) => ({ value: g, label: g })),
    { value: NEW, label: "+ New group…" },
  ];

  return (
    <Modal
      open={open}
      title="Add Task"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Adding…" : "Add Task"}
          </Button>
        </>
      }
    >
      <FormField label="Title" required>
        <input
          class="form-input"
          value={title}
          placeholder="e.g. Rough-in plumbing"
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        />
      </FormField>
      {existingGroups.length > 0 && (
        <FormField label="Group" required>
          <Select
            value={group}
            options={groupOptions}
            onChange={setGroup}
          />
        </FormField>
      )}
      {(group === NEW || existingGroups.length === 0) && (
        <FormField label="New group name" required>
          <input
            class="form-input"
            value={newGroup}
            placeholder="e.g. Punch List"
            onInput={(e) => setNewGroup((e.target as HTMLInputElement).value)}
          />
        </FormField>
      )}
      <label class="quote-check" style={{ marginTop: "var(--space-sm)" }}>
        <input type="checkbox" checked={punch} onChange={(e) => setPunch((e.target as HTMLInputElement).checked)} />
        <span>This is a punch-list item</span>
      </label>
    </Modal>
  );
}

// ─── Activity ──────────────────────────────────────────────────────────────────

function ActivityTab({
  activity,
  jobId,
  clientId,
}: {
  activity: JobDetailResponse["activity"];
  jobId?: string;
  clientId?: string | null;
}) {
  const toast = useToast();
  const [logModal, setLogModal] = useState(false);
  const comms = useApi<{ communications: Communication[] }>(
    jobId ? `/api/jobs/${jobId}/communications` : null,
  );
  return (
    <div class="stack">
      <Card
        title="Communication timeline"
        actions={
          clientId ? (
            <Button size="sm" variant="secondary" onClick={() => setLogModal(true)}>
              + Log
            </Button>
          ) : undefined
        }
      >
        {comms.loading ? (
          <Spinner />
        ) : (
          <Timeline entries={comms.data?.communications ?? []} />
        )}
      </Card>

      {logModal && clientId && jobId && (
        <CommunicationModal
          clientId={clientId}
          jobId={jobId}
          onClose={() => setLogModal(false)}
          onSaved={() => {
            setLogModal(false);
            comms.refetch();
            toast.push("success", "Communication logged");
          }}
        />
      )}

      <Card title="Activity Log">
        {activity.length === 0 ? (
          <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            No activity yet.
          </p>
        ) : (
          <div class="timeline">
            {activity.map((a) => (
              <div key={a.id} class="timeline__item">
                <span class="timeline__dot" />
                <div class="timeline__content">
                  <div class="timeline__summary">{formatStatus(a.action.replace(/^job_/, ""))}</div>
                  <div class="timeline__meta">
                    {a.user_email} · {formatDateTime(a.created_at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Stubbed tabs (later sprints) ───────────────────────────────────────────────

function StubTab({ tab }: { tab: TabKey }) {
  const copy: Record<string, { icon: string; title: string; body: string }> = {
    schedule: { icon: "📅", title: "Scheduling", body: "Trade scheduling and the calendar land in a later sprint." },
    daily_logs: { icon: "📝", title: "Daily Logs", body: "Field daily logs and voice notes land in a later sprint." },
    change_orders: { icon: "🧾", title: "Change Orders", body: "Change orders land in a later sprint." },
    files: { icon: "📸", title: "Files & Photos", body: "Job files and progress photos land in a later sprint." },
  };
  const c = copy[tab] ?? { icon: "🚧", title: "Coming soon", body: "This section is not available yet." };
  return (
    <div class="empty-state">
      <div class="empty-state__icon">{c.icon}</div>
      <div class="empty-state__title">{c.title}</div>
      <div>{c.body}</div>
    </div>
  );
}

function stageLabel(key: JobStatus): string {
  return JOB_STAGES.find((s) => s.key === key)?.label ?? formatStatus(key);
}
