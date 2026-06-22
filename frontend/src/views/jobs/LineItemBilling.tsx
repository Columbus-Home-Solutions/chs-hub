import { useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatCurrency } from "../../lib/format";

interface LineItemRow {
  id: string;
  description: string;
  amount: number;
  completion_status: string;
  completed_date: string | null;
  invoiced: boolean;
  blocked: boolean;
  blocking_item_description: string | null;
}

interface BillingStatusResponse {
  job_id: string;
  summary: {
    contract_total: number;
    total_invoiced: number;
    amount_remaining: number;
  };
  line_items: LineItemRow[];
}

const STATUS_OPTIONS = [
  { value: "not_started", label: "Not Started" },
  { value: "in_progress", label: "In Progress" },
  { value: "complete", label: "Complete" },
];

function statusBadge(li: LineItemRow) {
  if (li.invoiced) return <Badge tone="neutral">Invoiced</Badge>;
  if (li.blocked) return <Badge tone="warning">Blocked</Badge>;
  switch (li.completion_status) {
    case "complete":
      return <Badge tone="success">Complete</Badge>;
    case "in_progress":
      return <Badge tone="info">In Progress</Badge>;
    default:
      return <Badge tone="neutral">Not Started</Badge>;
  }
}

export function LineItemBilling({ jobId }: { jobId: string }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi<BillingStatusResponse>(
    `/api/jobs/${jobId}/line-items-billing-status`,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateStatus = async (id: string, completion_status: string) => {
    try {
      await api.put(`/api/line-items/${id}`, { completion_status });
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const generateInvoice = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const res = await api.post<{ invoice: { id: string } }>(`/api/jobs/${jobId}/line-item-invoice`, {
        line_item_ids: [...selected],
      });
      toast.push("success", "Invoice created");
      setSelected(new Set());
      if (res.invoice?.id) go(`/jobs/${jobId}?tab=financial&invoice=${res.invoice.id}`);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner center />;
  if (error || !data) return <div class="empty-state">Couldn't load line items: {error}</div>;

  return (
    <Card title="Pay-As-Completed billing">
      <div class="fin-summary" style={{ marginBottom: "var(--space-md)" }}>
        <div class="fin-stat">
          <div class="fin-stat__label">Total scope</div>
          <div class="fin-stat__value">{formatCurrency(data.summary.contract_total)}</div>
        </div>
        <div class="fin-stat">
          <div class="fin-stat__label">Invoiced to date</div>
          <div class="fin-stat__value">{formatCurrency(data.summary.total_invoiced)}</div>
        </div>
        <div class="fin-stat">
          <div class="fin-stat__label">Remaining</div>
          <div class="fin-stat__value">{formatCurrency(data.summary.amount_remaining)}</div>
        </div>
      </div>

      <div class="invoice-list">
        {data.line_items.map((li) => (
          <div
            key={li.id}
            class="invoice-row"
            style={li.invoiced ? { opacity: 0.65, textDecoration: "line-through" } : undefined}
          >
            <div class="invoice-row__main" style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-sm)" }}>
              <input
                type="checkbox"
                checked={selected.has(li.id)}
                disabled={li.invoiced || li.blocked}
                title={li.blocked ? `Blocked until ${li.blocking_item_description} is complete` : undefined}
                onChange={() => toggle(li.id)}
              />
              <div>
                <div class="invoice-row__title">
                  <strong>{li.description}</strong>
                  {statusBadge(li)}
                </div>
                {li.blocked && li.blocking_item_description && (
                  <div class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                    Blocked until {li.blocking_item_description} is complete
                  </div>
                )}
              </div>
            </div>
            <div class="invoice-row__amount">{formatCurrency(li.amount)}</div>
            {!li.invoiced && (
              <div style={{ minWidth: "140px" }}>
                <Select
                  value={li.completion_status}
                  options={STATUS_OPTIONS}
                  onChange={(v) => void updateStatus(li.id, v)}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: "var(--space-md)" }}>
        <Button variant="primary" disabled={selected.size === 0 || busy} onClick={() => void generateInvoice()}>
          {busy ? "Generating…" : `Generate Invoice (${selected.size} selected)`}
        </Button>
      </div>
    </Card>
  );
}
