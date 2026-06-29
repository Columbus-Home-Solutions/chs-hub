import type { RoutableProps } from "preact-router";
import { useEffect, useRef, useState } from "preact/hooks";
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
import { formatCurrency } from "../../lib/format";
import { MarkWonModal } from "./MarkWonModal";
import { canDeleteEstimate, DeleteEstimateButton } from "./DeleteEstimateButton";
import { canDeleteRequest, DeleteRequestButton } from "./DeleteRequestButton";
import { ScopeDraftSection } from "./ScopeDraftSection";
import { ScopeSummaryCard } from "./ScopeSummaryCard";
import { SketchModal } from "./SketchModal";
import {
  ESTIMATE_SENT_TOOLTIP,
  LOST_REASONS,
  PIPELINE_STAGES,
  type ActivityEntry,
  type Estimate,
  type EstimateRequest,
  type EstimateRequestStatus,
  type ScopeDraftItem,
  type SketchMeta,
} from "../../types";

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult:
    | ((
        e: {
          results: ArrayLike<{ isFinal: boolean; 0: { transcript: string }; length: number }>;
        },
      ) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  return (
    (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike })
      .SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
      .webkitSpeechRecognition ||
    null
  );
}

function Icon({ name }: { name: string }) {
  return <i class={`ti ti-${name}`} aria-hidden="true" />;
}

interface DetailResponse {
  request: EstimateRequest;
  activity: ActivityEntry[];
}

interface DetailProps extends RoutableProps {
  id?: string;
}

// Legal forward targets from a given stage (for the "Advance" control).
function forwardTargets(status: EstimateRequestStatus): EstimateRequestStatus[] {
  const order: EstimateRequestStatus[] = [
    "new_request",
    "appointment_set",
    "visit_done",
    "building",
    "sent",
    "follow_up",
  ];
  const i = order.indexOf(status);
  if (i === -1) return [];
  return order.slice(i + 1); // strictly forward; won/lost handled separately
}

export function EstimateRequestDetail({ id }: DetailProps) {
  const { data, loading, error, refetch } = useApi<DetailResponse>(
    id ? `/api/estimate-requests/${id}` : null,
  );
  const toast = useToast();
  const r = data?.request;
  const { data: estData } = useApi<{ estimate: Estimate }>(
    r?.estimate_id ? `/api/estimates/${r.estimate_id}` : null,
  );
  const estimate = estData?.estimate;

  const [notes, setNotes] = useState("");
  const [scopeDraft, setScopeDraft] = useState<ScopeDraftItem[] | null>(null);
  const [draftGenerating, setDraftGenerating] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [hasGeneratedDraft, setHasGeneratedDraft] = useState(false);
  const [recording, setRecording] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [micDenied, setMicDenied] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const pendingTranscriptRef = useRef("");
  const speechSupported = useRef<boolean | null>(null);
  if (speechSupported.current === null && typeof window !== "undefined") {
    speechSupported.current = speechRecognitionCtor() != null;
  }
  const [apptOpen, setApptOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  const [wonOpen, setWonOpen] = useState(false);
  const [reviewDateEdit, setReviewDateEdit] = useState(false);
  const [reviewDateVal, setReviewDateVal] = useState("");
  const [reviewTimeVal, setReviewTimeVal] = useState("");
  const [sketchModalOpen, setSketchModalOpen] = useState(false);
  const [sketchCount, setSketchCount] = useState(0);
  const prevStatusRef = useRef<EstimateRequestStatus | null>(null);

  useEffect(() => {
    setNotes(r?.visit_notes ?? "");
  }, [r?.id, r?.visit_notes]);

  useEffect(() => {
    if (!id) return;
    api
      .get<{ sketches: SketchMeta[] }>(`/api/estimate-requests/${id}/sketches`)
      .then((res) => setSketchCount(res.sketches.length))
      .catch(() => setSketchCount(0));
  }, [id, sketchModalOpen]);

  useEffect(() => {
    if (r?.scope_draft && r.scope_draft.length > 0) {
      setScopeDraft(r.scope_draft);
    } else if (r && !r.scope_draft) {
      setScopeDraft(null);
    }
  }, [r?.id, r?.scope_draft]);

  // Sync review date edit state when record changes.
  useEffect(() => {
    if (!reviewDateEdit) {
      const iso = r?.proposal_review_date ?? "";
      if (iso) {
        const d = new Date(iso.includes("T") ? iso : iso + "Z");
        if (!isNaN(d.getTime())) {
          const pad = (n: number) => String(n).padStart(2, "0");
          setReviewDateVal(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
          setReviewTimeVal(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
          return;
        }
      }
      setReviewDateVal("");
      setReviewTimeVal("");
    }
  }, [r?.id, r?.proposal_review_date, reviewDateEdit]);

  const saveReviewDate = () => {
    if (!reviewDateVal) return;
    const iso = reviewTimeVal
      ? new Date(`${reviewDateVal}T${reviewTimeVal}`).toISOString()
      : new Date(`${reviewDateVal}T00:00:00`).toISOString();
    void patch({ proposal_review_date: iso }, "Proposal review date saved");
    setReviewDateEdit(false);
  };

  const clearReviewDate = () => {
    void patch({ proposal_review_date: null }, "Proposal review date cleared");
    setReviewDateEdit(false);
  };

  // Poll for client deposit conversion while estimate is out and not yet won.
  useEffect(() => {
    if (!r || r.status === "won" || r.status === "lost" || !r.estimate_sent) return;
    const poll = window.setInterval(() => void refetch(), 20_000);
    return () => window.clearInterval(poll);
  }, [r?.id, r?.status, r?.estimate_sent]);

  // Auto-navigate when conversion completes while this page is open (not on initial load of won).
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (
      r?.status === "won" &&
      r.converted_job_id &&
      prev &&
      prev !== "won"
    ) {
      go(`/jobs/${r.converted_job_id}`);
    }
    if (r?.status) prevStatusRef.current = r.status;
  }, [r?.status, r?.converted_job_id]);

  const patch = async (body: Record<string, unknown>, successMsg: string) => {
    if (!id) return;
    try {
      await api.put(`/api/estimate-requests/${id}`, body);
      toast.push("success", successMsg);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const saveNotes = (value?: string) => {
    if (!r) return;
    const next = value ?? notes;
    if ((r.visit_notes ?? "") === next) return;
    void patch({ visit_notes: next }, "Visit notes saved");
  };

  const stopRecording = () => {
    recRef.current?.stop();
    recRef.current = null;
    setRecording(false);
    setInterimTranscript("");
  };

  const toggleRecording = () => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;

    if (recording) {
      stopRecording();
      const chunk = pendingTranscriptRef.current.trim();
      pendingTranscriptRef.current = "";
      if (chunk) {
        const next = notes.trim() ? `${notes.trim()}\n${chunk}` : chunk;
        setNotes(next);
        saveNotes(next);
      }
      return;
    }

    setMicDenied(false);
    pendingTranscriptRef.current = "";
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let interim = "";
      let finalChunk = "";
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i];
        const t = result[0].transcript;
        if (result.isFinal) finalChunk += t;
        else interim += t;
      }
      if (finalChunk) pendingTranscriptRef.current += finalChunk;
      setInterimTranscript(interim);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setMicDenied(true);
      }
      stopRecording();
    };
    rec.onend = () => {
      setRecording(false);
      setInterimTranscript("");
      recRef.current = null;
    };
    recRef.current = rec;
    try {
      rec.start();
      setRecording(true);
    } catch {
      setMicDenied(true);
    }
  };

  const generateScopeDraft = async () => {
    if (!id) return;
    const trimmed = notes.trim();
    if (!trimmed) {
      setDraftError("Add visit notes before generating a scope draft.");
      return;
    }
    setDraftError(null);
    setDraftGenerating(true);
    try {
      const res = await api.post<{ draft: ScopeDraftItem[]; generated_at: string }>(
        `/api/estimate-requests/${id}/scope-draft`,
      );
      setScopeDraft(res.draft);
      setHasGeneratedDraft(true);
    } catch (err) {
      setDraftError("Scope draft generation failed. Check visit notes and try again.");
      if (err instanceof ApiError && err.details) {
        console.warn("[scope-draft]", err.details);
      }
    } finally {
      setDraftGenerating(false);
    }
  };

  const regenerateScopeDraft = async () => {
    if (!id) return;
    setDraftError(null);
    setDraftGenerating(true);
    try {
      await api.del(`/api/estimate-requests/${id}/scope-draft`);
      const res = await api.post<{ draft: ScopeDraftItem[] }>(
        `/api/estimate-requests/${id}/scope-draft`,
      );
      setScopeDraft(res.draft);
      setHasGeneratedDraft(true);
    } catch {
      setDraftError("Scope draft generation failed. Check visit notes and try again.");
    } finally {
      setDraftGenerating(false);
    }
  };

  const patchScopeDraftItem = async (itemIndex: number, updates: Record<string, unknown>) => {
    if (!id || !scopeDraft) return;
    try {
      const res = await api.patch<{ draft: ScopeDraftItem[] }>(
        `/api/estimate-requests/${id}/scope-draft`,
        { item_index: itemIndex, updates },
      );
      setScopeDraft(res.draft);
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  // Appointment + lost use dedicated endpoints (PUT /:id/appointment, /:id/lost).
  const apptCall = async (body: Record<string, unknown>, successMsg: string) => {
    if (!id) return;
    try {
      await api.put(`/api/estimate-requests/${id}/appointment`, body);
      toast.push("success", successMsg);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const markLost = async (reason: string, lostNotes: string) => {
    if (!id) return;
    try {
      await api.put(`/api/estimate-requests/${id}/lost`, {
        lost_reason: reason,
        lost_notes: lostNotes,
      });
      toast.push("success", "Marked as lost");
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  if (loading) return <Spinner center />;
  if (error || !r) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">🔍</div>
        <div class="empty-state__title">Request not found</div>
        <div>{error ?? "This estimate request doesn't exist."}</div>
        <div class="mt-md">
          <Button variant="secondary" onClick={() => go("/estimating")}>
            Back to pipeline
          </Button>
        </div>
      </div>
    );
  }

  const fullAddress = [r.property_address, r.property_city, r.property_state, r.property_zip]
    .filter(Boolean)
    .join(", ");
  const targets = forwardTargets(r.status);
  const terminal = r.status === "won" || r.status === "lost";

  return (
    <div>
      <div class="view-header">
        <div>
          <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
            <h1 class="view-title">{r.client_name}</h1>
            <span class={`er-status pipeline-col--${r.status}`}>{formatStatus(r.status)}</span>
            {r.is_repeat_client && <Badge tone="brand">Repeat</Badge>}
          </div>
          <p class="view-subtitle">
            REQ-{String(r.request_number).padStart(3, "0")} · {fullAddress}
          </p>
        </div>
        <div class="view-header__right flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
          {canDeleteRequest(r) && <DeleteRequestButton request={r} size="sm" />}
          <Button variant="tertiary" onClick={() => go("/estimating")}>
            ← Pipeline
          </Button>
        </div>
      </div>

      <div class="detail-grid">
        <div class="stack">
          <Card title="Overview">
            <div class="kv">
              <div class="kv__row">
                <span class="kv__label">Job Type</span>
                <span class="kv__value">{formatStatus(r.job_type)}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Lead Source</span>
                <span class="kv__value">
                  {formatStatus(r.lead_source)}
                  {r.lead_source_detail ? ` · ${r.lead_source_detail}` : ""}
                </span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Client Phone</span>
                <span class="kv__value">{r.client_phone ?? "—"}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Property</span>
                <span class="kv__value">{fullAddress}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Days in Stage</span>
                <span class="kv__value">{r.days_in_stage}</span>
              </div>
            </div>
          </Card>

          <Card title="Appointment">
            {r.appointment_date ? (
              <div class="flex items-center justify-between gap-sm" style={{ flexWrap: "wrap" }}>
                <div>
                  <div>{formatDateTime(r.appointment_date)}</div>
                  <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                    {r.appointment_completed ? "Completed" : "Scheduled"}
                  </div>
                </div>
                <div class="flex gap-sm">
                  <Button size="sm" variant="secondary" onClick={() => setApptOpen(true)}>
                    Reschedule
                  </Button>
                  {!r.appointment_completed && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        void apptCall({ appointment_completed: true }, "Appointment marked complete")
                      }
                    >
                      Mark Complete
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div class="flex items-center justify-between gap-sm">
                <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                  No appointment set.
                </span>
                <Button size="sm" variant="primary" onClick={() => setApptOpen(true)}>
                  Set Appointment
                </Button>
              </div>
            )}
          </Card>

          <Card title="📅 Proposal Review">
            {reviewDateEdit ? (
              <div class="stack" style={{ gap: "var(--space-sm)" }}>
                <div class="form-row">
                  <FormField label="Date">
                    <input
                      class="form-input"
                      type="date"
                      value={reviewDateVal}
                      onInput={(e) => setReviewDateVal((e.target as HTMLInputElement).value)}
                    />
                  </FormField>
                  <FormField label="Time (optional)">
                    <input
                      class="form-input"
                      type="time"
                      value={reviewTimeVal}
                      onInput={(e) => setReviewTimeVal((e.target as HTMLInputElement).value)}
                    />
                  </FormField>
                </div>
                <div class="flex gap-sm">
                  <Button size="sm" variant="primary" disabled={!reviewDateVal} onClick={saveReviewDate}>
                    Save
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setReviewDateEdit(false)}>
                    Cancel
                  </Button>
                  {r.proposal_review_date && (
                    <Button size="sm" variant="danger" onClick={clearReviewDate}>
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            ) : r.proposal_review_date ? (
              <div class="flex items-center justify-between gap-sm" style={{ flexWrap: "wrap" }}>
                <div>
                  <div
                    style={{
                      color: new Date(r.proposal_review_date) < new Date()
                        ? "var(--color-text-muted)"
                        : undefined,
                    }}
                  >
                    {formatDateTime(r.proposal_review_date)}
                  </div>
                  {new Date(r.proposal_review_date) < new Date() && (
                    <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                      Review date has passed
                    </div>
                  )}
                </div>
                <Button size="sm" variant="secondary" onClick={() => setReviewDateEdit(true)}>
                  Edit
                </Button>
              </div>
            ) : (
              <div class="flex items-center justify-between gap-sm">
                <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                  Not scheduled
                </span>
                <Button size="sm" variant="primary" onClick={() => setReviewDateEdit(true)}>
                  Schedule
                </Button>
              </div>
            )}
          </Card>

          <Card
            title="Visit Capture"
            actions={
              <div class="visit-capture__actions flex gap-sm">
                {speechSupported.current && (
                  <Button
                    size="sm"
                    variant={recording ? "danger" : "secondary"}
                    onClick={toggleRecording}
                  >
                    <Icon name="microphone" /> {recording ? "Stop recording" : "Record"}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setSketchModalOpen(true)}
                >
                  <Icon name="pencil" /> Draw{sketchCount > 0 ? ` ${sketchCount}` : ""}
                </Button>
              </div>
            }
          >
            <textarea
              class={`form-textarea${recording ? " visit-capture__textarea--recording" : ""}`}
              placeholder={
                recording && !notes.trim() && interimTranscript
                  ? interimTranscript
                  : "Notes from the estimate visit…"
              }
              value={notes}
              onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
              onBlur={() => saveNotes()}
            />
            {recording && interimTranscript && notes.trim() && (
              <p class="visit-capture__interim text--muted">{interimTranscript}</p>
            )}
            {micDenied && (
              <div class="visit-capture__alert callout callout--warning">
                <span>Microphone access was denied. Check your browser settings.</span>
                <button
                  type="button"
                  class="visit-capture__alert-dismiss"
                  aria-label="Dismiss"
                  onClick={() => setMicDenied(false)}
                >
                  <Icon name="x" />
                </button>
              </div>
            )}
            <div class="visit-capture__footer">
              <span class="text--muted visit-capture__hint">
                Saved when you click away
              </span>
              <div class="visit-capture__draft-actions">
                {draftError && (
                  <span class="visit-capture__error text--error">{draftError}</span>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  disabled={draftGenerating}
                  onClick={() => void generateScopeDraft()}
                >
                  <Icon name="wand" />{" "}
                  {draftGenerating
                    ? "Generating…"
                    : scopeDraft || hasGeneratedDraft
                      ? "Regenerate scope draft"
                      : "Build scope draft"}
                </Button>
              </div>
            </div>
          </Card>

          {scopeDraft && scopeDraft.length > 0 && (
            <ScopeDraftSection
              draft={scopeDraft}
              generating={draftGenerating}
              onRegenerate={() => void regenerateScopeDraft()}
              onPatchItem={patchScopeDraftItem}
            />
          )}

          <Card title="Estimate">
            <div class="flex items-center justify-between gap-sm" style={{ flexWrap: "wrap" }}>
              {estimate ? (
                <div>
                  <div class="flex items-center gap-sm">
                    <span style={{ fontWeight: "var(--weight-semibold)" }}>
                      EST-{String(estimate.estimate_number ?? 0).padStart(3, "0")}
                      {estimate.version > 1 ? ` · v${estimate.version}` : ""}
                    </span>
                    <Badge
                      tone={
                        estimate.status === "sent"
                          ? "info"
                          : estimate.status === "approved"
                            ? "success"
                            : "neutral"
                      }
                    >
                      {formatStatus(estimate.status)}
                    </Badge>
                  </div>
                  <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                    {formatCurrency(estimate.total)}
                    {estimate.deposit_amount
                      ? ` · deposit ${formatCurrency(estimate.deposit_amount)}`
                      : ""}
                  </div>
                </div>
              ) : (
                <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                  {r.estimate_id ? "Estimate started." : "No estimate built yet."}
                </span>
              )}
              <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
                {canDeleteEstimate(estimate) &&
                  !r.converted_job_id &&
                  r.status !== "won" &&
                  r.status !== "lost" && (
                    <DeleteEstimateButton estimate={estimate!} size="sm" onDeleted={refetch} />
                  )}
                <Button variant="primary" onClick={() => go(`/estimating/${r.id}/estimate`)}>
                  {estimate || r.estimate_id ? "Open Estimate" : "Build Estimate"}
                </Button>
              </div>
            </div>
            {estimate && estimate.portal_path && (
              <EstimateClientProgress estimate={estimate} />
            )}
          </Card>

          <FollowUpSequenceCard request={r} />

          {canDeleteRequest(r) && (
            <Card title="Danger zone">
              <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "0 0 var(--space-sm)" }}>
                Permanently remove this request from the pipeline, including any estimate, payment
                schedule, and client quote link.
              </p>
              <DeleteRequestButton request={r} />
            </Card>
          )}
        </div>

        <div class="stack">
          <Card title="Stage">
            <div class="stack">
              {!terminal && targets.length > 0 && (
                <FormField label="Advance to">
                  <Select
                    value=""
                    placeholder="Select stage…"
                    options={targets.map((t) => ({
                      value: t,
                      label: stageLabel(t),
                    }))}
                    onChange={(v) =>
                      v && patch({ status: v }, `Moved to ${formatStatus(v)}`)
                    }
                  />
                </FormField>
              )}
              {!terminal && (
                <span
                  style={{ display: "block" }}
                  title={r.estimate_sent ? undefined : ESTIMATE_SENT_TOOLTIP}
                >
                  <Button
                    variant="primary"
                    block
                    disabled={!r.estimate_sent}
                    onClick={() => setWonOpen(true)}
                  >
                    Mark as Won
                  </Button>
                </span>
              )}
              {!terminal && (
                <Button variant="danger" block onClick={() => setLostOpen(true)}>
                  Mark Lost
                </Button>
              )}
              {r.status === "won" && (
                <div class="stack" style={{ gap: "var(--space-sm)" }}>
                  <div class="text--secondary" style={{ fontSize: "var(--text-sm)" }}>
                    Won — converted to a job. This request is closed on the estimating board.
                  </div>
                  {r.converted_job_id && (
                    <Button variant="primary" block onClick={() => go(`/jobs/${r.converted_job_id}`)}>
                      Go to Job →
                    </Button>
                  )}
                </div>
              )}
              {r.status === "lost" && r.lost_reason && (
                <div class="text--secondary" style={{ fontSize: "var(--text-sm)" }}>
                  Lost: {formatStatus(r.lost_reason)}
                  {r.lost_notes ? ` — ${r.lost_notes}` : ""}
                </div>
              )}
            </div>
          </Card>

          {scopeDraft && scopeDraft.length > 0 && (
            <ScopeSummaryCard
              requestId={r.id}
              draft={scopeDraft}
              onDraftUpdate={setScopeDraft}
            />
          )}

          <Card title="Activity Log">
            {data!.activity.length === 0 ? (
              <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                No activity yet.
              </p>
            ) : (
              <div class="timeline">
                {data!.activity.map((a) => (
                  <div key={a.id} class="timeline__item">
                    <span class="timeline__dot" />
                    <div class="timeline__content">
                      <div class="timeline__summary">{formatStatus(a.action.replace(/^estimate_request_/, ""))}</div>
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
      </div>

      <AppointmentModal
        open={apptOpen}
        initial={r.appointment_date}
        initialTime={(r as any).appointment_time ?? null}
        onClose={() => setApptOpen(false)}
        onSave={(date, time) => {
          setApptOpen(false);
          void apptCall({ appointment_date: date, appointment_time: time }, "Appointment set");
        }}
      />

      <LostModal
        open={lostOpen}
        onClose={() => setLostOpen(false)}
        onSave={(reason, lostNotes) => {
          setLostOpen(false);
          void markLost(reason, lostNotes);
        }}
      />

      <MarkWonModal
        request={wonOpen ? r : null}
        onClose={() => setWonOpen(false)}
        onWon={() => {
          setWonOpen(false);
          refetch();
        }}
      />

      {sketchModalOpen && r && (
        <SketchModal requestId={r.id} onClose={() => setSketchModalOpen(false)} />
      )}
    </div>
  );
}

function stageLabel(key: EstimateRequestStatus): string {
  return PIPELINE_STAGES.find((s) => s.key === key)?.label ?? formatStatus(key);
}

function AppointmentModal({
  open,
  initial,
  initialTime,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: string | null;
  initialTime: string | null;
  onClose: () => void;
  onSave: (date: string, time: string | null) => void;
}) {
  const [dateVal, setDateVal] = useState("");
  const [timeVal, setTimeVal] = useState("");

  useEffect(() => {
    if (initial) {
      const d = new Date(initial.includes("T") ? initial : initial + "T00:00:00");
      if (!isNaN(d.getTime())) {
        const pad = (n: number) => String(n).padStart(2, "0");
        setDateVal(
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        );
      } else {
        setDateVal(initial.slice(0, 10));
      }
    } else {
      setDateVal("");
    }
    setTimeVal(initialTime ?? "");
  }, [initial, initialTime, open]);

  return (
    <Modal
      open={open}
      title="Set Appointment"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!dateVal} onClick={() => onSave(dateVal, timeVal || null)}>
            Save
          </Button>
        </>
      }
    >
      <FormField label="Appointment Date" required>
        <input
          class="form-input"
          type="date"
          value={dateVal}
          onInput={(e) => setDateVal((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <FormField label="Appointment Time (optional)">
        <input
          class="form-input"
          type="time"
          value={timeVal}
          onInput={(e) => setTimeVal((e.target as HTMLInputElement).value)}
        />
      </FormField>
    </Modal>
  );
}

// ─── Follow-Up Sequence Card (Sprint 26) ─────────────────────────────────────

function formatDateLong(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function FollowUpSequenceCard({ request: r }: { request: import("../../types").EstimateRequest }) {
  // Only show the card when the estimate has been sent or is in follow-up/terminal.
  const relevant = ["sent", "viewed", "follow_up", "won", "lost"].includes(r.status) || r.follow_up_count > 0;
  if (!relevant) return null;

  const count = r.follow_up_count ?? 0;

  type BadgeTone = "success" | "warning" | "error" | "neutral";
  let statusLabel: string;
  let tone: BadgeTone;

  if (r.status === "won") {
    statusLabel = "Stopped — Won";
    tone = "success";
  } else if (r.status === "lost") {
    statusLabel = "Stopped — Lost";
    tone = "neutral";
  } else if (r.follow_up_sequence_active) {
    statusLabel = "Active";
    tone = "success";
  } else if (count >= 4) {
    statusLabel = "Complete";
    tone = "neutral";
  } else if (count === 0 && !r.sent_date) {
    statusLabel = "Not Started";
    tone = "neutral";
  } else if (r.follow_up_completed_at) {
    statusLabel = "Complete";
    tone = "neutral";
  } else {
    statusLabel = "Not Started";
    tone = "neutral";
  }

  return (
    <Card title="Follow-Up Sequence">
      <div class="kv">
        <div class="kv__row">
          <span class="kv__label">Status</span>
          <span class="kv__value">
            <Badge tone={tone}>{statusLabel}</Badge>
          </span>
        </div>
        <div class="kv__row">
          <span class="kv__label">Touches Sent</span>
          <span class="kv__value">{count} of 4</span>
        </div>
        <div class="kv__row">
          <span class="kv__label">Last Sent</span>
          <span class="kv__value">{formatDateLong(r.last_follow_up_date)}</span>
        </div>
        {!r.follow_up_sequence_active && r.follow_up_completed_at && (
          <div class="kv__row">
            <span class="kv__label">Completed</span>
            <span class="kv__value">{formatDateLong(r.follow_up_completed_at)}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

function LostModal({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (reason: string, notes: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    if (open) {
      setReason("");
      setNotes("");
    }
  }, [open]);

  return (
    <Modal
      open={open}
      title="Mark as Lost"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!reason} onClick={() => onSave(reason, notes)}>
            Mark Lost
          </Button>
        </>
      }
    >
      <FormField label="Reason" required>
        <Select
          value={reason}
          placeholder="Select a reason…"
          options={LOST_REASONS.map((x) => ({ value: x, label: formatStatus(x) }))}
          onChange={setReason}
        />
      </FormField>
      <FormField label="Notes">
        <textarea
          class="form-textarea"
          value={notes}
          onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
        />
      </FormField>
    </Modal>
  );
}

// Compact client-link + progress shown on the request detail's Estimate card.
function EstimateClientProgress({ estimate }: { estimate: Estimate }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const link = estimate.portal_path ? `${window.location.origin}${estimate.portal_path}` : null;

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.push("success", "Client link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.push("error", "Couldn't copy — select and copy manually.");
    }
  };

  const steps = [
    { label: "Sent", done: ["sent", "viewed", "approved"].includes(estimate.status) },
    { label: "Viewed", done: !!estimate.viewed_date || ["viewed", "approved"].includes(estimate.status) },
    { label: "Signed", done: estimate.signed },
    { label: "Deposit Paid", done: estimate.status === "approved" },
  ];

  return (
    <div class="stack" style={{ marginTop: "var(--space-md)" }}>
      <div class="quote-progress">
        {steps.map((s, i) => (
          <div key={i} class={`quote-progress__step${s.done ? " is-done" : ""}`}>
            <span class="quote-progress__dot">{s.done ? "✓" : i + 1}</span>
            <span class="quote-progress__label">{s.label}</span>
          </div>
        ))}
      </div>
      {link && (
        <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
          <input
            class="form-input"
            style={{ flex: "1", minWidth: "220px", fontSize: "var(--text-sm)" }}
            readOnly
            value={link}
            onFocus={(ev) => (ev.target as HTMLInputElement).select()}
          />
          <Button variant="secondary" onClick={copy}>
            {copied ? "Copied ✓" : "Copy link"}
          </Button>
        </div>
      )}
    </div>
  );
}
