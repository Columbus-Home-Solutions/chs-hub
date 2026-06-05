import type { RoutableProps } from "preact-router";
import { useEffect, useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Button } from "../../components/ui/Button";
import { ViewToggle } from "../../components/ViewToggle";
import { MarkWonModal } from "./MarkWonModal";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { searchParam } from "../../lib/url-params";
import { loadStoredView, storeView, truncate, useClientSort } from "../../lib/list-view";
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
  const [viewMode, setViewMode] = useState(() => loadStoredView("chs_estimates_view"));
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<EstimateRequestStatus | null>(null);
  const [activeStage, setActiveStage] = useState<EstimateRequestStatus>("new_request");
  const [wonTarget, setWonTarget] = useState<EstimateRequest | null>(null);
  const [statusFilter, setStatusFilter] = useState<EstimateRequestStatus | "">("");

  useEffect(() => {
    const s = searchParam("status");
    if (s && PIPELINE_STAGES.some((st) => st.key === s)) {
      setActiveStage(s as EstimateRequestStatus);
      setStatusFilter(s as EstimateRequestStatus);
    }
  }, []);

  const allRequests = useMemo(() => {
    if (!data) return [];
    return PIPELINE_STAGES.flatMap((s) => data.pipeline[s.key] ?? []);
  }, [data]);

  const listRows = useMemo(() => {
    if (!statusFilter) return allRequests;
    return allRequests.filter((r) => r.status === statusFilter);
  }, [allRequests, statusFilter]);

  const { sorted, sortKey, sortDir, toggle } = useClientSort(listRows, "created_at", "desc");

  const setView = (mode: "list" | "kanban") => {
    setViewMode(mode);
    storeView("chs_estimates_view", mode);
  };

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
    // Won runs the quote-to-job conversion — always go through the modal, which
    // captures the deposit payment and fires POST /win.
    if (stage === "won") {
      const req = findRequest(data, id);
      if (req) setWonTarget(req);
      return;
    }
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
        <div class="view-header__right flex gap-sm items-center">
          <ViewToggle value={viewMode} onChange={setView} />
          <button class="btn btn--secondary" onClick={() => go("/estimating/templates")}>
            Templates
          </button>
          <button class="btn btn--primary" onClick={() => go("/estimating/new")}>
            + New Request
          </button>
        </div>
      </div>

      {loading && <Spinner center />}
      {error && <div class="empty-state">Couldn't load the pipeline: {error}</div>}

      {!loading && !error && data && viewMode === "list" && (
        <table class="data-table">
          <thead>
            <tr>
              <SortTh label="Request #" col="request_number" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Client" col="client_name" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Description" col="job_type" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Status" col="status" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Deposit" col="estimate_deposit" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Created" col="created_at" active={sortKey} dir={sortDir} onSort={toggle} />
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={7} class="text--muted">No requests match this filter.</td></tr>
            )}
            {sorted.map((r) => (
              <tr key={r.id}>
                <td>
                  <button type="button" class="link-btn" onClick={() => go(`/estimating/${r.id}`)}>
                    REQ-{String(r.request_number).padStart(3, "0")}
                  </button>
                </td>
                <td>{r.client_name}</td>
                <td>{truncate(`${formatStatus(r.job_type)} — ${r.property_city}`)}</td>
                <td><Badge status={r.status}>{formatStatus(r.status)}</Badge></td>
                <td>{r.estimate_deposit != null ? `$${r.estimate_deposit.toLocaleString()}` : "—"}</td>
                <td>{r.created_at ? formatDate(r.created_at) : "—"}</td>
                <td>
                  <Button size="sm" variant="tertiary" onClick={() => go(`/estimating/${r.id}`)}>View</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!loading && !error && data && viewMode === "kanban" && (
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

      <MarkWonModal
        request={wonTarget}
        onClose={() => setWonTarget(null)}
        onWon={() => {
          setWonTarget(null);
          refetch();
        }}
      />
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

function findRequest(data: PipelineResponse | null, id: string): EstimateRequest | null {
  if (!data) return null;
  for (const stage of PIPELINE_STAGES) {
    const hit = (data.pipeline[stage.key] ?? []).find((r) => r.id === id);
    if (hit) return hit;
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
