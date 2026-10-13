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
import { useAuth } from "../../store/auth";
import { api, ApiError } from "../../api";
import { formatCurrency, formatDate, formatDateTime, formatStatus } from "../../lib/format";
import {
  centralLocalToUtcIso,
  nowCentralLocalInput,
} from "@chs/shared/change-order-approval";

/**
 * Job Detail → Change Orders tab (Sprint 13). Create/edit drafts, send to the
 * portal for signing, reject, and view the signed (approved) read-only record.
 * Signing itself happens in the client portal under the job portal_token; this
 * tab reflects the applied result (contract total + tasks update on approval).
 * For fixed/trade jobs a suggested change_order invoice surfaces on the
 * Financial tab once approved — never auto-sent.
 */

interface ChangeOrder {
  id: string;
  change_order_number: number;
  display: string;
  title: string | null;
  description: string | null;
  amount: number;
  is_credit: boolean;
  status: string | null;
  requested_date: string | null;
  approved_date: string | null;
  applied_at: string | null;
  end_date_extension_days: number;
  signed_name: string | null;
  has_signature: boolean;
  approval_source: string | null;
  manual_approval_method: string | null;
  manual_approved_at: string | null;
  manual_approval_note: string | null;
  manual_approved_by: string | null;
  manual_recorded_at: string | null;
  has_proof: boolean;
  manual_approval_badge: string | null;
  triggered_by_note_id: string | null;
  billing_effect: string;
}
interface CoResponse {
  job_id: string;
  billing_model: string | null;
  contract_total: number;
  target_end_date: string | null;
  client_name: string;
  change_orders: ChangeOrder[];
}

type ToastApi = ReturnType<typeof useToast>;

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "error" | "info"> = {
  draft: "neutral",
  sent: "info",
  approved: "success",
  rejected: "error",
};

export function ChangeOrdersTab({ jobId, portalToken }: { jobId: string; portalToken?: string | null }) {
  const { data, loading, error, refetch } = useApi<CoResponse>(`/api/jobs/${jobId}/change-orders`);
  const toast = useToast();
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  const [editing, setEditing] = useState<ChangeOrder | null>(null);
  const [creating, setCreating] = useState(false);
  const [approving, setApproving] = useState<ChangeOrder | null>(null);

  if (loading) return <Spinner center />;
  if (error || !data) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">🧾</div>
        <div class="empty-state__title">Change orders unavailable</div>
        <div>{error ?? "Could not load change orders for this job."}</div>
      </div>
    );
  }

  const cos = data.change_orders;

  const send = async (co: ChangeOrder) => {
    try {
      await api.post(`/api/change-orders/${co.id}/send`, {});
      toast.push("success", `${co.display} sent to the client portal`);
      refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const reject = async (co: ChangeOrder) => {
    if (!confirm(`Reject ${co.display}? It stays on file but won't affect the job.`)) return;
    try {
      await api.post(`/api/change-orders/${co.id}/reject`, {});
      toast.push("success", `${co.display} rejected`);
      refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const copyPortalLink = async () => {
    if (!portalToken) {
      toast.push("info", "No portal link on this job yet.");
      return;
    }
    const url = `${window.location.origin}/portal/${portalToken}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.push("success", "Portal link copied — the client signs change orders there");
    } catch {
      toast.push("info", url);
    }
  };

  return (
    <div class="stack">
      <div class="flex items-center justify-between gap-sm">
        <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          {cos.length} change order(s) · {formatStatus(data.billing_model)}
        </span>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          + New Change Order
        </Button>
      </div>

      <Card title="Change Orders">
        {cos.length === 0 ? (
          <div class="empty-state">
            <div class="empty-state__icon">🧾</div>
            <div class="empty-state__title">No change orders yet</div>
            <div>Create one to adjust this job's scope or contract — the client signs it in their portal.</div>
          </div>
        ) : (
          <div class="invoice-list">
            {cos.map((co) => (
              <div class="invoice-row" key={co.id}>
                <div class="invoice-row__main">
                  <div class="invoice-row__title">
                    <strong>{co.display}</strong> {co.title}
                    {co.manual_approval_badge ? (
                      <Badge status="manual_approval">{co.manual_approval_badge}</Badge>
                    ) : (
                      <Badge tone={STATUS_TONE[co.status ?? "draft"] ?? "neutral"}>
                        {formatStatus(co.status)}
                      </Badge>
                    )}
                    {co.is_credit && <Badge tone="info">Credit</Badge>}
                    {co.triggered_by_note_id && <Badge tone="neutral">From note</Badge>}
                  </div>
                  <div class="invoice-row__meta">
                    {co.description ? `${co.description} · ` : ""}
                    {co.end_date_extension_days > 0 ? `+${co.end_date_extension_days}d end date · ` : ""}
                    {co.manual_approval_badge
                      ? ""
                      : co.status === "approved" && co.signed_name
                        ? `Signed by ${co.signed_name}${co.approved_date ? ` · ${formatDate(co.approved_date)}` : ""}`
                        : co.status === "sent"
                          ? "Awaiting client signature"
                          : ""}
                  </div>
                  {co.approval_source === "manual_owner" && (
                    <div class="invoice-row__meta">
                      Customer approved {co.manual_approved_at ? formatDateTime(co.manual_approved_at) : "—"}
                      {co.manual_recorded_at ? ` · recorded ${formatDateTime(co.manual_recorded_at)}` : ""}
                      {co.manual_approval_note ? ` · ${co.manual_approval_note}` : ""}
                      {co.has_proof ? (
                        <>
                          {" · "}
                          <a href={`/api/change-orders/${co.id}/approval-proof`} target="_blank" rel="noreferrer">
                            View proof
                          </a>
                        </>
                      ) : null}
                    </div>
                  )}
                  {co.status === "approved" && (
                    <div class="invoice-row__meta">
                      {co.billing_effect === "cost_plus_projection"
                        ? "Scope approved — bills through the next cost-plus cycle (no separate invoice)."
                        : co.billing_effect === "fixed_invoice_suggested"
                          ? "Approved — a suggested change-order invoice is on the Financial tab (owner-confirmed)."
                          : co.billing_effect === "credit_no_invoice"
                            ? "Approved credit — contract total reduced; no invoice."
                            : "Approved — contract total updated. No separate change-order invoice is suggested."}
                    </div>
                  )}
                </div>
                <div class="invoice-row__amount">{formatCurrency(co.amount)}</div>
                <div class="invoice-row__actions">
                  {isOwner && (co.status === "draft" || co.status === "sent") && (
                    <Button size="sm" variant="secondary" onClick={() => setApproving(co)}>
                      Approve on behalf of customer
                    </Button>
                  )}
                  {co.status === "draft" && (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => setEditing(co)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => send(co)}>
                        Send
                      </Button>
                    </>
                  )}
                  {co.status === "sent" && (
                    <>
                      <Button size="sm" variant="tertiary" onClick={copyPortalLink}>
                        Copy portal link
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => reject(co)}>
                        Reject
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {(creating || editing) && (
        <ChangeOrderModal
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
      {approving && (
        <ApproveOnBehalfModal
          co={approving}
          clientName={data.client_name || "the customer"}
          contractTotal={data.contract_total ?? 0}
          targetEndDate={data.target_end_date}
          onClose={() => setApproving(null)}
          onSaved={() => {
            setApproving(null);
            refetch();
          }}
          toast={toast}
        />
      )}
    </div>
  );
}

function ChangeOrderModal({
  jobId,
  existing,
  onClose,
  onSaved,
  toast,
}: {
  jobId: string;
  existing: ChangeOrder | null;
  onClose: () => void;
  onSaved: () => void;
  toast: ToastApi;
}) {
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  // Plain number input (no CurrencyInput primitive — deferred to S17). The credit
  // toggle flips the sign on submit so the owner enters a positive magnitude.
  const [isCredit, setIsCredit] = useState(existing ? existing.is_credit : false);
  const [amount, setAmount] = useState(existing ? String(Math.abs(existing.amount)) : "");
  const [extDays, setExtDays] = useState(existing ? String(existing.end_date_extension_days || "") : "");
  const [busy, setBusy] = useState(false);

  const mag = Number(amount);
  const valid = title.trim() && Number.isFinite(mag) && mag > 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    const signed = isCredit ? -Math.abs(mag) : Math.abs(mag);
    const payload = {
      title: title.trim(),
      description: description.trim() || null,
      amount: signed,
      end_date_extension_days: Math.max(0, Math.trunc(Number(extDays) || 0)),
    };
    try {
      if (existing) {
        await api.put(`/api/change-orders/${existing.id}`, payload);
        toast.push("success", "Change order updated");
      } else {
        await api.post(`/api/jobs/${jobId}/change-orders`, payload);
        toast.push("success", "Change order created (draft)");
      }
      onSaved();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={existing ? `Edit ${existing.display}` : "New Change Order"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Saving…" : existing ? "Save" : "Create Draft"}
          </Button>
        </>
      }
    >
      <FormField label="Title" required>
        <input
          class="form-input"
          value={title}
          placeholder="e.g. Add recessed lighting in living room"
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <FormField label="Description">
        <textarea
          class="form-input"
          rows={3}
          value={description}
          placeholder="What the client wants added/changed"
          onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
        />
      </FormField>
      <div class="form-row">
        <FormField label="Amount" required>
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
          />
        </FormField>
        <FormField label="End-date extension (days)">
          <input
            class="form-input"
            type="number"
            min="0"
            step="1"
            value={extDays}
            onInput={(e) => setExtDays((e.target as HTMLInputElement).value)}
          />
        </FormField>
      </div>
      <label class="quote-check" style={{ marginTop: "var(--space-sm)" }}>
        <input
          type="checkbox"
          checked={isCredit}
          onChange={(e) => setIsCredit((e.target as HTMLInputElement).checked)}
        />
        <span>This is a credit (reduces the contract total)</span>
      </label>
      <div class="invoice-builder__total">
        <span>Contract impact</span>
        <strong>{formatCurrency((isCredit ? -1 : 1) * (Number.isFinite(mag) ? Math.abs(mag) : 0))}</strong>
      </div>
    </Modal>
  );
}

const METHOD_OPTIONS = [
  { value: "phone", label: "Phone" },
  { value: "text", label: "Text" },
  { value: "in_person", label: "In person" },
  { value: "other", label: "Other" },
];

function addCalendarDays(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function ApproveOnBehalfModal({
  co,
  clientName,
  contractTotal,
  targetEndDate,
  onClose,
  onSaved,
  toast,
}: {
  co: ChangeOrder;
  clientName: string;
  contractTotal: number;
  targetEndDate: string | null;
  onClose: () => void;
  onSaved: () => void;
  toast: ToastApi;
}) {
  const [method, setMethod] = useState("phone");
  const [whenLocal, setWhenLocal] = useState(nowCentralLocalInput());
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const approvedAt = centralLocalToUtcIso(whenLocal);
  const future = !!approvedAt && Date.parse(approvedAt) > Date.now() + 60_000;
  const noteOk = note.trim().length >= 10;
  const nextTotal = Math.round((contractTotal + co.amount) * 100) / 100;
  const nextEnd =
    co.end_date_extension_days > 0 && targetEndDate
      ? addCalendarDays(targetEndDate, co.end_date_extension_days)
      : null;
  const valid = !!approvedAt && !future && noteOk && confirmed && !busy;

  const submit = async () => {
    if (!valid || !approvedAt) return;
    setBusy(true);
    try {
      let res: Response;
      if (file) {
        const fd = new FormData();
        fd.set("method", method);
        fd.set("approved_at", approvedAt);
        fd.set("note", note.trim());
        fd.set("confirm", "true");
        fd.set("proof", file);
        res = await fetch(`/api/change-orders/${co.id}/approve-manual`, { method: "POST", body: fd });
      } else {
        res = await fetch(`/api/change-orders/${co.id}/approve-manual`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            method,
            approved_at: approvedAt,
            note: note.trim(),
            confirm: true,
          }),
        });
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new ApiError(
          (data as { details?: string; error?: string }).details ||
            (data as { error?: string }).error ||
            `Request failed: ${res.status}`,
          res.status,
        );
      }
      toast.push("success", `${co.display} approved on behalf of the customer`);
      onSaved();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Approve on behalf of customer"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>
            {busy ? "Saving…" : "Record approval"}
          </Button>
        </>
      }
    >
      <p class="form-hint">
        Only use this when the customer has clearly approved by phone, text, or in person. This is
        saved as a manual approval, not an e-signature.
      </p>
      <FormField label="How they approved" required>
        <Select value={method} options={METHOD_OPTIONS} onChange={setMethod} />
      </FormField>
      <FormField label="When they approved (Central time)" required error={future ? "That time is in the future." : undefined}>
        <input
          class="form-input"
          type="datetime-local"
          value={whenLocal}
          onInput={(e) => setWhenLocal((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <FormField label="Note" required hint="At least 10 characters. Say what they told you.">
        <textarea
          class="form-input"
          rows={3}
          value={note}
          onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
        />
      </FormField>
      <FormField label="Attach screenshot of their approval">
        <input
          class="form-input"
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => {
            const picked = (e.target as HTMLInputElement).files?.[0] ?? null;
            setFile(picked);
          }}
        />
      </FormField>
      <div class="invoice-builder__total">
        <span>Contract total {formatCurrency(contractTotal)} → {formatCurrency(nextTotal)}</span>
        <strong>{nextEnd ? `End date → ${formatDate(nextEnd)}` : "End date unchanged"}</strong>
      </div>
      <label class="quote-check" style={{ marginTop: "var(--space-sm)" }}>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed((e.target as HTMLInputElement).checked)}
        />
        <span>
          I confirm {clientName} approved change order #{co.change_order_number} for {formatCurrency(co.amount)} and I am recording it on their behalf.
        </span>
      </label>
    </Modal>
  );
}
