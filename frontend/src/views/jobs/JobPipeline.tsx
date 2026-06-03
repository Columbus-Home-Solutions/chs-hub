import type { RoutableProps } from "preact-router";
import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatCurrency, formatStatus } from "../../lib/format";
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
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<JobStatus | null>(null);
  const [activeStage, setActiveStage] = useState<JobStatus>("deposit_paid");

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
        <button class="btn btn--secondary btn--sm" onClick={() => go("/jobs/map")}>
          🗺 Map View
        </button>
      </div>

      {loading && <Spinner center />}
      {error && <div class="empty-state">Couldn't load the pipeline: {error}</div>}

      {!loading && !error && data && (
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
