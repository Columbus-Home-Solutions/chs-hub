/**
 * CHSLeadsKanban — Sprint 23
 * Native CHS lead pipeline Kanban. Reads from /api/estimate-requests/pipeline,
 * supports drag-to-update via PATCH /api/estimate-requests/:id/stage (optimistic),
 * and includes the "New Lead" quick-entry modal.
 */
import { useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Button } from "../../components/ui/Button";
import { ViewToggle } from "../../components/ViewToggle";
import { MarkWonModal } from "./MarkWonModal";
import { canDeleteRequest, DeleteRequestButton } from "./DeleteRequestButton";
import { QuickLeadModal } from "./QuickLeadModal";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { loadStoredView, storeView, truncate, useClientSort } from "../../lib/list-view";
import { formatDate, formatStatus } from "../../lib/format";
import {
  type EstimateRequest,
  type EstimateRequestStatus,
} from "../../types";

// Sprint 23 stage labels for the CHS Leads Kanban.
const CHS_LEAD_STAGES: { key: EstimateRequestStatus; label: string; color: string }[] = [
  { key: "new_request", label: "New Lead", color: "var(--pipeline-new-request)" },
  { key: "appointment_set", label: "Appt Scheduled", color: "var(--pipeline-appointment-set)" },
  { key: "visit_done", label: "Visit Done", color: "var(--pipeline-visit-done)" },
  { key: "building", label: "Building Estimate", color: "var(--pipeline-building)" },
  { key: "sent", label: "Estimate Sent", color: "var(--pipeline-sent)" },
  { key: "follow_up", label: "Following Up", color: "var(--pipeline-follow-up)" },
  { key: "won", label: "Won", color: "var(--pipeline-won)" },
  { key: "lost", label: "Lost", color: "var(--pipeline-lost)" },
];

interface PipelineResponse {
  as_of: string;
  stages: EstimateRequestStatus[];
  counts: Record<EstimateRequestStatus, number>;
  pipeline: Record<EstimateRequestStatus, EstimateRequest[]>;
}

function ageDays(createdAt: string | null): string {
  if (!createdAt) return "";
  const days = Math.max(
    0,
    Math.floor(
      (Date.now() - new Date(createdAt.includes("T") ? createdAt : createdAt + "Z").getTime()) /
        86_400_000,
    ),
  );
  if (days === 0) return "Today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function formatSource(source: string): string {
  const map: Record<string, string> = {
    manual: "Manual",
    inbound_sms: "SMS",
    high_level: "HL",
    website_form: "Web Form",
  };
  return map[source] ?? source;
}

interface LeadCardProps {
  request: EstimateRequest;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onDelete: () => void;
}

function LeadCard({ request, dragging, onDragStart, onDragEnd, onOpen, onDelete }: LeadCardProps) {
  const isSmsSrc = request.source === "inbound_sms";

  return (
    <article
      class={`er-card${dragging ? " er-card--dragging" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      style={{ cursor: "pointer" }}
    >
      <div class="er-card__top">
        <span class="er-card__name">{request.client_name}</span>
        <div class="flex items-center gap-xs">
          {isSmsSrc && (
            <span class="badge badge--sms" title="Created from inbound SMS">
              💬 SMS
            </span>
          )}
        </div>
      </div>

      {request.last_sms_preview && (
        <div class="er-card__sms-preview">{request.last_sms_preview}</div>
      )}

      {request.client_phone && (
        <div class="er-card__line">
          <a
            href={`tel:${request.client_phone}`}
            class="er-card__tel"
            onClick={(e) => e.stopPropagation()}
          >
            {request.client_phone}
          </a>
        </div>
      )}

      <div class="er-card__meta">
        <Badge tone="neutral">{formatStatus(request.job_type)}</Badge>
        {request.lead_source && (
          <Badge tone="neutral">{formatStatus(request.lead_source)}</Badge>
        )}
        {request.source !== "manual" && (
          <span class="badge badge--source">{formatSource(request.source)}</span>
        )}
        {request.is_repeat_client && <Badge tone="brand">Repeat</Badge>}
        {request.appointment_date && (
          <span class="er-card__appt">📅 {formatDate(request.appointment_date)}</span>
        )}
      </div>

      <div class="er-card__footer">
        <span class="er-card__age">{ageDays(request.created_at)}</span>
        <div class="flex items-center gap-xs" onClick={(e) => e.stopPropagation()}>
          {canDeleteRequest(request) && (
            <DeleteRequestButton request={request} size="sm" onDeleted={onDelete} />
          )}
        </div>
      </div>
    </article>
  );
}

interface CHSLeadsKanbanProps {
  onNewRequestCount?: (count: number) => void;
}

export function CHSLeadsKanban({ onNewRequestCount }: CHSLeadsKanbanProps) {
  const { data, loading, error, refetch } = useApi<PipelineResponse>(
    "/api/estimate-requests/pipeline",
  );
  const toast = useToast();

  const [viewMode, setViewMode] = useState(() => loadStoredView("chs_leads_view"));
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<EstimateRequestStatus | null>(null);
  const [activeStage, setActiveStage] = useState<EstimateRequestStatus>("new_request");
  const [wonTarget, setWonTarget] = useState<EstimateRequest | null>(null);
  const [showQuickLead, setShowQuickLead] = useState(false);

  // Optimistic pipeline state — starts from API data, updated on successful drags.
  const [optimisticPipeline, setOptimisticPipeline] = useState<
    Record<EstimateRequestStatus, EstimateRequest[]> | null
  >(null);

  const pipeline = optimisticPipeline ?? data?.pipeline ?? null;
  const counts = data?.counts ?? ({} as Record<EstimateRequestStatus, number>);

  // Report new_request count to parent for tab badge.
  if (onNewRequestCount && data) {
    onNewRequestCount(counts.new_request ?? 0);
  }

  const setView = (mode: "list" | "kanban") => {
    setViewMode(mode);
    storeView("chs_leads_view", mode);
  };

  // Drag-to-update: optimistic move, PATCH stage on success, revert on error.
  const onDrop = async (targetStage: EstimateRequestStatus) => {
    const id = draggingId;
    setDraggingId(null);
    setOverStage(null);
    if (!id || !pipeline) return;

    // Find current stage.
    let currentStage: EstimateRequestStatus | null = null;
    let draggedRequest: EstimateRequest | null = null;
    for (const s of CHS_LEAD_STAGES) {
      const hit = (pipeline[s.key] ?? []).find((r) => r.id === id);
      if (hit) {
        currentStage = s.key;
        draggedRequest = hit;
        break;
      }
    }
    if (!currentStage || !draggedRequest || currentStage === targetStage) return;

    // Won goes through the modal — don't allow drag-to-won.
    if (targetStage === "won") {
      setWonTarget(draggedRequest);
      return;
    }

    // Optimistic update.
    const updated = { ...draggedRequest, status: targetStage };
    const next: Record<EstimateRequestStatus, EstimateRequest[]> = {} as never;
    for (const s of CHS_LEAD_STAGES) {
      next[s.key] = (pipeline[s.key] ?? []).filter((r) => r.id !== id);
    }
    next[targetStage] = [updated, ...(next[targetStage] ?? [])];
    setOptimisticPipeline(next);

    try {
      await api.patch(`/api/estimate-requests/${id}/stage`, { status: targetStage });
      toast.push("success", `Moved to ${CHS_LEAD_STAGES.find((s) => s.key === targetStage)?.label ?? targetStage}`);
      refetch();
      setOptimisticPipeline(null);
    } catch (err) {
      // Revert optimistic update.
      setOptimisticPipeline(null);
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.push("error", msg ?? "Failed to move card");
    }
  };

  // List view data.
  const allRequests = useMemo(() => {
    if (!data) return [];
    return CHS_LEAD_STAGES.flatMap((s) => data.pipeline[s.key] ?? []);
  }, [data]);

  const { sorted, sortKey, sortDir, toggle } = useClientSort(allRequests, "created_at", "desc");

  if (loading) return <Spinner center />;
  if (error) return <div class="empty-state">Couldn't load leads: {error}</div>;

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">CHS Leads</h1>
          <p class="view-subtitle">
            {data ? `${Object.values(counts).reduce((a, b) => a + b, 0)} leads in pipeline` : "Native lead pipeline"}
          </p>
        </div>
        <div class="view-header__right flex gap-sm items-center">
          <ViewToggle value={viewMode} onChange={setView} />
          <button class="btn btn--secondary" onClick={() => go("/estimating/templates")}>
            Templates
          </button>
          <button class="btn btn--primary" onClick={() => setShowQuickLead(true)}>
            + New Lead
          </button>
        </div>
      </div>

      {viewMode === "list" && (
        <table class="data-table">
          <thead>
            <tr>
              <SortTh label="Request #" col="request_number" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Client" col="client_name" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Description" col="job_type" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Status" col="status" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Source" col="source" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Created" col="created_at" active={sortKey} dir={sortDir} onSort={toggle} />
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={7} class="text--muted">No leads in the pipeline.</td>
              </tr>
            )}
            {sorted.map((r) => (
              <tr key={r.id}>
                <td>
                  <button type="button" class="link-btn" onClick={() => go(`/estimating/${r.id}`)}>
                    REQ-{String(r.request_number).padStart(3, "0")}
                  </button>
                </td>
                <td>
                  {r.client_name}
                  {r.source === "inbound_sms" && (
                    <span class="badge badge--sms" style={{ marginLeft: "0.4rem" }}>💬 SMS</span>
                  )}
                </td>
                <td>{truncate(`${formatStatus(r.job_type)} — ${r.property_city}`)}</td>
                <td><Badge status={r.status}>{formatStatus(r.status)}</Badge></td>
                <td><span class="text--muted">{formatSource(r.source)}</span></td>
                <td>{r.created_at ? formatDate(r.created_at) : "—"}</td>
                <td>
                  <div class="flex items-center gap-sm" style={{ justifyContent: "flex-end" }}>
                    {canDeleteRequest(r) && (
                      <DeleteRequestButton request={r} size="sm" onDeleted={refetch} />
                    )}
                    <Button size="sm" variant="tertiary" onClick={() => go(`/estimating/${r.id}`)}>
                      View
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {viewMode === "kanban" && pipeline && (
        <>
          {/* Mobile stage selector */}
          <div class="pipeline-tabs">
            {CHS_LEAD_STAGES.map((s) => (
              <button
                key={s.key}
                class={`pipeline-tab${activeStage === s.key ? " pipeline-tab--active" : ""}`}
                onClick={() => setActiveStage(s.key)}
              >
                {s.label}
                <span class="pipeline-col__count">{counts[s.key] ?? 0}</span>
              </button>
            ))}
          </div>

          <div class="pipeline-board">
            {CHS_LEAD_STAGES.map((s) => {
              const cards = pipeline[s.key] ?? [];
              const isOver = overStage === s.key;
              return (
                <section
                  key={s.key}
                  class={`pipeline-col pipeline-col--${s.key}${activeStage === s.key ? " is-active" : ""}`}
                >
                  <header class="pipeline-col__header" style={{ borderTopColor: s.color }}>
                    <span class="pipeline-col__title" style={{ color: s.color }}>
                      {s.label}
                    </span>
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
                      void onDrop(s.key);
                    }}
                  >
                    {cards.length === 0 && <div class="pipeline-col__empty">No leads</div>}
                    {cards.map((r) => (
                      <LeadCard
                        key={r.id}
                        request={r}
                        dragging={draggingId === r.id}
                        onDragStart={() => setDraggingId(r.id)}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setOverStage(null);
                        }}
                        onOpen={() => go(`/estimating/${r.id}`)}
                        onDelete={() => refetch()}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>

          <button class="fab" aria-label="New lead" onClick={() => setShowQuickLead(true)}>
            +
          </button>
        </>
      )}

      <MarkWonModal
        request={wonTarget}
        onClose={() => setWonTarget(null)}
        onWon={() => {
          setWonTarget(null);
          setOptimisticPipeline(null);
          refetch();
        }}
      />

      {showQuickLead && (
        <QuickLeadModal
          onClose={() => setShowQuickLead(false)}
          onCreated={() => {
            setShowQuickLead(false);
            refetch();
          }}
        />
      )}
    </div>
  );
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
