import type { RoutableProps } from "preact-router";
import { useEffect, useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Button } from "../../components/ui/Button";
import { ViewToggle } from "../../components/ViewToggle";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { searchParam } from "../../lib/url-params";
import { loadStoredView, storeView, truncate, useClientSort } from "../../lib/list-view";
import { formatCurrency, formatDate, formatStatus } from "../../lib/format";
import {
  JOB_STAGES,
  JOB_BACKWARD_EXCEPTIONS,
  type JobCard,
  type JobPipelineResponse,
  type JobStatus,
} from "../../types";

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
  const { data, loading, error, refetch } = useApi<JobPipelineResponse>("/api/jobs/pipeline");
  const toast = useToast();
  const [viewMode, setViewMode] = useState(() => loadStoredView("chs_jobs_view"));
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<JobStatus | null>(null);
  const [activeStage, setActiveStage] = useState<JobStatus>("deposit_paid");
  const [statusFilter, setStatusFilter] = useState<JobStatus | "">("");
  const [listSearch, setListSearch] = useState("");

  useEffect(() => {
    const s = searchParam("status");
    if (s && JOB_STAGES.some((st) => st.key === s)) {
      setActiveStage(s as JobStatus);
      setStatusFilter(s as JobStatus);
    }
  }, []);

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

  const setView = (mode: "list" | "kanban") => {
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
          <ViewToggle value={viewMode} onChange={setView} />
          <button class="btn btn--secondary btn--sm" onClick={() => go("/jobs/map")}>
            🗺 Map View
          </button>
        </div>
      </div>

      {loading && <Spinner center />}
      {error && <div class="empty-state">Couldn't load the pipeline: {error}</div>}

      {!loading && !error && data && viewMode === "list" && (
        <>
        <div style={{ marginBottom: "var(--space-md)", maxWidth: "360px" }}>
          <input
            class="form-input"
            type="search"
            placeholder="Search jobs (number, title, client, address)…"
            value={listSearch}
            onInput={(e) => setListSearch((e.target as HTMLInputElement).value)}
          />
        </div>
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
              <tr><td colSpan={7} class="text--muted">No jobs match this filter.</td></tr>
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
        </>
      )}

      {!loading && !error && data && viewMode === "kanban" && (
        <>
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
