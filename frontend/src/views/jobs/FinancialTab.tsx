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
import { useAuth } from "../../store/auth";
import { api, ApiError } from "../../api";
import { formatCurrency, formatDate, formatDateTime, formatStatus } from "../../lib/format";
import {
  ExpenseFormModal,
  type CostingLineLite,
} from "../financial/ExpenseForm";
import {
  fetchReceiptMatches,
  ReceiptMatchReview,
  resolveReceiptPhotoId,
} from "../financial/ReceiptMatchReview";
import { CycleManager } from "./CycleManager";
import { LineItemBilling } from "./LineItemBilling";
import { go } from "../../lib/nav";
import type { QueueItem } from "../financial/ReceiptQueueView";
import type { JobCard, Payer } from "../../types";

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
  line_item_ids?: string | null;
  payer_id?: string | null;
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
interface ChangeOrderSuggestion {
  change_order_id: string;
  invoice_type: "change_order";
  change_order_number: number;
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
    change_orders_total: number;
    change_orders_count: number;
  };
  invoices: InvoiceRow[];
  suggestions: {
    milestones: MilestoneSuggestion[];
    trades: TradeSuggestion[];
    final: FinalSuggestion | null;
    change_orders: ChangeOrderSuggestion[];
  };
}

// ── Sprint 10 shapes ────────────────────────────────────────────────────────
interface CostingSubLine {
  id: string;
  description: string | null;
  category: string;
  budget: number;
  actual: number;
  variance: number;
  status: "under" | "within" | "over";
}
interface CostingLine {
  line_item_id: string;
  name: string;
  budget: number;
  actual: number;
  variance: number;
  status: "under" | "within" | "over";
  sub_items: CostingSubLine[];
}
interface CostingResponse {
  costing: {
    job_id: string;
    estimate_id: string | null;
    has_budget: boolean;
    lines: CostingLine[];
    labor_from_time: number;
    unallocated: number;
    totals: { budget: number; actual: number; variance: number; status: "under" | "within" | "over" };
  };
}
interface ExpenseItem {
  id: string;
  job_id: string | null;
  amount: number | null;
  description: string | null;
  incurred_date: string | null;
  vendor: string | null;
  expense_type: string | null;
  estimate_line_item_id: string | null;
  tax_category: string | null;
  is_1099_reportable: boolean;
  sub_id: string | null;
  receipt_url: string | null;
  has_receipt: boolean;
  receipt_photo_id: string | null;
  is_active: boolean;
}
interface ExpensesResponse {
  total: number;
  total_amount: number;
  expenses: ExpenseItem[];
}
interface TimeEntryItem {
  id: string;
  worker: string;
  role: string;
  clock_in: string;
  clock_out: string | null;
  hours: number | null;
  hourly_rate: number | null;
  labor_cost: number | null;
  is_active: boolean;
}
interface TimeEntriesResponse {
  total: number;
  total_hours: number;
  total_labor: number;
  time_entries: TimeEntryItem[];
}

const VARIANCE_TONE: Record<string, "success" | "warning" | "error"> = {
  under: "success",
  within: "warning",
  over: "error",
};

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
  notes?: string;
}

export function FinancialTab({ jobId }: { jobId: string }) {
  const { data, loading, error, refetch } = useApi<JobInvoicesResponse>(`/api/jobs/${jobId}/invoices`);
  const jobDetail = useApi<{ job: JobCard & { payer?: Payer | null } }>(`/api/jobs/${jobId}`);
  const payersList = useApi<{ payers: Payer[] }>("/api/payers");
  const costing = useApi<CostingResponse>(`/api/jobs/${jobId}/costing`);
  const expenses = useApi<ExpensesResponse>(`/api/jobs/${jobId}/expenses`);
  const timeEntries = useApi<TimeEntriesResponse>(`/api/jobs/${jobId}/time-entries`);
  const toast = useToast();
  const { user } = useAuth();
  // Costing + profit/margin are O/PM-only (business rule #9). FC may still log
  // expenses and clock in/out below.
  const canSeeCosting = user?.role === "owner" || user?.role === "project_manager";
  const [builderOpen, setBuilderOpen] = useState(false);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [payFor, setPayFor] = useState<InvoiceRow | null>(null);
  const [detailInvoiceId, setDetailInvoiceId] = useState<string | null>(null);

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
    suggestions.milestones.length > 0 ||
    suggestions.trades.length > 0 ||
    suggestions.final != null ||
    (suggestions.change_orders?.length ?? 0) > 0;

  const costingLines: CostingLineLite[] = (costing.data?.costing.lines ?? []).map((l) => ({
    line_item_id: l.line_item_id,
    name: l.name,
    sub_items: l.sub_items.map((s) => ({ id: s.id, description: s.description, category: s.category })),
  }));
  // Total cost = non-void expenses + time-entry labor; profit on the invoiced basis.
  const totalExpenses = expenses.data?.total_amount ?? 0;
  const laborCost = costing.data?.costing.labor_from_time ?? 0;
  const totalCost = Math.round((totalExpenses + laborCost) * 100) / 100;
  const invoiced = data.summary.total_invoiced;
  const profit = Math.round((invoiced - totalCost) * 100) / 100;
  const marginPct = invoiced > 0 ? Math.round((profit / invoiced) * 1000) / 10 : null;

  const refetchAll = () => {
    refetch();
    costing.refetch();
    expenses.refetch();
    timeEntries.refetch();
  };

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
    const paidWarning = inv.status === "paid"
      ? "\n\nThis invoice has already been paid. Voiding it will drop total paid below the contract balance — create a corrected invoice afterward."
      : "";
    if (!confirm(`Void ${inv.invoice_display}? It will be preserved for audit but no longer collectible.${paidWarning}`)) {
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
        {data.summary.change_orders_count > 0 && (
          <SummaryStat
            label={`Change Orders (${data.summary.change_orders_count})`}
            value={data.summary.change_orders_total}
            tone={data.summary.change_orders_total >= 0 ? "success" : "warning"}
          />
        )}
        <SummaryStat label="Invoiced" value={data.summary.total_invoiced} />
        <SummaryStat label="Collected" value={data.summary.total_paid} tone="success" />
        <SummaryStat label="Balance Due" value={data.summary.balance_due} tone="warning" />
        <SummaryStat label="Expenses" value={totalExpenses + laborCost} />
        {canSeeCosting && (
          <>
            <SummaryStat label="Profit" value={profit} tone={profit >= 0 ? "success" : undefined} />
            <div class="fin-stat">
              <div class="fin-stat__label">Margin</div>
              <div class="fin-stat__value">{marginPct == null ? "—" : `${marginPct}%`}</div>
            </div>
          </>
        )}
      </div>

      {data.billing_model === "per_line_item" && <LineItemBilling jobId={jobId} />}

      <PayerField
        jobId={jobId}
        payer={jobDetail.data?.job?.payer ?? null}
        payerId={jobDetail.data?.job?.payer_id ?? null}
        payers={payersList.data?.payers ?? []}
        onUpdated={() => jobDetail.refetch()}
        toast={toast}
      />

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
            {(suggestions.change_orders ?? []).map((c) => (
              <SuggestionRow
                key={c.change_order_id}
                label={c.title}
                sub={`Approved change order CO-${c.change_order_number} · owner-confirmed`}
                amount={c.amount}
                onCreate={() =>
                  openBuilder({
                    invoice_type: "change_order",
                    title: c.title,
                    amount: c.amount,
                    // Links the invoice back to the CO so it stops being suggested.
                    notes: `co:${c.change_order_id}`,
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
                  <Button size="sm" variant="tertiary" onClick={() => setDetailInvoiceId(inv.id)}>
                    View
                  </Button>
                  {inv.status === "draft" && (
                    <Button size="sm" variant="primary" onClick={() => sendInvoice(inv)}>
                      Send
                    </Button>
                  )}
                  {inv.payment_token && inv.status !== "draft" && inv.status !== "void" && (
                    <Button
                      size="sm"
                      variant="tertiary"
                      onClick={() => {
                        const url = `${window.location.origin}/pay/${inv.payment_token}`;
                        window.open(url, "_blank", "noopener,noreferrer");
                      }}
                    >
                      Open ↗
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
                  {inv.status !== "void" && (
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

      {canSeeCosting && data.billing_model === "cost_plus" && <CycleManager jobId={jobId} />}

      {canSeeCosting && (
        <BudgetVsActual costing={costing.data?.costing ?? null} loading={costing.loading} />
      )}

      <ReceiptQueueIndicator jobId={jobId} />

      <ExpensesSection
        jobId={jobId}
        data={expenses.data}
        loading={expenses.loading}
        lines={costingLines}
        onChanged={refetchAll}
        toast={toast}
      />

      <TimeSection
        jobId={jobId}
        data={timeEntries.data}
        loading={timeEntries.loading}
        onChanged={() => {
          timeEntries.refetch();
          costing.refetch();
        }}
        toast={toast}
      />

      <MileageSection jobId={jobId} toast={toast} />

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

      {detailInvoiceId && (
        <InvoiceDetailModal
          invoiceId={detailInvoiceId}
          onClose={() => setDetailInvoiceId(null)}
          onChanged={refetchAll}
          toast={toast}
        />
      )}
    </div>
  );
}

// ── Budget vs. Actual table (O/PM only) ─────────────────────────────────────

function BudgetVsActual({
  costing,
  loading,
}: {
  costing: CostingResponse["costing"] | null;
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (loading) {
    return (
      <Card title="Budget vs. Actual">
        <Spinner />
      </Card>
    );
  }
  if (!costing || !costing.has_budget) {
    return (
      <Card title="Budget vs. Actual">
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          No estimate budget found for this job — costing needs an estimate with line items and
          sub-items.
        </p>
      </Card>
    );
  }
  const toggle = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

  return (
    <Card title="Budget vs. Actual">
      <div class="table-container">
        <table class="table costing-table">
          <thead>
            <tr>
              <th>Line item</th>
              <th class="num">Budget</th>
              <th class="num">Actual</th>
              <th class="num">Variance</th>
            </tr>
          </thead>
          <tbody>
            {costing.lines.map((l) => (
              <>
                <tr key={l.line_item_id} class="costing-row" onClick={() => l.sub_items.length && toggle(l.line_item_id)}>
                  <td>
                    {l.sub_items.length > 0 && <span class="costing-row__caret">{expanded[l.line_item_id] ? "▾" : "▸"}</span>}
                    {l.name}
                  </td>
                  <td class="num">{formatCurrency(l.budget)}</td>
                  <td class="num">{formatCurrency(l.actual)}</td>
                  <td class="num">
                    <Badge tone={VARIANCE_TONE[l.status]}>{formatCurrency(l.variance)}</Badge>
                  </td>
                </tr>
                {expanded[l.line_item_id] &&
                  l.sub_items.map((s) => (
                    <tr key={s.id} class="costing-subrow">
                      <td class="costing-subrow__name">↳ {s.description ?? s.category} <span class="text--muted">({s.category})</span></td>
                      <td class="num">{formatCurrency(s.budget)}</td>
                      <td class="num">{formatCurrency(s.actual)}</td>
                      <td class="num text--muted">{formatCurrency(s.variance)}</td>
                    </tr>
                  ))}
              </>
            ))}
            {costing.labor_from_time > 0 && (
              <tr class="costing-row costing-row--aux">
                <td>Labor (time tracking)</td>
                <td class="num text--muted">—</td>
                <td class="num">{formatCurrency(costing.labor_from_time)}</td>
                <td class="num text--muted">—</td>
              </tr>
            )}
            {costing.unallocated > 0 && (
              <tr class="costing-row costing-row--aux">
                <td>Unallocated</td>
                <td class="num text--muted">—</td>
                <td class="num">{formatCurrency(costing.unallocated)}</td>
                <td class="num text--muted">—</td>
              </tr>
            )}
            <tr class="costing-row costing-row--total">
              <td><strong>Total</strong></td>
              <td class="num"><strong>{formatCurrency(costing.totals.budget)}</strong></td>
              <td class="num"><strong>{formatCurrency(costing.totals.actual)}</strong></td>
              <td class="num">
                <Badge tone={VARIANCE_TONE[costing.totals.status]}>{formatCurrency(costing.totals.variance)}</Badge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Expenses list + Add Expense ─────────────────────────────────────────────

const EXPENSE_TYPE_LABEL: Record<string, string> = {
  material: "Material",
  subcontractor: "Sub",
  labor: "Labor",
  permit: "Permit",
  equipment: "Equipment",
  vehicle: "Vehicle",
  other: "Other",
};

function ExpensesSection({
  jobId,
  data,
  loading,
  lines,
  onChanged,
  toast,
}: {
  jobId: string;
  data: ExpensesResponse | null | undefined;
  loading: boolean;
  lines: CostingLineLite[];
  onChanged: () => void;
  toast: ToastApi;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [pendingByPhotoId, setPendingByPhotoId] = useState<Record<string, string>>({});
  const [reviewReceiptId, setReviewReceiptId] = useState<string | null>(null);
  const expenses = data?.expenses ?? [];

  useEffect(() => {
    const photoIds = [
      ...new Set(
        expenses.map((e) => e.receipt_photo_id).filter((id): id is string => Boolean(id)),
      ),
    ];
    if (photoIds.length === 0) {
      setPendingByPhotoId({});
      return;
    }

    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      await Promise.all(
        photoIds.map(async (photoId) => {
          const receiptPhotoId = await resolveReceiptPhotoId(photoId);
          if (!receiptPhotoId) return;
          try {
            const { status, data: matchData } = await fetchReceiptMatches(receiptPhotoId);
            if (status === 200 && matchData.has_unresolved) {
              next[photoId] = receiptPhotoId;
            }
          } catch {
            // ignore per-row match lookup failures
          }
        }),
      );
      if (!cancelled) setPendingByPhotoId(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [expenses]);

  const voidExpense = async (e: ExpenseItem) => {
    if (!confirm("Void this expense? It stays on file (receipt preserved) but drops out of costing.")) return;
    try {
      await api.put(`/api/expenses/${e.id}`, { action: "void" });
      toast.push("success", "Expense voided");
      onChanged();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <Card
      title="Expenses"
      actions={
        <Button variant="primary" size="sm" onClick={() => setFormOpen(true)}>
          + Add Expense
        </Button>
      }
    >
      {loading ? (
        <Spinner />
      ) : expenses.length === 0 ? (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          No expenses logged for this job yet.
        </p>
      ) : (
        <div class="invoice-list">
          {expenses.map((e) => (
            <div class="invoice-row" key={e.id}>
              {e.receipt_url ? (
                <img class="expense-thumb" src={e.receipt_url} alt="receipt" loading="lazy" />
              ) : (
                <span class="expense-thumb expense-thumb--none">{e.has_receipt ? "🧾" : "—"}</span>
              )}
              <div class="invoice-row__main">
                <div class="invoice-row__title">
                  {e.vendor ?? e.description ?? "Expense"}
                  <Badge tone="neutral">{EXPENSE_TYPE_LABEL[e.expense_type ?? "other"] ?? e.expense_type}</Badge>
                  {e.is_1099_reportable && <Badge tone="info">1099</Badge>}
                  {e.receipt_photo_id && pendingByPhotoId[e.receipt_photo_id] && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setReviewReceiptId(pendingByPhotoId[e.receipt_photo_id!])
                      }
                    >
                      Match items
                    </Button>
                  )}
                </div>
                <div class="invoice-row__meta">
                  {e.tax_category ? formatStatus(e.tax_category) : "Uncategorized"}
                  {e.estimate_line_item_id ? " · aligned" : " · unallocated"}
                  {e.incurred_date ? ` · ${formatDate(e.incurred_date)}` : ""}
                </div>
              </div>
              <div class="invoice-row__amount">{formatCurrency(e.amount)}</div>
              <div class="invoice-row__actions">
                <Button size="sm" variant="danger" onClick={() => voidExpense(e)}>
                  Void
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {formOpen && (
        <ExpenseFormModal
          jobId={jobId}
          lines={lines}
          onClose={() => setFormOpen(false)}
          onSaved={() => {
            setFormOpen(false);
            onChanged();
          }}
        />
      )}

      {reviewReceiptId && (
        <Modal
          open
          title="Receipt item matching"
          onClose={() => setReviewReceiptId(null)}
          footer={
            <Button variant="secondary" onClick={() => setReviewReceiptId(null)}>
              Close
            </Button>
          }
        >
          <ReceiptMatchReview
            receiptPhotoId={reviewReceiptId}
            jobId={jobId}
            toast={toast}
            onComplete={() => {
              setReviewReceiptId(null);
              onChanged();
            }}
          />
        </Modal>
      )}
    </Card>
  );
}

// ── Time entries + clock control ────────────────────────────────────────────

const ROLE_OPTIONS = [
  { value: "general", label: "General ($90)" },
  { value: "pm_skilled", label: "PM / Skilled ($105)" },
];

interface ClockableUser {
  id: string;
  full_name: string;
  role: string;
}

function fullName(u: { first_name: string | null; last_name: string | null } | null): string {
  if (!u) return "";
  return [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
}

function TimeSection({
  jobId,
  data,
  loading,
  onChanged,
  toast,
}: {
  jobId: string;
  data: TimeEntriesResponse | null | undefined;
  loading: boolean;
  onChanged: () => void;
  toast: ToastApi;
}) {
  const { user } = useAuth();
  // Clockable users populate the worker dropdown. On error we fall back to a
  // free-text input below so clock-in still works (graceful degradation).
  const {
    data: clockable,
    loading: clockableLoading,
    error: clockableError,
  } = useApi<ClockableUser[]>("/api/users/clockable");
  const [worker, setWorker] = useState("");
  const [role, setRole] = useState("general");
  const [busy, setBusy] = useState(false);
  const entries = data?.time_entries ?? [];
  const active = entries.filter((e) => e.is_active);

  const workerOptions = (clockable ?? []).map((u) => ({ value: u.full_name, label: u.full_name }));

  // Default the selection to the logged-in user once auth resolves.
  useEffect(() => {
    if (worker) return;
    const me = fullName(user);
    if (me) setWorker(me);
  }, [user, worker]);

  const clockIn = async () => {
    if (!worker.trim()) {
      toast.push("error", "Select a worker");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/time-entries`, { job_id: jobId, worker: worker.trim(), role });
      toast.push("success", `${worker.trim()} clocked in`);
      setWorker("");
      onChanged();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clockOut = async (e: TimeEntryItem) => {
    setBusy(true);
    try {
      await api.put(`/api/time-entries/${e.id}`, { clock_out: new Date().toISOString() });
      toast.push("success", `${e.worker} clocked out`);
      onChanged();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Time tracking">
      <div class="time-clock">
        {clockableError ? (
          <input
            class="form-input"
            placeholder="Worker name"
            value={worker}
            onInput={(e) => setWorker((e.target as HTMLInputElement).value)}
          />
        ) : (
          <Select
            class="time-clock__worker"
            value={worker}
            placeholder={clockableLoading ? "Loading…" : "Select worker"}
            options={workerOptions}
            disabled={clockableLoading}
            onChange={setWorker}
          />
        )}
        <Select value={role} options={ROLE_OPTIONS} onChange={setRole} />
        <Button variant="primary" disabled={busy} onClick={clockIn}>
          Clock In
        </Button>
      </div>

      {active.length > 0 && (
        <div class="stack" style={{ marginTop: "var(--space-sm)" }}>
          {active.map((e) => (
            <div class="invoice-row" key={e.id}>
              <div class="invoice-row__main">
                <div class="invoice-row__title">
                  {e.worker} <Badge tone="success">running</Badge>
                </div>
                <div class="invoice-row__meta">
                  {formatStatus(e.role)} · {formatCurrency(e.hourly_rate)}/hr · in {formatDateTime(e.clock_in)}
                </div>
              </div>
              <div class="invoice-row__actions">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => clockOut(e)}>
                  Clock Out
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: "var(--space-md)" }}>
        {loading ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            No time logged yet.
          </p>
        ) : (
          <div class="invoice-list">
            {entries
              .filter((e) => !e.is_active)
              .map((e) => (
                <div class="invoice-row" key={e.id}>
                  <div class="invoice-row__main">
                    <div class="invoice-row__title">{e.worker}</div>
                    <div class="invoice-row__meta">
                      {formatStatus(e.role)} · {e.hours}h × {formatCurrency(e.hourly_rate)} · {formatDate(e.clock_in)}
                    </div>
                  </div>
                  <div class="invoice-row__amount">{formatCurrency(e.labor_cost)}</div>
                </div>
              ))}
            <div class="invoice-row costing-row--total">
              <div class="invoice-row__main">
                <strong>Total labor · {data?.total_hours ?? 0}h</strong>
              </div>
              <div class="invoice-row__amount">
                <strong>{formatCurrency(data?.total_labor ?? 0)}</strong>
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Mileage (job-scoped) ────────────────────────────────────────────────────

interface MileageItem {
  id: string;
  trip_purpose: string;
  distance_miles: number;
  trip_date: string;
  irs_rate: number | null;
  deduction_amount: number | null;
}

function MileageSection({ jobId, toast }: { jobId: string; toast: ToastApi }) {
  const { data, refetch } = useApi<{ mileage: MileageItem[]; total_deduction: number }>(
    `/api/mileage?job_id=${jobId}`,
  );
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [miles, setMiles] = useState("");
  const [tripDate, setTripDate] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  const rows = data?.mileage ?? [];
  const m = Number(miles);
  // Preview at the current IRS rate (0.70 for 2026) — server snapshots on save.
  const preview = Number.isFinite(m) && m > 0 ? Math.round(m * 0.7 * 100) / 100 : 0;

  const submit = async () => {
    if (!purpose.trim() || !(m > 0)) return;
    setBusy(true);
    try {
      await api.post(`/api/mileage`, {
        job_id: jobId,
        trip_purpose: purpose.trim(),
        distance_miles: m,
        trip_date: tripDate,
      });
      toast.push("success", "Mileage logged");
      setOpen(false);
      setPurpose("");
      setMiles("");
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Card
      title="Mileage"
      actions={
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          + Log Trip
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          No mileage logged for this job.
        </p>
      ) : (
        <div class="invoice-list">
          {rows.map((r) => (
            <div class="invoice-row" key={r.id}>
              <div class="invoice-row__main">
                <div class="invoice-row__title">{formatStatus(r.trip_purpose)}</div>
                <div class="invoice-row__meta">
                  {r.distance_miles} mi × {r.irs_rate} · {formatDate(r.trip_date)}
                </div>
              </div>
              <div class="invoice-row__amount">{formatCurrency(r.deduction_amount)}</div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <Modal
          open
          title="Log Mileage"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!purpose.trim() || !(m > 0) || busy} onClick={submit}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </>
          }
        >
          <FormField label="Trip purpose" required>
            <input
              class="form-input"
              value={purpose}
              placeholder="e.g. Supply run to Lowe's"
              onInput={(e) => setPurpose((e.target as HTMLInputElement).value)}
            />
          </FormField>
          <div class="form-row">
            <FormField label="Distance (miles)" required>
              <input
                class="form-input"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.1"
                value={miles}
                onInput={(e) => setMiles((e.target as HTMLInputElement).value)}
              />
            </FormField>
            <FormField label="Trip date">
              <input
                class="form-input"
                type="date"
                value={tripDate}
                onInput={(e) => setTripDate((e.target as HTMLInputElement).value)}
              />
            </FormField>
          </div>
          <div class="invoice-builder__total">
            <span>Deduction @ IRS rate</span>
            <strong>{formatCurrency(preview)}</strong>
          </div>
        </Modal>
      )}
    </Card>
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
  // Carried-through linkage (e.g. `co:<id>` for a change-order invoice) so the
  // server-side suggestion stops re-offering it once the invoice exists.
  const prefillNotes = prefill?.notes ?? null;
  // Amount is calculated (read-only) when the invoice type is milestone, trade, or final
  // and was opened from a suggestion row. Manual invoices remain fully editable.
  const CALCULATED_TYPES = new Set(["milestone", "trade_completion", "final"]);
  const amountLocked = prefill != null && CALCULATED_TYPES.has(invoiceType);

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
        // Append the CO linkage token to any owner-typed notes.
        notes: [description.trim(), prefillNotes].filter(Boolean).join(" ") || null,
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
      <FormField label={amountLocked ? "Amount (calculated)" : "Amount"} required>
        {amountLocked ? (
          <div class="form-input form-input--readonly">
            {formatCurrency(Number(amount))}
          </div>
        ) : (
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
          />
        )}
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

function PayerField({
  jobId,
  payer,
  payerId,
  payers,
  onUpdated,
  toast,
}: {
  jobId: string;
  payer: Payer | null;
  payerId: string | null;
  payers: Payer[];
  onUpdated: () => void;
  toast: ToastApi;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const matches = payers.filter((p) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [p.company_name, p.contact_name, p.email].filter(Boolean).join(" ").toLowerCase().includes(q);
  }).slice(0, 8);

  const selectPayer = async (id: string | null) => {
    setSaving(true);
    try {
      await api.put(`/api/jobs/${jobId}`, { payer_id: id });
      toast.push("success", id ? "Payer updated" : "Payer cleared");
      setOpen(false);
      onUpdated();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Bill To (Payer)">
      <p class="text--muted" style={{ fontSize: "var(--text-sm)", marginTop: 0 }}>
        Optional third-party payer for invoices. Changing the payer does not affect invoices already issued.
      </p>
      {payer ? (
        <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
          <span>
            <strong>{payer.company_name ?? payer.contact_name}</strong>
            {payer.company_name && <span class="text--muted"> · {payer.contact_name}</span>}
          </span>
          {payer.has_card_on_file && (
            <Badge tone="success">{payer.card_brand} ····{payer.card_last4}</Badge>
          )}
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Change
          </Button>
          <Button size="sm" variant="tertiary" disabled={saving} onClick={() => void selectPayer(null)}>
            Clear
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Select payer…
        </Button>
      )}

      <Modal
        open={open}
        title="Select payer"
        onClose={() => setOpen(false)}
        footer={<Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>}
      >
        <FormField label="Search payers">
          <input
            class="form-input"
            value={query}
            placeholder="Company or contact name…"
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </FormField>
        <div class="stack">
          {matches.map((p) => (
            <button
              key={p.id}
              type="button"
              class="btn btn--secondary"
              style={{ justifyContent: "flex-start", textAlign: "left" }}
              disabled={saving || p.id === payerId}
              onClick={() => void selectPayer(p.id)}
            >
              {p.company_name ? `${p.company_name} (${p.contact_name})` : p.contact_name}
              {p.has_card_on_file && <Badge tone="success" style={{ marginLeft: "var(--space-sm)" }}>Card</Badge>}
            </button>
          ))}
          {matches.length === 0 && <p class="text--muted">No matching payers.</p>}
        </div>
      </Modal>
    </Card>
  );
}

interface InvoicePaymentRow {
  id: string;
  amount: number;
  payment_method: string | null;
  convenience_fee: number | null;
  stripe_fee: number | null;
  net_amount: number | null;
  received_date: string | null;
  notes: string | null;
}

interface InvoiceDetailPayload {
  invoice: InvoiceRow & { invoice_type: string | null; invoice_display?: string };
  payer: (Payer & { display_name?: string; stripe_payment_method_id?: string | null }) | null;
  line_items: { id: string; description: string; amount: number | null }[];
  payments: InvoicePaymentRow[];
}

function InvoiceDetailModal({
  invoiceId,
  onClose,
  onChanged,
  toast,
}: {
  invoiceId: string;
  onClose: () => void;
  onChanged: () => void;
  toast: ToastApi;
}) {
  const { data, loading, refetch } = useApi<InvoiceDetailPayload>(`/api/invoices/${invoiceId}`);
  const [charging, setCharging] = useState(false);

  if (loading || !data) {
    return (
      <Modal open title="Invoice" onClose={onClose}>
        <Spinner center />
      </Modal>
    );
  }

  const inv = data.invoice;
  const balance = Math.max(0, Math.round(((inv.total_due ?? 0) - (inv.paid_amount ?? 0)) * 100) / 100);
  const fee = Math.round(balance * 0.035 * 100) / 100;
  const canCharge =
    inv.status !== "paid" &&
    inv.status !== "void" &&
    !!data.payer?.stripe_payment_method_id &&
    balance > 0;

  const charge = async () => {
    if (!confirm(`Charge ${formatCurrency(balance)} + ${formatCurrency(fee)} fee (${formatCurrency(balance + fee)} total)?`)) {
      return;
    }
    setCharging(true);
    try {
      await api.post(`/api/invoices/${invoiceId}/charge-on-file`, {});
      toast.push("success", "Card charged successfully");
      refetch();
      onChanged();
      onClose();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setCharging(false);
    }
  };

  return (
    <Modal
      open
      title={inv.invoice_display ?? "Invoice"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          {canCharge && (
            <Button variant="primary" disabled={charging} onClick={() => void charge()}>
              {charging ? "Charging…" : "Charge card on file"}
            </Button>
          )}
        </>
      }
    >
      <dl class="kv">
        <div class="kv__row"><dt>Type</dt><dd>{formatStatus(inv.invoice_type)}</dd></div>
        <div class="kv__row"><dt>Status</dt><dd>{formatStatus(inv.status)}</dd></div>
        <div class="kv__row"><dt>Amount</dt><dd>{formatCurrency(inv.total_due)}</dd></div>
        {data.payer && (
          <div class="kv__row">
            <dt>Bill to</dt>
            <dd>{data.payer.display_name ?? data.payer.contact_name}</dd>
          </div>
        )}
      </dl>
      {data.line_items.length > 0 && (
        <>
          <h4 style={{ marginBottom: "var(--space-sm)" }}>Line items</h4>
          <ul>
            {data.line_items.map((li) => (
              <li key={li.id}>
                {li.description} — {formatCurrency(li.amount ?? 0)}
              </li>
            ))}
          </ul>
        </>
      )}
      {data.payments.length > 0 && (
        <>
          <h4 style={{ margin: "var(--space-md) 0 var(--space-sm)" }}>Payments received</h4>
          <table class="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Method</th>
                <th class="num">Amount</th>
                <th class="num">Conv. fee</th>
                <th class="num">Client paid</th>
              </tr>
            </thead>
            <tbody>
              {data.payments.map((pay) => {
                const clientTotal = pay.amount + (pay.convenience_fee ?? 0);
                return (
                  <tr key={pay.id}>
                    <td>{pay.received_date ?? "—"}</td>
                    <td>{formatStatus(pay.payment_method ?? "unknown")}</td>
                    <td class="num">{formatCurrency(pay.amount)}</td>
                    <td class="num">
                      {pay.convenience_fee != null && pay.convenience_fee > 0
                        ? formatCurrency(pay.convenience_fee)
                        : <span class="text--muted">—</span>}
                    </td>
                    <td class="num">
                      <strong>{formatCurrency(clientTotal)}</strong>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.payments.some((p) => p.convenience_fee != null && p.convenience_fee > 0) && (
            <p class="text--muted" style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-xs)" }}>
              Conv. fee = 3.5% processing surcharge on electronic payments (CHS revenue, not part of contract value).
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

// ── Receipt queue indicator ──────────────────────────────────────────────────

function ReceiptQueueIndicator({ jobId }: { jobId: string }) {
  const { data } = useApi<{ queue: QueueItem[]; total: number }>(
    `/api/receipt-photos/queue?job_id=${jobId}`,
  );
  const count = data?.total ?? 0;
  if (count === 0) return null;
  return (
    <div
      class="receipt-queue-indicator"
      role="button"
      tabIndex={0}
      onClick={() => go(`/financial?tab=receipts&job_id=${jobId}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") go(`/financial?tab=receipts&job_id=${jobId}`);
      }}
    >
      <span class="receipt-queue-indicator__icon">💵</span>
      <span>
        <strong>
          {count} receipt{count !== 1 ? "s" : ""} to review
        </strong>{" "}
        — tap to open review queue
      </span>
      <span class="receipt-queue-indicator__arrow">→</span>
    </div>
  );
}
