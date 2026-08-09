import { useEffect, useState } from "preact/hooks";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { go } from "../../lib/nav";
import { api } from "../../api";
import { useToast } from "../../store/toast";
import { ClientForm } from "../../views/clients/ClientForm";
import {
  RecordPaymentModal,
  type PaymentInvoice,
} from "../../views/financial/RecordPaymentModal";
import { NewNoteModal } from "../notes/NewNoteModal";

type PickerMode =
  | "photo"
  | "task"
  | "expense"
  | "daily_log"
  | "payment"
  | "payment_invoice"
  | null;

interface ActiveJob {
  id: string;
  title: string | null;
  client_name: string | null;
}

interface InvoiceLite {
  id: string;
  invoice_number: number | null;
  invoice_display: string;
  total_due: number | null;
  paid_amount: number | null;
  status: string | null;
}

const OPTIONS = [
  { key: "photo" as const, icon: "📷", label: "Add Photo" },
  { key: "note" as const, icon: "📝", label: "New Note" },
  { key: "task" as const, icon: "✅", label: "Add Task" },
  { key: "expense" as const, icon: "💵", label: "Log Expense" },
  { key: "daily_log" as const, icon: "📒", label: "Daily Log" },
  { key: "client" as const, icon: "👤", label: "New Client" },
  { key: "estimate" as const, icon: "📋", label: "New Estimate" },
  { key: "payment" as const, icon: "💳", label: "Record Payment" },
];

function jobLabel(j: ActiveJob): string {
  const title = j.title ?? j.client_name ?? "Job";
  return title;
}

function isOutstanding(inv: InvoiceLite): boolean {
  if (inv.status === "void" || inv.status === "paid") return false;
  const balance = Math.max(
    0,
    Math.round(((inv.total_due ?? 0) - (inv.paid_amount ?? 0)) * 100) / 100,
  );
  return balance > 0;
}

function toPaymentInvoice(inv: InvoiceLite): PaymentInvoice {
  return {
    id: inv.id,
    invoice_display: inv.invoice_display,
    total_due: inv.total_due,
    paid_amount: inv.paid_amount,
  };
}

export type QuickCaptureStartMode = "photo" | "expense";

export function QuickCaptureSheet({
  open,
  jobId,
  onClose,
  /** Skip the + menu and open directly on a job picker (Dashboard Quick Actions). */
  startMode = null,
}: {
  open: boolean;
  jobId: string | null;
  onClose: () => void;
  startMode?: QuickCaptureStartMode | null;
}) {
  const toast = useToast();
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [jobs, setJobs] = useState<ActiveJob[] | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [invoices, setInvoices] = useState<InvoiceLite[] | null>(null);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [payInvoice, setPayInvoice] = useState<PaymentInvoice | null>(null);
  // ClientForm outlives the sheet close — same modal as Clients "+ New Client".
  const [showClientForm, setShowClientForm] = useState(false);
  const [showNewNote, setShowNewNote] = useState(false);

  useEffect(() => {
    if (!open) {
      setPickerMode(null);
      setJobs(null);
      setInvoices(null);
      return;
    }
    if (startMode) setPickerMode(startMode);
  }, [open, startMode]);

  // Prefer state; fall back to startMode so Dashboard opens skip a one-frame menu flash.
  const mode: PickerMode = open ? (pickerMode ?? startMode ?? null) : null;

  useEffect(() => {
    if (
      !open ||
      (mode !== "photo" &&
        mode !== "task" &&
        mode !== "expense" &&
        mode !== "daily_log" &&
        mode !== "payment")
    ) {
      return;
    }
    setJobsLoading(true);
    api
      .get<{ jobs: ActiveJob[] }>("/api/jobs/active")
      .then((r) => setJobs(r.jobs ?? []))
      .catch(() => setJobs([]))
      .finally(() => setJobsLoading(false));
  }, [open, mode]);

  if (!open && !showClientForm && !payInvoice && !showNewNote) return null;

  const finish = () => {
    setPickerMode(null);
    setInvoices(null);
    onClose();
  };

  const goWithJob = (pickedJobId: string, tab: string) => {
    finish();
    go(`/jobs/${pickedJobId}?tab=${tab}`);
  };

  const openPaymentModal = (inv: InvoiceLite) => {
    setPayInvoice(toPaymentInvoice(inv));
    finish();
  };

  const loadInvoicesForJob = (pickedJobId: string) => {
    setPickerMode("payment_invoice");
    setInvoices(null);
    setInvoicesLoading(true);
    api
      .get<{ invoices: InvoiceLite[] }>(`/api/jobs/${pickedJobId}/invoices`)
      .then((r) => {
        const outstanding = (r.invoices ?? []).filter(isOutstanding);
        if (outstanding.length === 1) {
          openPaymentModal(outstanding[0]);
          return;
        }
        setInvoices(outstanding);
      })
      .catch(() => setInvoices([]))
      .finally(() => setInvoicesLoading(false));
  };

  const onOption = (key: (typeof OPTIONS)[number]["key"]) => {
    switch (key) {
      case "photo":
        if (jobId) goWithJob(jobId, "photos");
        else setPickerMode("photo");
        break;
      case "note":
        setShowNewNote(true);
        onClose();
        break;
      case "task":
        if (jobId) goWithJob(jobId, "tasks");
        else setPickerMode("task");
        break;
      case "expense":
        if (jobId) goWithJob(jobId, "financial");
        else setPickerMode("expense");
        break;
      case "daily_log":
        if (jobId) goWithJob(jobId, "daily_logs");
        else setPickerMode("daily_log");
        break;
      case "client":
        // Close sheet, then open the same ClientForm the Clients page uses.
        setShowClientForm(true);
        onClose();
        break;
      case "estimate":
        // Same intake as Client detail "+ New Estimate" / EstimateRequestForm.
        finish();
        go("/estimating/new");
        break;
      case "payment":
        if (jobId) loadInvoicesForJob(jobId);
        else setPickerMode("payment");
        break;
    }
  };

  const pickerTab =
    mode === "photo"
      ? "photos"
      : mode === "task"
        ? "tasks"
        : mode === "expense"
          ? "financial"
          : "daily_logs";
  const pickerTitle =
    mode === "photo"
      ? "Pick a job for the photo"
      : mode === "task"
        ? "Pick a job for the task"
        : mode === "expense"
          ? "Pick a job for the expense"
          : mode === "payment"
            ? "Pick a job for the payment"
            : mode === "payment_invoice"
              ? "Pick an invoice"
              : "Pick a job for the daily log";

  const showJobPicker =
    mode === "photo" ||
    mode === "task" ||
    mode === "expense" ||
    mode === "daily_log" ||
    mode === "payment";

  return (
    <>
      {open && (
        <>
          <div class="quick-capture-sheet__backdrop" onClick={finish} aria-hidden="true" />
          <div
            class="quick-capture-sheet quick-capture-sheet--open"
            role="dialog"
            aria-modal="true"
            aria-label="Quick capture"
          >
            <div class="quick-capture-sheet__handle" aria-hidden="true" />

            {showJobPicker ? (
              <>
                <p class="quick-capture-sheet__title">{pickerTitle}</p>
                {jobsLoading && <Spinner center />}
                {!jobsLoading && (jobs?.length ?? 0) === 0 && (
                  <p class="text--muted" style={{ textAlign: "center", padding: "var(--space-md)" }}>
                    No active jobs found.
                  </p>
                )}
                {!jobsLoading &&
                  jobs?.map((j) => (
                    <button
                      key={j.id}
                      type="button"
                      class="quick-capture-option"
                      onClick={() =>
                        mode === "payment"
                          ? loadInvoicesForJob(j.id)
                          : goWithJob(j.id, pickerTab)
                      }
                    >
                      <span>{jobLabel(j)}</span>
                    </button>
                  ))}
                <div style={{ marginTop: "var(--space-md)", textAlign: "center" }}>
                  <Button
                    variant="secondary"
                    onClick={() => (startMode ? finish() : setPickerMode(null))}
                  >
                    {startMode ? "Cancel" : "Back"}
                  </Button>
                </div>
              </>
            ) : mode === "payment_invoice" ? (
              <>
                <p class="quick-capture-sheet__title">{pickerTitle}</p>
                {invoicesLoading && <Spinner center />}
                {!invoicesLoading && (invoices?.length ?? 0) === 0 && (
                  <p class="text--muted" style={{ textAlign: "center", padding: "var(--space-md)" }}>
                    No outstanding invoices for this job.
                  </p>
                )}
                {!invoicesLoading &&
                  invoices?.map((inv) => (
                    <button
                      key={inv.id}
                      type="button"
                      class="quick-capture-option"
                      onClick={() => openPaymentModal(inv)}
                    >
                      <span>{inv.invoice_display}</span>
                    </button>
                  ))}
                <div style={{ marginTop: "var(--space-md)", textAlign: "center" }}>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setInvoices(null);
                      if (jobId) setPickerMode(null);
                      else setPickerMode("payment");
                    }}
                  >
                    Back
                  </Button>
                </div>
              </>
            ) : (
              <>
                {OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    class="quick-capture-option"
                    onClick={() => onOption(opt.key)}
                  >
                    <span class="quick-capture-option__icon" aria-hidden="true">
                      {opt.icon}
                    </span>
                    <span>{opt.label}</span>
                  </button>
                ))}
                <div style={{ marginTop: "var(--space-md)", textAlign: "center" }}>
                  <Button variant="secondary" onClick={finish}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        </>
      )}

      <ClientForm
        open={showClientForm}
        mode="create"
        onClose={() => setShowClientForm(false)}
        onSaved={(c) => {
          setShowClientForm(false);
          go(`/clients/${c.id}`);
        }}
      />

      {payInvoice && (
        <RecordPaymentModal
          invoice={payInvoice}
          onClose={() => setPayInvoice(null)}
          onRecorded={() => setPayInvoice(null)}
          toast={toast}
        />
      )}

      <NewNoteModal
        open={showNewNote}
        jobId={jobId}
        enteredVia="quick_capture"
        onClose={() => setShowNewNote(false)}
      />
    </>
  );
}
