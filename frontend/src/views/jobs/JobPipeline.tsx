import type { RoutableProps } from "preact-router";
import { route, useRouter } from "preact-router";
import { useEffect, useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Button } from "../../components/ui/Button";
import { ViewToggle, type ViewMode } from "../../components/ViewToggle";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { loadStoredView, storeView, truncate, useClientSort } from "../../lib/list-view";
import { formatCurrency, formatDate, formatStatus } from "../../lib/format";
import {
  JOB_STAGES,
  JOB_BACKWARD_EXCEPTIONS,
  type JobCard,
  type JobPipelineResponse,
  type JobStatus,
} from "../../types";

// ─── Job Health types ────────────────────────────────────────────────────────

type HealthColor = "green" | "amber" | "red" | "neutral";

interface JobHealthItem {
  id: string;
  title: string;
  job_number: number | null;
  status: string;
  client_name: string;
  property_address: string | null;
  health: HealthColor;
  days_quiet: number | null;
  last_daily_log: string | null;
  last_smart_note: string | null;
  last_photo: string | null;
}

interface JobHealthResponse {
  jobs: JobHealthItem[];
}

/** Format an ISO date/datetime string as relative time for the health view. */
function formatRelativeDays(dateStr: string | null): string {
  if (!dateStr) return "—";
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return "—";
  const diffMs = Date.now() - then;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 1) return "Today";
  if (diffDays === 1) return "1d ago";
  return `${diffDays}d ago`;
}

const HEALTH_DOT_COLORS: Record<HealthColor, string> = {
  green: "#22c55e",
  amber: "#f59e0b",
  red: "#ef4444",
  neutral: "#94a3b8",
};

// Human-readable label for each status value as it appears in the new sidebar nav.
const STATUS_LABELS: Record<string, string> = {
  deposit_paid: "Needs Scheduling",
  scheduled: "Scheduled",
  in_progress: "In Progress",
  punch_list: "Punch List",
  complete: "Needs Reconciliation",
  closed: "Closed",
};

// A drop is allowed if it moves strictly forward, or matches one of the two
// sanctioned backward exceptions. We pre-check on the client purely for UX
// (no error toast on an obviously-illegal drop); the API is the real gate.
function canMove(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return false;
  const order = JOB_STAGES.map((s) => s.key);
  const fi = order.indexOf(from);
  const ti = order.indexOf(to);
  if (ti > fi) return true;
  return JOB_BACKWARD_EXCEPTIONS[from] === to;
}

export function JobPipeline(_props: RoutableProps) {
  const [{ url }] = useRouter();
  const currentSearch = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";

  const { data, loading, error, refetch } = useApi<JobPipelineResponse>("/api/jobs/pipeline");
  const health = useApi<JobHealthResponse>("/api/jobs/health");
  const toast = useToast();
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const stored = loadStoredView("chs_jobs_view");
    // If URL has ?view=health, honour it
    const params = new URLSearchParams(currentSearch);
    if (params.get("view") === "health") return "health";
    return stored;
  });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<JobStatus | null>(null);
  const [activeStage, setActiveStage] = useState<JobStatus>("deposit_paid");
  const [statusFilter, setStatusFilter] = useState<JobStatus | "">("");
  const [listSearch, setListSearch] = useState("");

  // Re-run whenever the search string changes so clicking different sidebar
  // sub-items (same path, different ?status=) updates the filter each time.
  useEffect(() => {
    const params = new URLSearchParams(currentSearch);
    // Accept both ?stage= (from dashboard pipeline taps) and ?status= (sidebar).
    const s = params.get("stage") ?? params.get("status");
    if (s && JOB_STAGES.some((st) => st.key === s)) {
      setActiveStage(s as JobStatus);
      setStatusFilter(s as JobStatus);
    } else {
      setStatusFilter("");
    }
  }, [currentSearch]);

  const allJobs = useMemo(() => {
    if (!data) return [];
    return JOB_STAGES.flatMap((s) => data.pipeline[s.key] ?? []);
  }, [data]);

  const listJobs = useMemo(() => {
    let jobs = statusFilter ? allJobs.filter((j) => j.status === statusFilter) : allJobs;
    const q = listSearch.trim().toLowerCase();
    if (q) {
      jobs = jobs.filter((j) => {
        const hay = [
          j.job_display,
          j.job_number != null ? String(j.job_number) : "",
          j.title,
          j.client_name,
          j.property_address,
          j.property_city,
          j.property_state,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }
    return jobs;
  }, [allJobs, statusFilter, listSearch]);

  const { sorted, sortKey, sortDir, toggle } = useClientSort(listJobs, "job_number", "desc");

  const setView = (mode: ViewMode) => {
    setViewMode(mode);
    storeView("chs_jobs_view", mode);
  };

  const moveTo = async (id: string, status: JobStatus) => {
    try {
      await api.put(`/api/jobs/${id}/status`, { status });
      toast.push("success", `Moved to ${formatStatus(status)}`);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const onDrop = (stage: JobStatus) => {
    const id = draggingId;
    setDraggingId(null);
    setOverStage(null);
    if (!id) return;
    const current = findStatus(data, id);
    if (!current || !canMove(current, stage)) return;
    void moveTo(id, stage);
  };

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Jobs</h1>
          <p class="view-subtitle">
            {data ? `${total(data)} active jobs in the pipeline` : "Job pipeline"}
          </p>
        </div>
        <div class="view-header__right flex gap-sm items-center">
          {viewMode === "list" && (
            <input
              class="form-input"
              type="search"
              placeholder="Search jobs…"
              value={listSearch}
              onInput={(e) => setListSearch((e.target as HTMLInputElement).value)}
              style={{ width: "min(280px, 40vw)" }}
            />
          )}
          <ViewToggle value={viewMode} onChange={setView} showHealth />
          <button class="btn btn--secondary btn--sm" onClick={() => go("/jobs/map")}>
            🗺 Map View
          </button>
        </div>
      </div>

      {loading && <Spinner center />}
      {error && <div class="empty-state">Couldn't load the pipeline: {error}</div>}

      {!loading && !error && data && viewMode === "list" && (
        <div style={{ overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {statusFilter && (
          <div class="job-filter-badge">
            <span class="job-filter-badge__label">
              Showing: {STATUS_LABELS[statusFilter] ?? formatStatus(statusFilter)}
            </span>
            <button
              class="job-filter-badge__clear"
              onClick={() => {
                setStatusFilter("");
                route("/app/jobs");
              }}
              aria-label="Clear status filter"
            >
              ✕
            </button>
          </div>
        )}
        <div class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <SortTh label="Job #" col="job_number" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Client" col="client_name" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Title" col="title" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Status" col="status" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Contract" col="contract_total" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Target End" col="target_end_date" active={sortKey} dir={sortDir} onSort={toggle} />
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={7} class="text--muted">
                  {listSearch.trim()
                    ? "No jobs match your search."
                    : statusFilter
                      ? "No jobs match this filter."
                      : "No jobs in the pipeline."}
                </td>
              </tr>
            )}
            {sorted.map((j) => (
              <tr key={j.id}>
                <td>
                  <button type="button" class="link-btn" onClick={() => go(`/jobs/${j.id}`)}>
                    {j.job_display ?? "JOB"}
                  </button>
                </td>
                <td>{j.client_name ?? "—"}</td>
                <td>{truncate(j.title)}</td>
                <td><Badge status={j.status}>{formatStatus(j.status)}</Badge></td>
                <td>{formatCurrency(j.contract_total)}</td>
                <td>{j.target_end_date ? formatDate(j.target_end_date) : "—"}</td>
                <td>
                  <Button size="sm" variant="tertiary" onClick={() => go(`/jobs/${j.id}`)}>View</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        </div>
      )}

      {viewMode === "health" && (
        <>
          {health.loading && <Spinner center />}
          {health.error && <div class="empty-state">Couldn't load job health: {health.error}</div>}
          {!health.loading && !health.error && (
            <div class="job-health-list">
              {(health.data?.jobs ?? []).length === 0 && (
                <div class="empty-state">No active jobs to show.</div>
              )}
              {(health.data?.jobs ?? []).map((job) => (
                <div
                  key={job.id}
                  class="job-health-row"
                  onClick={() => go(`/jobs/${job.id}`)}
                  style={{ cursor: "pointer" }}
                >
                  <span
                    class="job-health-row__dot"
                    style={{ background: HEALTH_DOT_COLORS[job.health] }}
                    title={job.health}
                  />
                  <div class="job-health-row__main">
                    <div class="job-health-row__title">
                      <strong>{job.title}</strong>
                      {job.job_number != null && (
                        <span class="text--muted" style={{ marginLeft: "var(--space-xs)" }}>
                          #{job.job_number}
                        </span>
                      )}
                    </div>
                    <div class="job-health-row__sub text--muted">
                      {job.client_name}
                      {job.property_address ? ` · ${job.property_address}` : ""}
                    </div>
                  </div>
                  <div class="job-health-row__badge">
                    <Badge status={job.status}>{formatStatus(job.status)}</Badge>
                  </div>
                  <div class="job-health-row__stats">
                    <span class="job-health-row__stat" title="Daily log">
                      <span class="job-health-row__stat-label">Log</span>
                      <span>{formatRelativeDays(job.last_daily_log)}</span>
                    </span>
                    <span class="job-health-row__stat" title="Field note">
                      <span class="job-health-row__stat-label">Note</span>
                      <span>{formatRelativeDays(job.last_smart_note)}</span>
                    </span>
                    <span class="job-health-row__stat" title="Photo">
                      <span class="job-health-row__stat-label">Photo</span>
                      <span>{formatRelativeDays(job.last_photo)}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {!loading && !error && data && viewMode === "kanban" && (
        <>
          {statusFilter && (
            <div class="job-filter-badge">
              <span class="job-filter-badge__label">
                Showing: {STATUS_LABELS[statusFilter] ?? formatStatus(statusFilter)}
              </span>
              <button
                class="job-filter-badge__clear"
                onClick={() => {
                  setStatusFilter("");
                  route("/app/jobs");
                }}
                aria-label="Clear status filter"
              >
                ✕
              </button>
            </div>
          )}
          <div class="pipeline-tabs">
            {JOB_STAGES.map((s) => (
              <button
                key={s.key}
                class={`pipeline-tab${activeStage === s.key ? " pipeline-tab--active" : ""}`}
                onClick={() => setActiveStage(s.key)}
              >
                {s.label}
                <span class="pipeline-col__count">{data.counts[s.key] ?? 0}</span>
              </button>
            ))}
          </div>

          <div class="pipeline-board">
            {JOB_STAGES.map((s) => {
              const cards = data.pipeline[s.key] ?? [];
              const isOver = overStage === s.key;
              const droppable = draggingId
                ? canMove(findStatus(data, draggingId) ?? s.key, s.key)
                : false;
              return (
                <section
                  key={s.key}
                  class={`pipeline-col pipeline-col--${s.key}${activeStage === s.key ? " is-active" : ""}`}
                >
                  <header class="pipeline-col__header">
                    <span class="pipeline-col__title">{s.label}</span>
                    <span class="pipeline-col__count">{cards.length}</span>
                  </header>
                  <div
                    class={`pipeline-col__body${isOver && droppable ? " pipeline-col__body--over" : ""}`}
                    onDragOver={(e) => {
                      if (!droppable) return;
                      e.preventDefault();
                      if (overStage !== s.key) setOverStage(s.key);
                    }}
                    onDragLeave={() => setOverStage((cur) => (cur === s.key ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault();
                      onDrop(s.key);
                    }}
                  >
                    {cards.length === 0 && <div class="pipeline-col__empty">No jobs</div>}
                    {cards.map((j) => (
                      <JobPipelineCard
                        key={j.id}
                        job={j}
                        dragging={draggingId === j.id}
                        onDragStart={() => setDraggingId(j.id)}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setOverStage(null);
                        }}
                        onOpen={() => go(`/jobs/${j.id}`)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function JobPipelineCard({
  job,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  job: JobCard;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  return (
    <article
      class={`er-card${dragging ? " er-card--dragging" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
    >
      <div class="er-card__top">
        <span class="er-card__name">{job.client_name ?? "—"}</span>
        <span class="er-card__num">{job.job_display ?? "JOB"}</span>
      </div>
      {job.title && <div class="er-card__line">{job.title}</div>}
      <div class="er-card__line">
        {[job.property_city, job.property_state].filter(Boolean).join(", ") || "—"}
      </div>
      <div class="er-card__line er-card__value">{formatCurrency(job.contract_total)}</div>
      <div class="er-card__meta">
        {job.billing_model && <Badge tone="neutral">{formatStatus(job.billing_model)}</Badge>}
        {!job.conversion_complete && <Badge tone="warning">Setup pending</Badge>}
        {job.overdue && <Badge tone="error">Overdue</Badge>}
        <span class="er-card__days">{job.days_in_status}d</span>
      </div>
    </article>
  );
}

function total(data: JobPipelineResponse): number {
  return Object.values(data.counts).reduce((a, b) => a + b, 0);
}

function findStatus(data: JobPipelineResponse | null, id: string): JobStatus | null {
  if (!data) return null;
  for (const stage of JOB_STAGES) {
    if ((data.pipeline[stage.key] ?? []).some((j) => j.id === id)) return stage.key;
  }
  return null;
}

function SortTh({
  label,
  col,
  active,
  dir,
  onSort,
}: {
  label: string;
  col: string;
  active: string;
  dir: "asc" | "desc";
  onSort: (col: string) => void;
}) {
  return (
    <th>
      <button type="button" class="data-table__sort" onClick={() => onSort(col)}>
        {label}
        {active === col ? (dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
}
