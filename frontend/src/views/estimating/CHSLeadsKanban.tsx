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
import { Modal } from "../../components/ui/Modal";
import { ViewToggle } from "../../components/ViewToggle";
import { MarkWonModal } from "./MarkWonModal";
import { DeleteRequestButton } from "./DeleteRequestButton";
import { MarkLostButton } from "./MarkLostButton";
import { QuickLeadModal } from "./QuickLeadModal";
import { useToast } from "../../store/toast";
import { useMessageCenter } from "../../store/messageCenter";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { loadStoredView, storeView, truncate, useClientSort } from "../../lib/list-view";
import { jobTypeDisplayLabel } from "@chs/shared/job-type-label";
import { formatDate, formatStatus } from "../../lib/format";
import { outreachLabel } from "../../lib/outreach-label";
import {
  type EstimateRequest,
  type EstimateRequestStatus,
} from "../../types";

// Sprint 23 stage labels for the CHS Leads Kanban.
const CHS_LEAD_STAGES: { key: EstimateRequestStatus; label: string; color: string }[] = [
  { key: "new_request", label: "New Lead", color: "var(--pipeline-new-request)" },
  { key: "contacted", label: "Contacted", color: "var(--pipeline-contacted)" },
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
    google_lsa: "Google LSA",
    thumbtack: "Thumbtack",
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
  onMessage: (clientId: string) => void;
}

function LeadStageAction({
  request,
  size,
  onChanged,
}: {
  request: EstimateRequest;
  size: "sm" | "default";
  onChanged: () => void;
}) {
  if (request.status === "won" || request.status === "lost") return null;
  if (request.status === "new_request") {
    return <DeleteRequestButton request={request} size={size} onDeleted={onChanged} />;
  }
  return <MarkLostButton request={request} size={size} onLost={onChanged} />;
}

function LeadCard({ request, dragging, onDragStart, onDragEnd, onOpen, onDelete, onMessage }: LeadCardProps) {
  const isSmsSrc = request.source === "inbound_sms";
  const outreach = outreachLabel(request);

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
        <Badge tone="neutral">{jobTypeDisplayLabel(request.job_type, request.job_type_detail)}</Badge>
        {request.lead_source && (
          <Badge tone="neutral">{formatStatus(request.lead_source)}</Badge>
        )}
        {request.source !== "manual" && (
          <span class="badge badge--source">{formatSource(request.source)}</span>
        )}
        {request.existing_client && <Badge tone="info">Existing client</Badge>}
        {request.is_repeat_client && <Badge tone="brand">Repeat</Badge>}
        {outreach && (
          <Badge tone={outreach === "No response" ? "warning" : "info"}>{outreach}</Badge>
        )}
        {request.appointment_date && (
          <span class="er-card__appt">📅 {formatDate(request.appointment_date)}</span>
        )}
      </div>

      <div class="er-card__footer">
        <span class="er-card__age">{ageDays(request.created_at)}</span>
        <div class="flex items-center gap-xs" onClick={(e) => e.stopPropagation()}>
          {request.client_id && (
            <button
              class="btn btn--ghost btn--sm er-card__msg-btn"
              title="Open SMS thread"
              aria-label="Open SMS thread"
              onClick={(e) => { e.stopPropagation(); onMessage(request.client_id!); }}
            >
              💬
            </button>
          )}
          <LeadStageAction request={request} size="sm" onChanged={onDelete} />
        </div>
      </div>
    </article>
  );
}

interface CHSLeadsKanbanProps {
  onNewRequestCount?: (count: number) => void;
  highlightStage?: string;
}

export function CHSLeadsKanban({ onNewRequestCount, highlightStage }: CHSLeadsKanbanProps) {
  const { data, loading, error, refetch } = useApi<PipelineResponse>(
    "/api/estimate-requests/pipeline",
  );
  const toast = useToast();
  const { open: openMessageCenter } = useMessageCenter();

  const [viewMode, setViewMode] = useState(() => loadStoredView("chs_leads_view"));
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<EstimateRequestStatus | null>(null);
  const [activeStage, setActiveStage] = useState<EstimateRequestStatus>("new_request");
  const [wonTarget, setWonTarget] = useState<EstimateRequest | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [showQuickLead, setShowQuickLead] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

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
  const visibleStages = showClosed
    ? CHS_LEAD_STAGES
    : CHS_LEAD_STAGES.filter((s) => s.key !== "won" && s.key !== "lost");

  const allRequests = useMemo(() => {
    if (!data) return [];
    return visibleStages.flatMap((s) => data.pipeline[s.key] ?? []);
  }, [data, showClosed]);

  const { sorted, sortKey, sortDir, toggle } = useClientSort(allRequests, "created_at", "desc");
  const visibleNewRequests = useMemo(
    () => sorted.filter((r) => r.status === "new_request"),
    [sorted],
  );

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setConfirmDelete(false);
  };

  const enterSelectMode = () => {
    setView("list");
    setSelectMode(true);
    setSelectedIds(new Set());
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allVisibleSelected =
    visibleNewRequests.length > 0 && visibleNewRequests.every((r) => selectedIds.has(r.id));

  const toggleSelectAll = () => {
    if (allVisibleSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(visibleNewRequests.map((r) => r.id)));
  };

  const runBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const result = await api.post<{
        deleted: { id: string }[];
        skipped: { id: string; error: string; message: string }[];
        deleted_count: number;
        skipped_count: number;
      }>("/api/estimate-requests/bulk-delete", { ids: [...selectedIds] });

      const deleted = result.deleted_count;
      const skipped = result.skipped_count;
      if (skipped === 0) {
        toast.push("success", `${deleted} lead${deleted === 1 ? "" : "s"} deleted`);
      } else {
        const progressed = result.skipped.filter((s) => s.error === "cannot_delete_active_lead");
        const why =
          progressed.length === skipped
            ? "already had an appointment set"
            : result.skipped[0]?.message ?? "not eligible";
        toast.push(
          deleted > 0 ? "success" : "error",
          `${deleted} deleted, ${skipped} skipped — ${why}`,
        );
      }
      exitSelectMode();
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBulkBusy(false);
      setConfirmDelete(false);
    }
  };

  if (loading) return <Spinner center />;
  if (error) {
    return (
      <div class="empty-state">
        Couldn't load leads: {error}
        <div class="mt-sm">
          <Button variant="secondary" onClick={() => refetch()}>Retry</Button>
        </div>
      </div>
    );
  }

  return (
    <div class={`view view--pipeline${viewMode === "list" ? " view--list" : ""}`}>
      <div class="view-header">
        <div>
          <h1 class="view-title">CHS Leads</h1>
          <p class="view-subtitle">
            {data ? `${Object.values(counts).reduce((a, b) => a + b, 0)} leads in pipeline` : "Native lead pipeline"}
          </p>
        </div>
        <div class="view-header__right flex gap-sm items-center">
          <Button variant="secondary" size="sm" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? "Hide closed" : "Show closed"}
          </Button>
          <ViewToggle
            value={viewMode}
            onChange={(mode) => {
              setView(mode);
              if (mode === "kanban") exitSelectMode();
            }}
          />
          {visibleNewRequests.length > 0 && (
            <Button
              variant={selectMode ? "primary" : "secondary"}
              size="sm"
              onClick={() => (selectMode ? exitSelectMode() : enterSelectMode())}
            >
              {selectMode ? "✕ Cancel Select" : "☑ Select"}
            </Button>
          )}
          <button class="btn btn--secondary" onClick={() => go("/estimating/templates")}>
            Templates
          </button>
          <button class="btn btn--primary" onClick={() => setShowQuickLead(true)}>
            + New Lead
          </button>
        </div>
      </div>

      {viewMode === "list" && (
        <div class={`table-container${selectMode ? " leads-list--selecting" : ""}`}>
        <table class="data-table">
          <thead>
            <tr>
              {selectMode && (
                <th class="data-table__check-col">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    disabled={visibleNewRequests.length === 0}
                    onChange={toggleSelectAll}
                    aria-label="Select all New Request leads"
                  />
                </th>
              )}
              <SortTh label="Request #" col="request_number" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Client" col="client_name" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Phone" col="client_phone" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Job type" col="job_type" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Status" col="status" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Source" col="source" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Age" col="age_days" active={sortKey} dir={sortDir} onSort={toggle} />
              <SortTh label="Appointment" col="appointment_date" active={sortKey} dir={sortDir} onSort={toggle} />
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={selectMode ? 10 : 9} class="text--muted">No leads in the pipeline.</td>
              </tr>
            )}
            {sorted.map((r) => {
              const isNewRequest = r.status === "new_request";
              const selected = selectedIds.has(r.id);
              return (
              <tr
                key={r.id}
                class={selectMode && selected ? "data-table__row--selected" : undefined}
              >
                {selectMode && (
                  <td class="data-table__check-col">
                    {isNewRequest ? (
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleSelect(r.id)}
                        aria-label={`Select ${r.client_name}`}
                      />
                    ) : null}
                  </td>
                )}
                <td>
                  <button type="button" class="link-btn" onClick={() => go(`/estimating/${r.id}`)}>
                    REQ-{String(r.request_number).padStart(3, "0")}
                  </button>
                </td>
                <td>
                  {r.client_name}
                  {r.existing_client && <Badge tone="info">Existing client</Badge>}
                  {r.source === "inbound_sms" && (
                    <span class="badge badge--sms" style={{ marginLeft: "0.4rem" }}>💬 SMS</span>
                  )}
                </td>
                <td>
                  {r.client_phone ? (
                    <a href={`tel:${r.client_phone}`} class="er-card__tel">{r.client_phone}</a>
                  ) : (
                    <span class="text--muted">—</span>
                  )}
                </td>
                <td>{truncate(jobTypeDisplayLabel(r.job_type, r.job_type_detail))}</td>
                <td>
                  <Badge status={r.status}>{formatStatus(r.status)}</Badge>
                  {outreachLabel(r) && (
                    <Badge tone={outreachLabel(r) === "No response" ? "warning" : "info"}>{outreachLabel(r)}</Badge>
                  )}
                </td>
                <td><span class="text--muted">{formatSource(r.lead_source || r.source)}</span></td>
                <td>{ageDays(r.created_at)}</td>
                <td>{r.appointment_date ? formatDate(r.appointment_date) : "—"}</td>
                <td>
                  <div class="flex items-center gap-sm" style={{ justifyContent: "flex-end" }}>
                    {!selectMode && (
                      <LeadStageAction request={r} size="sm" onChanged={refetch} />
                    )}
                    <Button
                      size="sm"
                      variant="tertiary"
                      onClick={() =>
                        go(
                          r.status === "won" && r.converted_job_id
                            ? `/jobs/${r.converted_job_id}`
                            : `/estimating/${r.id}`,
                        )
                      }
                    >
                      {r.status === "won" && r.converted_job_id ? "Job" : "View"}
                    </Button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}

      {viewMode === "kanban" && pipeline && (
        <>
          {/* Mobile stage selector */}
          <div class="pipeline-tabs">
            {visibleStages.map((s) => (
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
            {visibleStages.map((s) => {
              const cards = pipeline[s.key] ?? [];
              const isOver = overStage === s.key;
              return (
                <section
                  key={s.key}
                  class={`pipeline-col pipeline-col--${s.key}${activeStage === s.key ? " is-active" : ""}${highlightStage === s.key ? " pipeline-col--highlighted" : ""}`}
                >
                  <header class="pipeline-col__header" style={{ borderTopColor: s.color }}>
                    <span class="pipeline-col__title" style={{ color: s.color }}>
                      {s.label}
                    </span>
                    <span class="pipeline-col__actions">
                      {s.key === "new_request" && cards.length > 0 && (
                        <button
                          type="button"
                          class="btn btn--ghost btn--sm"
                          onClick={enterSelectMode}
                        >
                          ☑ Select
                        </button>
                      )}
                      <span class="pipeline-col__count">{cards.length}</span>
                    </span>
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
                        onOpen={() =>
                          go(
                            r.status === "won" && r.converted_job_id
                              ? `/jobs/${r.converted_job_id}`
                              : `/estimating/${r.id}`,
                          )
                        }
                        onDelete={() => refetch()}
                        onMessage={(clientId) => openMessageCenter(clientId)}
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

      {selectMode && (
        <div class="leads-bulk-bar" role="status">
          <span class="leads-bulk-bar__count">{selectedIds.size} selected</span>
          <Button variant="tertiary" size="sm" onClick={toggleSelectAll}>
            {allVisibleSelected ? "Clear All" : "Select All"}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={bulkBusy || selectedIds.size === 0}
            onClick={() => setConfirmDelete(true)}
          >
            Delete Selected
          </Button>
          <Button variant="tertiary" size="sm" onClick={exitSelectMode}>
            Cancel
          </Button>
        </div>
      )}

      <Modal
        open={confirmDelete}
        title="Delete leads"
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={bulkBusy} onClick={() => void runBulkDelete()}>
              {bulkBusy ? "Deleting…" : "Yes, delete"}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Delete {selectedIds.size} lead{selectedIds.size === 1 ? "" : "s"}? This cannot be undone.
        </p>
      </Modal>
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
