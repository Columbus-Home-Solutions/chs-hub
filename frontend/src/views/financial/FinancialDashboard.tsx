/**
 * /financial top-level route — cross-job invoice dashboard.
 *
 * Pulls GET /api/invoices (all jobs) + GET /api/jobs (for job-title lookup).
 * Each row links through to the job's Financial tab via the JobDetail route.
 * No new API endpoints needed; everything is already wired.
 */

import type { RoutableProps } from "preact-router";
import { useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { useApi } from "../../hooks/useApi";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { go } from "../../lib/nav";
import { formatCurrency, formatDate, formatStatus } from "../../lib/format";

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
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "partial", label: "Partial" },
  { value: "past_due", label: "Past due" },
  { value: "paid", label: "Paid" },
  { value: "void", label: "Void" },
];

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2, CURRENT_YEAR - 3];

export function FinancialDashboard(_props: RoutableProps) {
  const invoicesResp = useApi<{ total: number; invoices: InvoiceRow[] }>("/api/invoices");
  const jobsResp = useApi<{ total: number; jobs: JobStub[] }>("/api/jobs");
  const [statusFilter, setStatusFilter] = useState("");
  const [cpaModalOpen, setCpaModalOpen] = useState(false);
  const [cpaYear, setCpaYear] = useState(String(CURRENT_YEAR));

  if (invoicesResp.loading || jobsResp.loading) return <Spinner center />;

  const invoices = invoicesResp.data?.invoices ?? [];
  const jobMap = new Map<string, JobStub>(
    (jobsResp.data?.jobs ?? []).map((j) => [j.id, j]),
  );

  const filtered = statusFilter
    ? invoices.filter((inv) => inv.status === statusFilter)
    : invoices;

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
