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
import {
  LOST_REASONS,
  PIPELINE_STAGES,
  type ActivityEntry,
  type EstimateRequest,
  type EstimateRequestStatus,
} from "../../types";

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

  const [notes, setNotes] = useState("");
  const [apptOpen, setApptOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);

  useEffect(() => {
    setNotes(r?.visit_notes ?? "");
  }, [r?.id, r?.visit_notes]);

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

  const saveNotes = () => {
    if (!r) return;
    if ((r.visit_notes ?? "") === notes) return; // no change
    void patch({ visit_notes: notes }, "Visit notes saved");
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
        <div class="view-header__right">
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

          <Card title="Visit Notes">
            <textarea
              class="form-textarea"
              placeholder="Notes from the estimate visit… (saved when you click away)"
              value={notes}
              onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
              onBlur={saveNotes}
            />
          </Card>

          <Card title="Estimate">
            <div class="flex items-center justify-between gap-sm">
              <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                {r.estimate_id ? "Estimate started." : "No estimate built yet."}
              </span>
              <Button
                variant="primary"
                onClick={() => go(`/estimating/${r.id}/estimate`)}
                title="Estimate builder ships in Sprint 4"
              >
                Build Estimate
              </Button>
            </div>
          </Card>
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
                <Button variant="danger" block onClick={() => setLostOpen(true)}>
                  Mark Lost
                </Button>
              )}
              {r.status === "lost" && r.lost_reason && (
                <div class="text--secondary" style={{ fontSize: "var(--text-sm)" }}>
                  Lost: {formatStatus(r.lost_reason)}
                  {r.lost_notes ? ` — ${r.lost_notes}` : ""}
                </div>
              )}
            </div>
          </Card>

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
        onClose={() => setApptOpen(false)}
        onSave={(iso) => {
          setApptOpen(false);
          void apptCall({ appointment_date: iso }, "Appointment set");
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
    </div>
  );
}

function stageLabel(key: EstimateRequestStatus): string {
  return PIPELINE_STAGES.find((s) => s.key === key)?.label ?? formatStatus(key);
}

function AppointmentModal({
  open,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: string | null;
  onClose: () => void;
  onSave: (iso: string) => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    // datetime-local wants "YYYY-MM-DDTHH:mm"
    if (initial) {
      const d = new Date(initial);
      if (!isNaN(d.getTime())) {
        const pad = (n: number) => String(n).padStart(2, "0");
        setValue(
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
        );
        return;
      }
    }
    setValue("");
  }, [initial, open]);

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
          <Button variant="primary" disabled={!value} onClick={() => onSave(new Date(value).toISOString())}>
            Save
          </Button>
        </>
      }
    >
      <FormField label="Appointment date & time" required>
        <input
          class="form-input"
          type="datetime-local"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
      </FormField>
    </Modal>
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
