/**
 * /financial top-level route — cross-job invoice dashboard.
 *
 * Pulls GET /api/invoices (all jobs) + GET /api/jobs (for job-title lookup).
 * Each row links through to the job's Financial tab via the JobDetail route.
 * No new API endpoints needed; everything is already wired.
 */

import type { RoutableProps } from "preact-router";
import { useRouter } from "preact-router";
import { useEffect, useMemo, useState } from "preact/hooks";
import { useUrlTab } from "../../hooks/useUrlTab";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { useApi } from "../../hooks/useApi";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { go } from "../../lib/nav";
import { formatCurrency, formatDate, formatStatus } from "../../lib/format";
import { FinancialReports } from "./FinancialReports";
import { PricingIntelligence } from "./PricingIntelligence";
import { ReceiptQueueView } from "./ReceiptQueueView";

type FinTab = "invoices" | "reports" | "pricing" | "receipts";

interface InvoiceRow {
  id: string;
  invoice_display: string;
  invoice_type: string | null;
  title: string | null;
  job_id: string | null;
  status: string | null;
  total_due: number | null;
  paid_amount: number | null;
  due_date: string | null;
  sent_date: string | null;
}

interface JobStub {
  id: string;
  title: string | null;
  client_name: string | null;
  job_display?: string | null;
}

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "error"> = {
  draft: "neutral",
  sent: "info",
  viewed: "info",
  partial: "warning",
  past_due: "error",
  paid: "success",
  void: "neutral",
};

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "__unpaid__", label: "Unpaid (open)" },
  { value: "__paid_this_week__", label: "Paid this week" },
  { value: "past_due", label: "Past due" },
  { value: "__due_soon__", label: "Due in 2 days" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "partial", label: "Partial" },
  { value: "paid", label: "Paid" },
  { value: "void", label: "Void" },
];

/** Sunday-start week boundaries (matches dashboard KPI / WC spreadsheet). */
function currentWeekRange(): { start: string; endExclusive: string; lastDay: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const dow = now.getUTCDay();
  const weekStart = new Date(Date.UTC(y, m, d - dow));
  const weekEnd = new Date(Date.UTC(y, m, d - dow + 7));
  const lastDay = new Date(Date.UTC(y, m, d - dow + 6));
  return {
    start: weekStart.toISOString().slice(0, 10),
    endExclusive: weekEnd.toISOString().slice(0, 10),
    lastDay: lastDay.toISOString().slice(0, 10),
  };
}

interface PaymentRow {
  id: string;
  invoice_id: string | null;
  amount: number | null;
  received_date: string | null;
}

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2, CURRENT_YEAR - 3];

export function FinancialDashboard(_props: RoutableProps) {
  const [{ url }] = useRouter();
  const currentSearch = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";

  const [statusFilter, setStatusFilter] = useState("");
  const [cpaModalOpen, setCpaModalOpen] = useState(false);
  const [cpaYear, setCpaYear] = useState(String(CURRENT_YEAR));
  const weekRange = useMemo(() => currentWeekRange(), []);

  const invoicesResp = useApi<{ total: number; invoices: InvoiceRow[] }>("/api/invoices");
  const jobsResp = useApi<{ total: number; jobs: JobStub[] }>("/api/jobs");
  const paymentsResp = useApi<{ total: number; payments: PaymentRow[] }>(
    statusFilter === "__paid_this_week__"
      ? `/api/payments?from=${weekRange.start}&to=${weekRange.lastDay}`
      : null,
  );
  const [tab, setTab] = useUrlTab(["invoices", "reports", "pricing", "receipts"] as const, "invoices");

  // Re-run whenever the search string changes so sidebar sub-items (same path,
  // different ?filter=) update invoice filters. Tab state is handled by useUrlTab.
  useEffect(() => {
    const params = new URLSearchParams(currentSearch);
    const urlTab = params.get("tab");

    const filter = params.get("filter") ?? params.get("status");
    if (filter === "unpaid") setStatusFilter("__unpaid__");
    else if (filter === "paid_this_week") setStatusFilter("__paid_this_week__");
    else if (filter === "overdue") setStatusFilter("past_due");
    else if (filter === "due_soon") setStatusFilter("__due_soon__");
    else if (filter === "paid") setStatusFilter("paid");
    else if (filter && STATUS_OPTIONS.some((o) => o.value === filter)) setStatusFilter(filter);
    else if (!filter) setStatusFilter("");

    if (urlTab === "expenses") {
      go("/jobs");
    }
  }, [currentSearch]);

  const invoices = invoicesResp.data?.invoices ?? [];
  const jobMap = new Map<string, JobStub>(
    (jobsResp.data?.jobs ?? []).map((j) => [j.id, j]),
  );

  const dueSoonDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return d.toISOString().slice(0, 10);
  }, []);

  const filtered = useMemo(() => {
    if (statusFilter === "__unpaid__") {
      return invoices.filter((inv) =>
        ["sent", "viewed", "partial", "past_due"].includes(inv.status ?? ""),
      );
    }
    if (statusFilter === "__paid_this_week__") {
      const invoiceIds = new Set(
        (paymentsResp.data?.payments ?? [])
          .map((p) => p.invoice_id)
          .filter((id): id is string => Boolean(id)),
      );
      return invoices.filter((inv) => invoiceIds.has(inv.id));
    }
    if (statusFilter === "__due_soon__") {
      return invoices.filter(
        (inv) =>
          ["sent", "viewed", "partial"].includes(inv.status ?? "") && inv.due_date === dueSoonDate,
      );
    }
    if (statusFilter) return invoices.filter((inv) => inv.status === statusFilter);
    return invoices;
  }, [invoices, statusFilter, dueSoonDate, paymentsResp.data?.payments]);

  // Receipt Queue and Pricing Intelligence tabs render without waiting for invoices/jobs.
  if (tab === "receipts" || tab === "pricing") {
    const jobId = new URLSearchParams(currentSearch).get("job_id") ?? undefined;
    return (
      <div>
        <div class="view-header">
          <div>
            <h1 class="view-title">Financial</h1>
          </div>
        </div>
        <FinTabBar tab={tab} setTab={setTab} />
        {tab === "receipts" ? (
          <ReceiptQueueView jobId={jobId} />
        ) : (
          <PricingIntelligence />
        )}
      </div>
    );
  }

  if (invoicesResp.loading || jobsResp.loading) return <Spinner center />;
  if (statusFilter === "__paid_this_week__" && paymentsResp.loading) return <Spinner center />;

  // Summary totals across the filtered set.
  const totalInvoiced = filtered.reduce((s, inv) => s + (inv.total_due ?? 0), 0);
  const totalPaid = filtered.reduce((s, inv) => s + (inv.paid_amount ?? 0), 0);
  const balanceDue = Math.max(0, totalInvoiced - totalPaid);

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Financial</h1>
          <p class="view-subtitle">
            {filtered.length} invoice{filtered.length !== 1 ? "s" : ""} across all jobs
          </p>
        </div>
        <button class="btn btn--secondary btn--sm" onClick={() => setCpaModalOpen(true)}>
          ⬇ CPA Export
        </button>
      </div>

      <FinTabBar tab={tab} setTab={setTab} />

      {tab === "reports" ? (
        <FinancialReports />
      ) : (
        <>

      <Modal
        open={cpaModalOpen}
        title="Download CPA Export"
        onClose={() => setCpaModalOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCpaModalOpen(false)}>Cancel</Button>
            <a
              href={`/api/reports/cpa-export?year=${cpaYear}`}
              download
              class="btn btn--primary"
              onClick={() => setCpaModalOpen(false)}
            >
              Download CSV
            </a>
          </>
        }
      >
        <div style={{ marginBottom: "var(--space-sm)" }}>
          <label class="form-label">Tax Year</label>
          <select
            class="form-input"
            value={cpaYear}
            onChange={(e) => setCpaYear((e.target as HTMLSelectElement).value)}
          >
            {YEAR_OPTIONS.map((y) => (
              <option key={y} value={String(y)}>{y}</option>
            ))}
          </select>
        </div>
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          Generates a CSV with income summary, expense breakdown by IRS category,
          subcontractor 1099 candidates, mileage log, and job profitability.
        </p>
      </Modal>

      {/* Summary bar */}
      <div class="fin-summary" style={{ marginBottom: "var(--space-lg)" }}>
        <SumStat label="Invoiced" value={totalInvoiced} />
        <SumStat label="Collected" value={totalPaid} tone="success" />
        <SumStat label="Balance Due" value={balanceDue} tone={balanceDue > 0 ? "warning" : undefined} />
      </div>

      {/* Filter */}
      <div style={{ marginBottom: "var(--space-md)" }}>
        <select
          class="form-input"
          style={{ width: "auto", minWidth: "160px" }}
          value={statusFilter}
          onChange={(e) => setStatusFilter((e.target as HTMLSelectElement).value)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__icon">💳</div>
          <div class="empty-state__title">No invoices</div>
          <div>
            {statusFilter
              ? `No ${formatStatus(statusFilter)} invoices found.`
              : "Invoices are created inside each job's Financial tab."}
          </div>
        </div>
      ) : (
        <div class="invoice-list">
          {filtered.map((inv) => {
            const job = inv.job_id ? jobMap.get(inv.job_id) : undefined;
            const jobLabel = job
              ? (job.title ?? job.client_name ?? inv.job_id ?? "—")
              : (inv.job_id ?? "—");
            return (
              <div
                key={inv.id}
                class="invoice-row"
                style={{ cursor: "pointer" }}
                onClick={() => inv.job_id && go(`/jobs/${inv.job_id}`)}
              >
                <div class="invoice-row__main">
                  <div class="invoice-row__title">
                    <strong>{inv.invoice_display}</strong>
                    <Badge tone={TONE[inv.status ?? "draft"] ?? "neutral"}>
                      {formatStatus(inv.status)}
                    </Badge>
                  </div>
                  <div class="invoice-row__meta">
                    {jobLabel}
                    {inv.title ? ` · ${inv.title}` : ` · ${formatStatus(inv.invoice_type)}`}
                    {inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ""}
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
              </div>
            );
          })}
        </div>
      )}
        </>
      )}
    </div>
  );
}

function FinTabBar({
  tab,
  setTab,
}: {
  tab: FinTab;
  setTab: (t: FinTab) => void;
}) {
  return (
    <div class="segmented" style={{ marginBottom: "var(--space-lg)" }}>
      <button
        type="button"
        class={`segmented__btn${tab === "invoices" ? " segmented__btn--active" : ""}`}
        onClick={() => setTab("invoices")}
      >
        Invoices
      </button>
      <button
        type="button"
        class={`segmented__btn${tab === "reports" ? " segmented__btn--active" : ""}`}
        onClick={() => setTab("reports")}
      >
        Reports
      </button>
      <button
        type="button"
        class={`segmented__btn${tab === "pricing" ? " segmented__btn--active" : ""}`}
        onClick={() => setTab("pricing")}
      >
        Pricing
      </button>
      <button
        type="button"
        class={`segmented__btn${tab === "receipts" ? " segmented__btn--active" : ""}`}
        onClick={() => setTab("receipts")}
      >
        💵 Receipts
      </button>
    </div>
  );
}

function SumStat({
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
