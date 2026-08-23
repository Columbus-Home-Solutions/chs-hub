import { useEffect, useState } from "preact/hooks";
import { go } from "../../lib/nav";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import {
  ESTIMATE_SENT_TOOLTIP,
  WON_PAYMENT_METHODS,
  type EstimateRequest,
} from "../../types";

/**
 * Confirm deposit received → quote-to-job conversion (same path as Stripe webhook).
 * Used from pipeline (Mark as Won) and Estimate Builder (Mark Deposit Received).
 */
export function MarkWonModal({
  request,
  onClose,
  onWon,
  preferredMethod,
  title = "Mark as Won",
  confirmLabel = "Confirm — Mark as Won",
  estimateId,
}: {
  request: EstimateRequest | null;
  onClose: () => void;
  onWon: (jobId?: string, jobNumber?: number) => void;
  preferredMethod?: string | null;
  title?: string;
  confirmLabel?: string;
  /** When set, posts to /api/estimates/:id/mark-deposit-received (same completion logic). */
  estimateId?: string | null;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("check");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);

  const canWin = !!request?.estimate_sent;

  useEffect(() => {
    if (request) {
      setAmount(request.estimate_deposit != null ? String(request.estimate_deposit) : "");
      const pref = (preferredMethod ?? "").toLowerCase();
      setMethod(
        pref === "cash" || pref === "check" || pref === "venmo" || pref === "zelle" || pref === "other"
          ? pref
          : "check",
      );
      setReference("");
      setSaving(false);
    }
  }, [request?.id, preferredMethod]);

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;

  const confirm = async () => {
    if (!request || !canWin || !amountValid || saving) return;
    setSaving(true);
    try {
      const body = {
        deposit_amount: amountNum,
        payment_method: method,
        reference: reference || null,
      };
      const res = estimateId
        ? await api.post<{ job_id?: string; job_number?: number }>(
            `/api/estimates/${estimateId}/mark-deposit-received`,
            body,
          )
        : await api.post<{ job_id?: string; job_number?: number }>(
            `/api/estimate-requests/${request.id}/win`,
            body,
          );
      toast.push("success", "Deposit recorded — job created");
      onWon(res.job_id, res.job_number);
      if (res.job_id) go(`/jobs/${res.job_id}`);
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!request}
      title={title}
      onClose={onClose}
      footer={
        <>
          <button class="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <span title={canWin ? undefined : ESTIMATE_SENT_TOOLTIP}>
            <button
              class="btn btn--primary"
              disabled={!canWin || !amountValid || saving}
              onClick={confirm}
            >
              {saving ? "Converting…" : confirmLabel}
            </button>
          </span>
        </>
      }
    >
      {request && (
        <div class="won-confirm">
          <p>
            <strong>{request.client_name}</strong> · REQ-
            {String(request.request_number).padStart(3, "0")}
          </p>
          {preferredMethod && (preferredMethod === "cash" || preferredMethod === "check") && (
            <p class="won-confirm__note">
              Client selected: <strong>{preferredMethod === "cash" ? "Cash" : "Check"}</strong> —
              awaiting your confirmation.
            </p>
          )}

          {canWin ? (
            <>
              <FormField label="Deposit amount" required>
                <input
                  class="form-input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
                />
              </FormField>
              <FormField label="Payment method" required>
                <Select
                  value={method}
                  options={WON_PAYMENT_METHODS}
                  onChange={setMethod}
                />
              </FormField>
              <FormField label="Reference / note">
                <input
                  class="form-input"
                  type="text"
                  placeholder="Check #, date received, etc."
                  value={reference}
                  onInput={(e) => setReference((e.target as HTMLInputElement).value)}
                />
              </FormField>
              <p class="won-confirm__note">
                Confirming records the deposit, creates the job at “Deposit Paid,” and closes this
                request. This is the same conversion path as an online Stripe payment.
              </p>
            </>
          ) : (
            <p class="won-confirm__blocked">{ESTIMATE_SENT_TOOLTIP}</p>
          )}
        </div>
      )}
    </Modal>
  );
}
