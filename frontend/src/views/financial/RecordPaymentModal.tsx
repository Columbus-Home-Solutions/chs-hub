import { useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { api, ApiError } from "../../api";

/** Minimal invoice shape needed to record a manual check/cash payment. */
export interface PaymentInvoice {
  id: string;
  invoice_display: string;
  total_due: number | null;
  paid_amount: number | null;
}

type ToastApi = { push: (kind: "success" | "error" | "info" | "warning", message: string) => void };

/**
 * Shared Record Payment modal (Job Detail → Financial tab + quick-capture).
 * Manual check/cash only — posts to POST /api/payments.
 */
export function RecordPaymentModal({
  invoice,
  onClose,
  onRecorded,
  toast,
}: {
  invoice: PaymentInvoice;
  onClose: () => void;
  onRecorded: () => void;
  toast: ToastApi;
}) {
  const balance = Math.max(
    0,
    Math.round(((invoice.total_due ?? 0) - (invoice.paid_amount ?? 0)) * 100) / 100,
  );
  const [amount, setAmount] = useState(String(balance || ""));
  const [method, setMethod] = useState("check");
  const [receivedDate, setReceivedDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const amt = Number(amount);
  const valid = Number.isFinite(amt) && amt > 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.post(`/api/payments`, {
        invoice_id: invoice.id,
        amount: amt,
        payment_method: method,
        received_date: receivedDate || null,
        notes: notes.trim() || null,
      });
      toast.push("success", "Payment recorded");
      onRecorded();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={`Record payment · ${invoice.invoice_display}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Recording…" : "Record Payment"}
          </Button>
        </>
      }
    >
      <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
        Manual check/cash only — no convenience fee. Card &amp; bank payments go through the client's
        secure payment link.
      </p>
      <FormField label="Method" required>
        <Select
          value={method}
          options={[
            { value: "check", label: "Check" },
            { value: "cash", label: "Cash" },
          ]}
          onChange={setMethod}
        />
      </FormField>
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
      <FormField label="Received date">
        <input
          class="form-input"
          type="date"
          value={receivedDate}
          onInput={(e) => setReceivedDate((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <FormField label="Notes">
        <input
          class="form-input"
          value={notes}
          placeholder="e.g. Check #1042"
          onInput={(e) => setNotes((e.target as HTMLInputElement).value)}
        />
      </FormField>
    </Modal>
  );
}
