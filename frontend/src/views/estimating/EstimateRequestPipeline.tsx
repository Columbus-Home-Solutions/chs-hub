import type { RoutableProps } from "preact-router";
import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatDate, formatStatus } from "../../lib/format";
import {
  PIPELINE_STAGES,
  type EstimateRequest,
  type EstimateRequestStatus,
} from "../../types";

interface PipelineResponse {
  as_of: string;
  stages: EstimateRequestStatus[];
  counts: Record<EstimateRequestStatus, number>;
  pipeline: Record<EstimateRequestStatus, EstimateRequest[]>;
}

export function EstimateRequestPipeline(_props: RoutableProps) {
  const { data, loading, error, refetch } = useApi<PipelineResponse>(
    "/api/estimate-requests/pipeline",
  );
  const toast = useToast();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<EstimateRequestStatus | null>(null);
  const [activeStage, setActiveStage] = useState<EstimateRequestStatus>("new_request");

  const moveTo = async (id: string, status: EstimateRequestStatus) => {
    try {
      await api.put(`/api/estimate-requests/${id}`, { status });
      toast.push("success", `Moved to ${formatStatus(status)}`);
      refetch();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.push("error", msg);
    }
  };

  const onDrop = (stage: EstimateRequestStatus) => {
    const id = draggingId;
    setDraggingId(null);
    setOverStage(null);
    if (!id) return;
    const current = findStatus(data, id);
    if (!current || current === stage) return;
    void moveTo(id, stage);
  };

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Estimating</h1>
          <p class="view-subtitle">
            {data ? `${total(data)} requests in the pipeline` : "Lead intake & estimate pipeline"}
          </p>
        </div>
        <div class="view-header__right">
          <button class="btn btn--primary" onClick={() => go("/estimating/new")}>
            + New Request
          </button>
        </div>
      </div>

      {loading && <Spinner center />}
      {error && <div class="empty-state">Couldn't load the pipeline: {error}</div>}

      {!loading && !error && data && (
        <>
          {/* Mobile stage selector */}
          <div class="pipeline-tabs">
            {PIPELINE_STAGES.map((s) => (
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
            {PIPELINE_STAGES.map((s) => {
              const cards = data.pipeline[s.key] ?? [];
              const isOver = overStage === s.key;
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
                    class={`pipeline-col__body${isOver ? " pipeline-col__body--over" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (overStage !== s.key) setOverStage(s.key);
                    }}
                    onDragLeave={() => setOverStage((cur) => (cur === s.key ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault();
                      onDrop(s.key);
                    }}
                  >
                    {cards.length === 0 && <div class="pipeline-col__empty">No requests</div>}
                    {cards.map((r) => (
                      <RequestCard
                        key={r.id}
                        request={r}
                        dragging={draggingId === r.id}
                        onDragStart={() => setDraggingId(r.id)}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setOverStage(null);
                        }}
                        onOpen={() => go(`/estimating/${r.id}`)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>

          <button class="fab" aria-label="New request" onClick={() => go("/estimating/new")}>
            +
          </button>
        </>
      )}
    </div>
  );
}

function RequestCard({
  request,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  request: EstimateRequest;
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
        <span class="er-card__name">{request.client_name}</span>
        <span class="er-card__num">REQ-{String(request.request_number).padStart(3, "0")}</span>
      </div>
      {request.client_phone && <div class="er-card__line">{request.client_phone}</div>}
      <div class="er-card__line">
        {[request.property_city, request.property_state].filter(Boolean).join(", ") || "—"}
      </div>
      <div class="er-card__meta">
        <Badge tone="neutral">{formatStatus(request.job_type)}</Badge>
        {request.is_repeat_client && <Badge tone="brand">Repeat</Badge>}
        {request.appointment_date && (
          <span class="er-card__line">📅 {formatDate(request.appointment_date)}</span>
        )}
        <span class="er-card__days">{request.days_in_stage}d</span>
      </div>
    </article>
  );
}

function total(data: PipelineResponse): number {
  return Object.values(data.counts).reduce((a, b) => a + b, 0);
}

function findStatus(
  data: PipelineResponse | null,
  id: string,
): EstimateRequestStatus | null {
  if (!data) return null;
  for (const stage of PIPELINE_STAGES) {
    if ((data.pipeline[stage.key] ?? []).some((r) => r.id === id)) return stage.key;
  }
  return null;
}
