import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatCurrency, formatDate, formatStatus } from "../../lib/format";

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
  triggered_by_note_id: string | null;
  billing_effect: string;
}
interface CoResponse {
  job_id: string;
  billing_model: string | null;
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
  const [editing, setEditing] = useState<ChangeOrder | null>(null);
  const [creating, setCreating] = useState(false);

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
                    <Badge tone={STATUS_TONE[co.status ?? "draft"] ?? "neutral"}>
                      {formatStatus(co.status)}
                    </Badge>
                    {co.is_credit && <Badge tone="info">Credit</Badge>}
                    {co.triggered_by_note_id && <Badge tone="neutral">From note</Badge>}
                  </div>
                  <div class="invoice-row__meta">
                    {co.description ? `${co.description} · ` : ""}
                    {co.end_date_extension_days > 0 ? `+${co.end_date_extension_days}d end date · ` : ""}
                    {co.status === "approved" && co.signed_name
                      ? `Signed by ${co.signed_name}${co.approved_date ? ` · ${formatDate(co.approved_date)}` : ""}`
                      : co.status === "sent"
                        ? "Awaiting client signature"
                        : ""}
                  </div>
                  {co.status === "approved" && (
                    <div class="invoice-row__meta">
                      {data.billing_model === "cost_plus"
                        ? "Scope approved — bills through the next cost-plus cycle (no separate invoice)."
                        : co.amount > 0
                          ? "Approved — a suggested change-order invoice is on the Financial tab (owner-confirmed)."
                          : "Approved credit — contract total reduced; no invoice."}
                    </div>
                  )}
                </div>
                <div class="invoice-row__amount">{formatCurrency(co.amount)}</div>
                <div class="invoice-row__actions">
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
