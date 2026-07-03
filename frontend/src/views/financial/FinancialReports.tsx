/**
 * Financial → Reports tab — four read-only owner reports with CSV export.
 */

import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Spinner } from "../../components/ui/Spinner";
import { Button } from "../../components/ui/Button";
import { formatCurrency, formatDate } from "../../lib/format";
import { downloadCsv } from "../../lib/csv-export";

type ReportKey = "aged" | "projected" | "reengagement" | "revenue" | "variance";

const REPORTS: { key: ReportKey; label: string; endpoint: string }[] = [
  { key: "aged", label: "Aged Receivables", endpoint: "/api/reports/aged-receivables" },
  { key: "projected", label: "Projected Income", endpoint: "/api/reports/projected-income" },
  { key: "reengagement", label: "Client Re-engagement", endpoint: "/api/reports/client-reengagement" },
  { key: "revenue", label: "Job Revenue", endpoint: "/api/reports/job-revenue" },
  { key: "variance", label: "Est. vs. Actual", endpoint: "/api/reports/line-item-variance" },
];

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2, 2024];

export function FinancialReports() {
  const [report, setReport] = useState<ReportKey>("aged");
  const [year, setYear] = useState(String(CURRENT_YEAR));

  const cfg = REPORTS.find((r) => r.key === report)!;
  const url = report === "revenue" ? `${cfg.endpoint}?year=${year}` : cfg.endpoint;
  const { data, loading, error } = useApi<Record<string, unknown>>(url);

  return (
    <div>
      <div class="flex gap-sm flex-wrap items-center" style={{ marginBottom: "var(--space-md)" }}>
        <div class="segmented">
          {REPORTS.map((r) => (
            <button
              key={r.key}
              type="button"
              class={`segmented__btn${report === r.key ? " segmented__btn--active" : ""}`}
              onClick={() => setReport(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
        {report === "revenue" && (
          <select class="form-input" style={{ width: "auto" }} value={year} onChange={(e) => setYear((e.target as HTMLSelectElement).value)}>
            {YEAR_OPTIONS.map((y) => (
              <option key={y} value={String(y)}>{y}</option>
            ))}
          </select>
        )}
      </div>

      {loading && <Spinner center />}
      {error && <div class="empty-state">Couldn't load report: {error}</div>}
      {!loading && !error && data && (
        <>
          {report === "aged" && <AgedReceivablesReport data={data as unknown as AgedData} />}
          {report === "projected" && <ProjectedIncomeReport data={data as unknown as ProjectedData} />}
          {report === "reengagement" && <ReengagementReport data={data as unknown as ReengagementData} />}
          {report === "revenue" && <JobRevenueReport data={data as unknown as RevenueData} year={year} />}
          {report === "variance" && <LineItemVarianceReport data={data as unknown as VarianceData} />}
        </>
      )}
    </div>
  );
}

interface AgedData {
  summary: Record<string, { count: number; total: number }> & { grand_total: number };
  invoices: Array<Record<string, unknown>>;
}

function AgedReceivablesReport({ data }: { data: AgedData }) {
  const buckets = [
    { key: "current", label: "Current" },
    { key: "days_1_30", label: "1–30 days" },
    { key: "days_31_60", label: "31–60 days" },
    { key: "days_61_90", label: "61–90 days" },
    { key: "days_90_plus", label: "90+ days" },
  ];
  const rows = data.invoices ?? [];
  const cols = [
    { key: "invoice_display", label: "Invoice #" },
    { key: "client_name", label: "Client" },
    { key: "job_title", label: "Job" },
    { key: "balance_due", label: "Amount Due" },
    { key: "due_date", label: "Due Date" },
    { key: "days_overdue", label: "Days Overdue" },
  ];

  return (
    <div>
      <ReportHeader
        title="Aged Receivables"
        onCsv={() => downloadCsv("aged-receivables.csv", rows, cols)}
        disabled={rows.length === 0}
      />
      <div class="report-summary-grid">
        {buckets.map((b) => {
          const s = data.summary[b.key] ?? { count: 0, total: 0 };
          return (
            <div key={b.key} class="report-summary-card">
              <div class="report-summary-card__label">{b.label}</div>
              <div class="report-summary-card__value">{formatCurrency(s.total)}</div>
              <div class="text--muted" style={{ fontSize: "var(--text-xs)" }}>{s.count} invoice{s.count !== 1 ? "s" : ""}</div>
            </div>
          );
        })}
      </div>
      {rows.length === 0 ? (
        <EmptyReport />
      ) : (
        <table class="data-table">
          <thead>
            <tr>
              {cols.map((c) => <th key={c.key}>{c.label}</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} class={`aging-row aging-row--${String(r.aging_bucket ?? "current")}`}>
                <td>{String(r.invoice_display ?? "")}</td>
                <td>{String(r.client_name ?? "")}</td>
                <td>{String(r.job_title ?? "")}</td>
                <td>{formatCurrency(Number(r.balance_due ?? 0))}</td>
                <td>{r.due_date ? formatDate(String(r.due_date)) : "—"}</td>
                <td>{Number(r.days_overdue ?? 0)}</td>
                <td>
                  <Button size="sm" variant="tertiary" disabled title="Coming soon">
                    Send Reminder
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface ProjectedData {
  summary: { total_projected: number; due_this_week: number; due_this_month: number; overdue: number };
  invoices: Array<Record<string, unknown>>;
}

function ProjectedIncomeReport({ data }: { data: ProjectedData }) {
  const s = data.summary;
  const rows = data.invoices ?? [];
  const cols = [
    { key: "invoice_display", label: "Invoice #" },
    { key: "client_name", label: "Client" },
    { key: "job_title", label: "Job" },
    { key: "balance_due", label: "Amount" },
    { key: "due_date", label: "Due Date" },
    { key: "status", label: "Status" },
  ];
  return (
    <div>
      <ReportHeader title="Projected Income" onCsv={() => downloadCsv("projected-income.csv", rows, cols)} disabled={rows.length === 0} />
      <div class="report-summary-grid">
        <SummaryCard label="Total Projected" value={formatCurrency(s.total_projected)} />
        <SummaryCard label="Due This Week" value={formatCurrency(s.due_this_week)} />
        <SummaryCard label="Due This Month" value={formatCurrency(s.due_this_month)} />
        <SummaryCard label="Overdue" value={formatCurrency(s.overdue)} />
      </div>
      {rows.length === 0 ? <EmptyReport /> : (
        <table class="data-table">
          <thead><tr>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.invoice_display ?? "")}</td>
                <td>{String(r.client_name ?? "")}</td>
                <td>{String(r.job_title ?? "")}</td>
                <td>{formatCurrency(Number(r.balance_due ?? 0))}</td>
                <td>{r.due_date ? formatDate(String(r.due_date)) : "—"}</td>
                <td>{String(r.status ?? "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface ReengagementData {
  summary: { total_clients: number; never_converted: number; inactive_12_months: number };
  clients: Array<Record<string, unknown>>;
}

function ReengagementReport({ data }: { data: ReengagementData }) {
  const s = data.summary;
  const rows = data.clients ?? [];
  const cols = [
    { key: "name", label: "Client" },
    { key: "phone", label: "Phone" },
    { key: "email", label: "Email" },
    { key: "last_job_completed", label: "Last Job" },
    { key: "total_jobs", label: "Total Jobs" },
    { key: "total_revenue", label: "Total Revenue" },
  ];
  return (
    <div>
      <ReportHeader title="Client Re-engagement" onCsv={() => downloadCsv("client-reengagement.csv", rows, cols)} disabled={rows.length === 0} />
      <div class="report-summary-grid">
        <SummaryCard label="Total Clients" value={String(s.total_clients)} />
        <SummaryCard label="Never Had a Job" value={String(s.never_converted)} />
        <SummaryCard label="Inactive 12+ Months" value={String(s.inactive_12_months)} />
      </div>
      {rows.length === 0 ? <EmptyReport /> : (
        <table class="data-table">
          <thead><tr>{cols.map((c) => <th key={c.key}>{c.label}</th>)}<th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.name ?? "")}</td>
                <td>{String(r.phone ?? "—")}</td>
                <td>{String(r.email ?? "—")}</td>
                <td>{r.last_job_completed ? formatDate(String(r.last_job_completed)) : "No jobs"}</td>
                <td>{Number(r.total_jobs ?? 0)}</td>
                <td>{formatCurrency(Number(r.total_revenue ?? 0))}</td>
                <td>
                  <Button size="sm" variant="tertiary" disabled title="Coming soon">
                    Send Follow-up
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface RevenueData {
  summary: { total_revenue: number; total_collected: number; total_expenses: number; gross_profit: number; job_count: number };
  jobs: Array<Record<string, unknown>>;
}

function JobRevenueReport({ data, year }: { data: RevenueData; year: string }) {
  const s = data.summary;
  const rows = data.jobs ?? [];
  const cols = [
    { key: "job_display", label: "Job #" },
    { key: "client_name", label: "Client" },
    { key: "title", label: "Title" },
    { key: "contract_value", label: "Contract" },
    { key: "total_collected", label: "Collected" },
    { key: "total_expenses", label: "Expenses" },
    { key: "gross_profit", label: "Gross Profit" },
  ];
  return (
    <div>
      <ReportHeader title={`Job Revenue (${year})`} onCsv={() => downloadCsv(`job-revenue-${year}.csv`, rows, cols)} disabled={rows.length === 0} />
      <div class="report-summary-grid">
        <SummaryCard label="Contract Value" value={formatCurrency(s.total_revenue)} />
        <SummaryCard label="Collected" value={formatCurrency(s.total_collected)} />
        <SummaryCard label="Expenses" value={formatCurrency(s.total_expenses)} />
        <SummaryCard label="Gross Profit" value={formatCurrency(s.gross_profit)} />
      </div>
      {rows.length === 0 ? <EmptyReport /> : (
        <table class="data-table">
          <thead><tr>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => {
              const profit = Number(r.gross_profit ?? 0);
              return (
                <tr key={String(r.id)}>
                  <td>{String(r.job_display ?? "")}</td>
                  <td>{String(r.client_name ?? "")}</td>
                  <td>{String(r.title ?? "")}</td>
                  <td>{formatCurrency(Number(r.contract_value ?? 0))}</td>
                  <td>{formatCurrency(Number(r.total_collected ?? 0))}</td>
                  <td>{formatCurrency(Number(r.total_expenses ?? 0))}</td>
                  <td class={profit >= 0 ? "text--success" : "text--error"}>{formatCurrency(profit)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReportHeader({ title, onCsv, disabled }: { title: string; onCsv: () => void; disabled: boolean }) {
  return (
    <div class="flex items-center justify-between gap-sm" style={{ marginBottom: "var(--space-md)" }}>
      <h2 class="view-title" style={{ fontSize: "var(--text-lg)", margin: 0 }}>{title}</h2>
      <Button size="sm" variant="secondary" onClick={onCsv} disabled={disabled}>
        ⬇ Download CSV
      </Button>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div class="report-summary-card">
      <div class="report-summary-card__label">{label}</div>
      <div class="report-summary-card__value">{value}</div>
    </div>
  );
}

function EmptyReport() {
  return (
    <div class="empty-state" style={{ marginTop: "var(--space-lg)" }}>
      <div class="empty-state__title">No data</div>
      <div>Nothing matches this report right now.</div>
    </div>
  );
}

// ── Report 5 — Estimated vs. Actual by Line Item ──────────────────────────

interface VarianceItem {
  description: string;
  category: string | null;
  job_count: number;
  avg_estimated: number;
  avg_actual: number;
  variance_amount: number;
  variance_pct: number | null;
}

interface VarianceData {
  summary: { total_line_items: number; has_data: boolean };
  items: VarianceItem[];
}

function LineItemVarianceReport({ data }: { data: VarianceData }) {
  const rows = data.items ?? [];
  const cols = [
    { key: "description", label: "Line Item" },
    { key: "category", label: "Category" },
    { key: "job_count", label: "Jobs" },
    { key: "avg_estimated", label: "Avg Estimated" },
    { key: "avg_actual", label: "Avg Actual" },
    { key: "variance_amount", label: "Variance $" },
    { key: "variance_pct", label: "Variance %" },
  ];

  if (!data.summary.has_data) {
    return (
      <div>
        <ReportHeader
          title="Estimated vs. Actual by Line Item"
          onCsv={() => downloadCsv("line-item-variance.csv", rows as unknown as Record<string, unknown>[], cols)}
          disabled
        />
        <div class="empty-state" style={{ marginTop: "var(--space-lg)" }}>
          <div class="empty-state__title">Not enough data yet</div>
          <div>
            This report populates as receipts are processed and confirmed through
            the itemized receipt flow. Upload and confirm a few receipts to see
            estimated vs. actual variance by line item.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <ReportHeader
        title="Estimated vs. Actual by Line Item"
        onCsv={() => downloadCsv("line-item-variance.csv", rows as unknown as Record<string, unknown>[], cols)}
        disabled={rows.length === 0}
      />
      <div class="report-summary-grid">
        <SummaryCard label="Line Items Tracked" value={String(data.summary.total_line_items)} />
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Line Item</th>
            <th>Category</th>
            <th>Jobs</th>
            <th>Avg Estimated</th>
            <th>Avg Actual</th>
            <th>Variance $</th>
            <th>Variance %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const variance = r.variance_amount ?? 0;
            const overBudget = variance > 0;
            return (
              <tr key={i}>
                <td>{r.description}</td>
                <td>{r.category ?? "—"}</td>
                <td>{r.job_count}</td>
                <td>{formatCurrency(r.avg_estimated)}</td>
                <td>{formatCurrency(r.avg_actual)}</td>
                <td class={overBudget ? "text--error" : "text--success"}>
                  {overBudget ? "+" : ""}{formatCurrency(variance)}
                </td>
                <td class={overBudget ? "text--error" : "text--success"}>
                  {r.variance_pct !== null ? `${overBudget ? "+" : ""}${r.variance_pct}%` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
