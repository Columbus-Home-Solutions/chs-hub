import { useState } from "preact/hooks";
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
import { formatCurrency, formatDate, formatStatus } from "../../lib/format";

/**
 * Job Detail → Permits tab (Sprint 13). Full CRUD + inspection tracking.
 * Permits do NOT gate job status (tracking only). Permit document attachment is
 * a labeled seam to Sprint 15 (Document Management) — not built here.
 */

interface Permit {
  id: string;
  permit_type: string | null;
  permit_number: string | null;
  status: string;
  applied_date: string | null;
  approved_date: string | null;
  inspection_date: string | null;
  inspection_result: string | null;
  cost: number | null;
  notes: string | null;
}
interface PermitsResponse {
  job_id: string;
  permits: Permit[];
}

type ToastApi = ReturnType<typeof useToast>;

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "error" | "info"> = {
  applied: "info",
  approved: "success",
  inspection_scheduled: "warning",
  passed: "success",
  failed: "error",
  closed: "neutral",
};
const STATUS_OPTIONS = [
  { value: "applied", label: "Applied" },
  { value: "approved", label: "Approved" },
  { value: "inspection_scheduled", label: "Inspection scheduled" },
  { value: "passed", label: "Passed" },
  { value: "failed", label: "Failed" },
  { value: "closed", label: "Closed" },
];
const RESULT_OPTIONS = [
  { value: "", label: "—" },
  { value: "pending", label: "Pending" },
  { value: "passed", label: "Passed" },
  { value: "failed", label: "Failed" },
  { value: "partial", label: "Partial" },
];

export function PermitsTab({ jobId }: { jobId: string }) {
  const { data, loading, error, refetch } = useApi<PermitsResponse>(`/api/jobs/${jobId}/permits`);
  const toast = useToast();
  const [editing, setEditing] = useState<Permit | null>(null);
  const [creating, setCreating] = useState(false);

  if (loading) return <Spinner center />;
  if (error || !data) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">📋</div>
        <div class="empty-state__title">Permits unavailable</div>
        <div>{error ?? "Could not load permits for this job."}</div>
      </div>
    );
  }

  const permits = data.permits;

  return (
    <div class="stack">
      <div class="flex items-center justify-between gap-sm">
        <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          {permits.length} permit(s) · tracking only (permits don't gate job status)
        </span>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          + Add Permit
        </Button>
      </div>

      <Card title="Permits">
        {permits.length === 0 ? (
          <div class="empty-state">
            <div class="empty-state__icon">📋</div>
            <div class="empty-state__title">No permits yet</div>
            <div>Track permit applications, approvals, and inspections here.</div>
          </div>
        ) : (
          <div class="invoice-list">
            {permits.map((p) => (
              <div class="invoice-row" key={p.id} onClick={() => setEditing(p)} style={{ cursor: "pointer" }}>
                <div class="invoice-row__main">
                  <div class="invoice-row__title">
                    {formatStatus(p.permit_type)}
                    {p.permit_number ? ` · #${p.permit_number}` : ""}
                    <Badge tone={STATUS_TONE[p.status] ?? "neutral"}>{formatStatus(p.status)}</Badge>
                    {p.inspection_result && <Badge tone={p.inspection_result === "failed" ? "error" : "info"}>{formatStatus(p.inspection_result)}</Badge>}
                  </div>
                  <div class="invoice-row__meta">
                    {p.applied_date ? `Applied ${formatDate(p.applied_date)}` : ""}
                    {p.approved_date ? ` · Approved ${formatDate(p.approved_date)}` : ""}
                    {p.inspection_date ? ` · Inspection ${formatDate(p.inspection_date)}` : ""}
                    {p.notes ? ` · ${p.notes}` : ""}
                  </div>
                </div>
                <div class="invoice-row__amount">{p.cost != null ? formatCurrency(p.cost) : "—"}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {(creating || editing) && (
        <PermitModal
          jobId={jobId}
          existing={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            refetch();
          }}
          toast={toast}
        />
      )}
    </div>
  );
}

function PermitModal({
  jobId,
  existing,
  onClose,
  onSaved,
  toast,
}: {
  jobId: string;
  existing: Permit | null;
  onClose: () => void;
  onSaved: () => void;
  toast: ToastApi;
}) {
  const [permitType, setPermitType] = useState(existing?.permit_type ?? "");
  const [permitNumber, setPermitNumber] = useState(existing?.permit_number ?? "");
  const [status, setStatus] = useState(existing?.status ?? "applied");
  const [appliedDate, setAppliedDate] = useState(existing?.applied_date ?? "");
  const [approvedDate, setApprovedDate] = useState(existing?.approved_date ?? "");
  const [inspectionDate, setInspectionDate] = useState(existing?.inspection_date ?? "");
  const [inspectionResult, setInspectionResult] = useState(existing?.inspection_result ?? "");
  const [cost, setCost] = useState(existing?.cost != null ? String(existing.cost) : "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [busy, setBusy] = useState(false);

  const valid = permitType.trim();

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    const payload = {
      permit_type: permitType.trim(),
      permit_number: permitNumber.trim() || null,
      status,
      applied_date: appliedDate || null,
      approved_date: approvedDate || null,
      inspection_date: inspectionDate || null,
      inspection_result: inspectionResult || null,
      cost: cost === "" ? null : Number(cost),
      notes: notes.trim() || null,
    };
    try {
      if (existing) {
        await api.put(`/api/permits/${existing.id}`, payload);
        toast.push("success", "Permit updated");
      } else {
        await api.post(`/api/jobs/${jobId}/permits`, payload);
        toast.push("success", "Permit added");
      }
      onSaved();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!existing || !confirm("Delete this permit record?")) return;
    setBusy(true);
    try {
      await api.del(`/api/permits/${existing.id}`);
      toast.push("success", "Permit deleted");
      onSaved();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={existing ? "Edit permit" : "Add permit"}
      onClose={onClose}
      footer={
        <>
          {existing && (
            <Button variant="danger" onClick={remove} disabled={busy}>
              Delete
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Saving…" : existing ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <div class="form-row">
        <FormField label="Permit type" required>
          <input
            class="form-input"
            value={permitType}
            placeholder="e.g. Building, Electrical, Plumbing"
            onInput={(e) => setPermitType((e.target as HTMLInputElement).value)}
          />
        </FormField>
        <FormField label="Permit #">
          <input class="form-input" value={permitNumber} onInput={(e) => setPermitNumber((e.target as HTMLInputElement).value)} />
        </FormField>
      </div>
      <div class="form-row">
        <FormField label="Status">
          <Select value={status} options={STATUS_OPTIONS} onChange={setStatus} />
        </FormField>
        <FormField label="Cost">
          <input class="form-input" type="number" min="0" step="0.01" value={cost} onInput={(e) => setCost((e.target as HTMLInputElement).value)} />
        </FormField>
      </div>
      <div class="form-row">
        <FormField label="Applied date">
          <input class="form-input" type="date" value={appliedDate} onInput={(e) => setAppliedDate((e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="Approved date">
          <input class="form-input" type="date" value={approvedDate} onInput={(e) => setApprovedDate((e.target as HTMLInputElement).value)} />
        </FormField>
      </div>
      <div class="form-row">
        <FormField label="Inspection date">
          <input class="form-input" type="date" value={inspectionDate} onInput={(e) => setInspectionDate((e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="Inspection result">
          <Select value={inspectionResult} options={RESULT_OPTIONS} onChange={setInspectionResult} />
        </FormField>
      </div>
      <FormField label="Notes">
        <textarea class="form-input" rows={2} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
      </FormField>
      <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
        Permit document upload arrives with Document Management (Sprint 15).
      </p>
    </Modal>
  );
}
