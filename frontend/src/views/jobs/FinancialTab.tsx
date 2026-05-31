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
 * Job Detail → Financial tab (Sprint 9). Shows the job's invoice ledger
 * (summary bar + invoice list), the Invoice Builder (with server-suggested
 * draws/trades pre-filled), per-invoice actions (send, copy pay link, void),
 * and manual (check/cash) payment recording.
 */

interface InvoiceRow {
  id: string;
  invoice_number: number | null;
  invoice_display: string;
  invoice_type: string | null;
  title: string | null;
  amount: number | null;
  tax_amount: number;
  late_fee_amount: number;
  credits_applied: number;
  total_due: number | null;
  status: string | null;
  sent_date: string | null;
  due_date: string | null;
  paid_amount: number | null;
  payment_token: string | null;
}
interface MilestoneSuggestion {
  billing_schedule_id: string;
  invoice_type: "milestone";
  milestone_number: number;
  title: string;
  amount: number;
  percentage: number | null;
}
interface TradeSuggestion {
  billing_schedule_id: string;
  invoice_type: "trade_completion";
  trade_line_item_id: string;
  title: string;
  amount: number;
  task_group: string;
}
interface FinalSuggestion {
  invoice_type: "final";
  title: string;
  amount: number;
}
interface JobInvoicesResponse {
  job_id: string;
  billing_model: string | null;
  summary: {
    contract_total: number;
    total_invoiced: number;
    total_paid: number;
    balance_due: number;
  };
  invoices: InvoiceRow[];
  suggestions: {
    milestones: MilestoneSuggestion[];
    trades: TradeSuggestion[];
    final: FinalSuggestion | null;
  };
}

type ToastApi = ReturnType<typeof useToast>;

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "error" | "info"> = {
  draft: "neutral",
  sent: "info",
  viewed: "info",
  partial: "warning",
  past_due: "error",
  paid: "success",
  void: "neutral",
};

interface Prefill {
  invoice_type: string;
  title: string;
  amount: number;
  milestone_number?: number;
  trade_line_item_id?: string;
  billing_schedule_id?: string;
}

export function FinancialTab({ jobId }: { jobId: string }) {
  const { data, loading, error, refetch } = useApi<JobInvoicesResponse>(`/api/jobs/${jobId}/invoices`);
  const toast = useToast();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [payFor, setPayFor] = useState<InvoiceRow | null>(null);

  if (loading) return <Spinner center />;
  if (error || !data) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">💳</div>
        <div class="empty-state__title">Financials unavailable</div>
        <div>{error ?? "Could not load invoices for this job."}</div>
      </div>
    );
  }

  const openBuilder = (p: Prefill | null) => {
    setPrefill(p);
    setBuilderOpen(true);
  };

  const suggestions = data.suggestions;
  const hasSuggestions =
    suggestions.milestones.length > 0 || suggestions.trades.length > 0 || suggestions.final != null;

  const sendInvoice = async (inv: InvoiceRow) => {
    try {
      await api.post(`/api/invoices/${inv.id}/send`, {});
      toast.push("success", `${inv.invoice_display} sent`);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const voidInvoice = async (inv: InvoiceRow) => {
    if (!confirm(`Void ${inv.invoice_display}? It will be preserved for audit but no longer collectible.`)) {
      return;
    }
    try {
      await api.post(`/api/invoices/${inv.id}/void`, { reason: "voided from financial tab" });
      toast.push("success", `${inv.invoice_display} voided`);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const copyLink = async (inv: InvoiceRow) => {
    if (!inv.payment_token) return;
    const url = `${window.location.origin}/pay/${inv.payment_token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.push("success", "Payment link copied");
    } catch {
      toast.push("info", url);
    }
  };

  return (
    <div class="stack">
      <div class="fin-summary">
        <SummaryStat label="Contract" value={data.summary.contract_total} />
        <SummaryStat label="Invoiced" value={data.summary.total_invoiced} />
        <SummaryStat label="Collected" value={data.summary.total_paid} tone="success" />
        <SummaryStat label="Balance Due" value={data.summary.balance_due} tone="warning" />
      </div>

      <div class="flex items-center justify-between gap-sm">
        <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          {data.invoices.length} invoice(s) · {formatStatus(data.billing_model)}
        </span>
        <Button variant="primary" size="sm" onClick={() => openBuilder(null)}>
          + New Invoice
        </Button>
      </div>

      {hasSuggestions && (
        <Card title="Suggested invoices">
          <div class="stack">
            {suggestions.milestones.map((m) => (
              <SuggestionRow
                key={m.billing_schedule_id}
                label={m.title}
                sub={`Milestone ${m.milestone_number}${m.percentage != null ? ` · ${m.percentage}%` : ""}`}
                amount={m.amount}
                onCreate={() =>
                  openBuilder({
                    invoice_type: "milestone",
                    title: m.title,
                    amount: m.amount,
                    milestone_number: m.milestone_number,
                    billing_schedule_id: m.billing_schedule_id,
                  })
                }
              />
            ))}
            {suggestions.trades.map((t) => (
              <SuggestionRow
                key={t.billing_schedule_id}
                label={t.title}
                sub={`Trade · ${t.task_group} complete`}
                amount={t.amount}
                onCreate={() =>
                  openBuilder({
                    invoice_type: "trade_completion",
                    title: t.title,
                    amount: t.amount,
                    trade_line_item_id: t.trade_line_item_id,
                    billing_schedule_id: t.billing_schedule_id,
                  })
                }
              />
            ))}
            {suggestions.final && (
              <SuggestionRow
                label={suggestions.final.title}
                sub="Remaining contract balance"
                amount={suggestions.final.amount}
                onCreate={() =>
                  openBuilder({
                    invoice_type: "final",
                    title: suggestions.final!.title,
                    amount: suggestions.final!.amount,
                  })
                }
              />
            )}
          </div>
        </Card>
      )}

      <Card title="Invoices">
        {data.invoices.length === 0 ? (
          <div class="empty-state">
            <div class="empty-state__icon">🧾</div>
            <div class="empty-state__title">No invoices yet</div>
            <div>Create the first invoice for this job.</div>
          </div>
        ) : (
          <div class="invoice-list">
            {data.invoices.map((inv) => (
              <div class="invoice-row" key={inv.id}>
                <div class="invoice-row__main">
                  <div class="invoice-row__title">
                    <strong>{inv.invoice_display}</strong>
                    <Badge tone={STATUS_TONE[inv.status ?? "draft"] ?? "neutral"}>
                      {formatStatus(inv.status)}
                    </Badge>
                  </div>
                  <div class="invoice-row__meta">
                    {inv.title ?? formatStatus(inv.invoice_type)}
                    {inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ""}
                    {inv.late_fee_amount > 0 ? ` · late fee ${formatCurrency(inv.late_fee_amount)}` : ""}
                  </div>
                </div>
                <div class="invoice-row__amount">
                  <div>{formatCurrency(inv.total_due)}</div>
                  {(inv.paid_amount ?? 0) > 0 && (
                    <div class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                      paid {formatCurrency(inv.paid_amount)}
                    </div>
                  )}
                </div>
                <div class="invoice-row__actions">
                  {inv.status === "draft" && (
                    <Button size="sm" variant="primary" onClick={() => sendInvoice(inv)}>
                      Send
                    </Button>
                  )}
                  {inv.payment_token && inv.status !== "draft" && inv.status !== "void" && (
                    <Button size="sm" variant="tertiary" onClick={() => copyLink(inv)}>
                      Copy link
                    </Button>
                  )}
                  {inv.status !== "void" && inv.status !== "paid" && (
                    <Button size="sm" variant="secondary" onClick={() => setPayFor(inv)}>
                      Record payment
                    </Button>
                  )}
                  {inv.status !== "void" && inv.status !== "paid" && (
                    <Button size="sm" variant="danger" onClick={() => voidInvoice(inv)}>
                      Void
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {builderOpen && (
        <InvoiceBuilder
          jobId={jobId}
          prefill={prefill}
          onClose={() => setBuilderOpen(false)}
          onCreated={() => {
            setBuilderOpen(false);
            refetch();
          }}
          toast={toast}
        />
      )}

      {payFor && (
        <RecordPaymentModal
          invoice={payFor}
          onClose={() => setPayFor(null)}
          onRecorded={() => {
            setPayFor(null);
            refetch();
          }}
          toast={toast}
        />
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "warning";
}) {
  return (
    <div class={`fin-stat${tone ? ` fin-stat--${tone}` : ""}`}>
      <div class="fin-stat__label">{label}</div>
      <div class="fin-stat__value">{formatCurrency(value)}</div>
    </div>
  );
}

function SuggestionRow({
  label,
  sub,
  amount,
  onCreate,
}: {
  label: string;
  sub: string;
  amount: number;
  onCreate: () => void;
}) {
  return (
    <div class="invoice-row">
      <div class="invoice-row__main">
        <div class="invoice-row__title">{label}</div>
        <div class="invoice-row__meta">{sub}</div>
      </div>
      <div class="invoice-row__amount">{formatCurrency(amount)}</div>
      <div class="invoice-row__actions">
        <Button size="sm" variant="primary" onClick={onCreate}>
          Create
        </Button>
      </div>
    </div>
  );
}

const INVOICE_TYPE_OPTIONS = [
  { value: "milestone", label: "Milestone Draw" },
  { value: "trade_completion", label: "Trade Completion" },
  { value: "final", label: "Final Invoice" },
  { value: "change_order", label: "Change Order" },
  { value: "deposit", label: "Deposit" },
  { value: "manual", label: "Manual" },
];

function InvoiceBuilder({
  jobId,
  prefill,
  onClose,
  onCreated,
  toast,
}: {
  jobId: string;
  prefill: Prefill | null;
  onClose: () => void;
  onCreated: () => void;
  toast: ToastApi;
}) {
  const [invoiceType, setInvoiceType] = useState(prefill?.invoice_type ?? "manual");
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [amount, setAmount] = useState(prefill ? String(prefill.amount) : "");
  const [tax, setTax] = useState("");
  const [credits, setCredits] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);

  const amt = Number(amount);
  const taxN = Number(tax) || 0;
  const creditsN = Number(credits) || 0;
  const totalDue = Math.max(0, Math.round((amt + taxN - creditsN) * 100) / 100);
  const valid = Number.isFinite(amt) && amt > 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.post(`/api/invoices`, {
        job_id: jobId,
        invoice_type: invoiceType,
        title: title.trim() || null,
        description: description.trim() || null,
        amount: amt,
        tax_amount: taxN,
        credits_applied: creditsN,
        due_date: dueDate || null,
        milestone_number: prefill?.milestone_number ?? null,
        trade_line_item_id: prefill?.trade_line_item_id ?? null,
        billing_schedule_id: prefill?.billing_schedule_id ?? null,
      });
      toast.push("success", "Invoice created (draft)");
      onCreated();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="New Invoice"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Creating…" : "Create Draft"}
          </Button>
        </>
      }
    >
      <FormField label="Type" required>
        <Select value={invoiceType} options={INVOICE_TYPE_OPTIONS} onChange={setInvoiceType} />
      </FormField>
      <FormField label="Title">
        <input
          class="form-input"
          value={title}
          placeholder="e.g. Milestone Draw 2"
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
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
      <div class="form-row">
        <FormField label="Tax">
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            value={tax}
            onInput={(e) => setTax((e.target as HTMLInputElement).value)}
          />
        </FormField>
        <FormField label="Credits applied">
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            value={credits}
            onInput={(e) => setCredits((e.target as HTMLInputElement).value)}
          />
        </FormField>
      </div>
      <FormField label="Due date">
        <input
          class="form-input"
          type="date"
          value={dueDate}
          onInput={(e) => setDueDate((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <FormField label="Description / notes">
        <textarea
          class="form-input"
          value={description}
          rows={3}
          onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
        />
      </FormField>
      <div class="invoice-builder__total">
        <span>Total due</span>
        <strong>{formatCurrency(totalDue)}</strong>
      </div>
    </Modal>
  );
}

function RecordPaymentModal({
  invoice,
  onClose,
  onRecorded,
  toast,
}: {
  invoice: InvoiceRow;
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
