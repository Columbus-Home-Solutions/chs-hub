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
 * "Mark as Won" confirmation modal (Module-Spec §4.10). Captures the deposit
 * payment (amount pre-filled from the estimate, method, optional reference) and
 * fires the quote-to-job conversion via POST /api/estimate-requests/:id/win.
 * Used by both the pipeline (drag-to-Won) and the request detail view.
 *
 * The modal is the gate: when the estimate hasn't been sent, the confirm button
 * is disabled and the reason is shown — there is no way to win an unsent quote.
 */
export function MarkWonModal({
  request,
  onClose,
  onWon,
}: {
  request: EstimateRequest | null;
  onClose: () => void;
  onWon: (jobId?: string, jobNumber?: number) => void;
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
      setMethod("check");
      setReference("");
      setSaving(false);
    }
  }, [request?.id]);

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;

  const confirm = async () => {
    if (!request || !canWin || !amountValid || saving) return;
    setSaving(true);
    try {
      const res = await api.post<{ job_id?: string; job_number?: number }>(
        `/api/estimate-requests/${request.id}/win`,
        { deposit_amount: amountNum, payment_method: method, reference: reference || null },
      );
      toast.push("success", "Marked as won — job created");
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
      title="Mark as Won"
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
              {saving ? "Converting…" : "Confirm — Mark as Won"}
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
                request. Won is terminal — it can’t be moved back on the estimating board.
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
