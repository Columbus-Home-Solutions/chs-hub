import { useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { api, ApiError } from "../../api";
import { HISTORICAL_PAYMENT_METHODS } from "../../types";
import type { PaymentInvoice } from "./RecordPaymentModal";

type ToastApi = { push: (kind: "success" | "error" | "info" | "warning", message: string) => void };

/**
 * Owner-only: record a Jobber/Venmo/Zelle/check/cash payment that was collected
 * outside CHS. Never sends the client, never opens a payment link, never hits Stripe.
 */
export function RecordHistoricalPaymentModal({
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
  const [method, setMethod] = useState("jobber");
  const [receivedDate, setReceivedDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("Paid in full via Jobber prior to CHS migration");
  const [busy, setBusy] = useState(false);

  const amt = Number(amount);
  const valid = Number.isFinite(amt) && amt > 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.post(`/api/invoices/${invoice.id}/record-historical-payment`, {
        amount: amt,
        payment_method: method,
        received_date: receivedDate || null,
        notes: notes.trim() || null,
      });
      toast.push("success", "Historical payment recorded — invoice marked paid, nothing sent");
      onRecorded();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={`Record historical payment · ${invoice.invoice_display}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Recording…" : "Record historical payment"}
          </Button>
        </>
      }
    >
      <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
        For money already collected outside CHS (Jobber, Venmo, Zelle, check, cash). This marks
        the invoice paid without emailing the client, creating a payment link, or charging Stripe.
        Unlinked payments already on this job are applied first so totals stay honest.
      </p>
      <FormField label="Method" required>
        <Select value={method} options={[...HISTORICAL_PAYMENT_METHODS]} onChange={setMethod} />
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
      <FormField label="Reference / note">
        <input
          class="form-input"
          value={notes}
          placeholder="Paid via Jobber, migrated to CHS"
          onInput={(e) => setNotes((e.target as HTMLInputElement).value)}
        />
      </FormField>
    </Modal>
  );
}
