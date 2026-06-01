import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatCurrency, formatDate, formatStatus } from "../../lib/format";

/**
 * Cost-Plus Cycle Manager (Sprint 11) — mounted inside the Job Detail → Financial
 * tab, gated on billing_model='cost_plus' (O/PM only). Lists the job's billing
 * cycles, shows a real-time budget tracker for the active cycle, drives the
 * mini-budget builder, invoice generation, reconciliation, and the reconciliation
 * report render. Owner/PM desktop-primary surface.
 */

// ── shapes (mirror src/routes/billing-cycles.ts + src/lib/cost-plus.ts) ───────
interface Cycle {
  id: string;
  cycle_number: number;
  period_start: string;
  period_end: string;
  is_final_cycle: number | null;
  status: "planning" | "active" | "reconciling" | "closed";
  projected_materials: number | null;
  projected_labor: number | null;
  projected_subs: number | null;
  projected_subtotal: number | null;
  projected_pm_fee: number | null;
  projected_contractor_fee: number | null;
  projected_total: number | null;
  actual_total: number | null;
  pm_fee_rate: number;
  contractor_fee_rate: number;
  credit_from_prior: number | null;
  credit_to_next: number | null;
  delta: number | null;
  invoice_id: string | null;
  reconciliation_invoice_id: string | null;
  live_actuals: { materials: number; labor: number; subs: number; subtotal: number; total: number } | null;
}
interface CycleListResponse {
  is_cost_plus: boolean;
  cycles: Cycle[];
  unattributed_actuals: { amount: number; has_unattributed: boolean };
}
interface ReconCategory {
  category: string;
  label: string;
  projected: number;
  actual: number;
  variance: number;
}
interface ReconExpense {
  id: string;
  date: string | null;
  vendor: string | null;
  description: string | null;
  expense_type: string | null;
  amount: number;
}
interface ReconReport {
  categories: ReconCategory[];
  expenses: ReconExpense[];
  credit_from_prior: number;
  delta: number;
  credit_to_next: number;
  outcome: "under_budget" | "over_budget" | "on_budget";
  explanation: string;
}
interface CycleDetailResponse {
  cycle: Cycle;
  live_breakdown: {
    materials: number;
    labor: number;
    subs: number;
    subtotal: number;
    pm_fee: number;
    contractor_fee: number;
    total: number;
  } | null;
  report: ReconReport | null;
  invoices: {
    id: string;
    invoice_number: number | null;
    title: string | null;
    amount: number | null;
    credits_applied: number | null;
    total_due: number | null;
    status: string | null;
  }[];
}

type ToastApi = ReturnType<typeof useToast>;

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "info"> = {
  planning: "neutral",
  active: "info",
  reconciling: "warning",
  closed: "success",
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Budget-tracker color logic, matching the Sprint 10 Budget-vs-Actual tones. */
function trackerTone(budget: number, actual: number): "success" | "warning" | "error" {
  if (actual > budget) return "error"; // over
  if (budget > 0 && actual >= budget * 0.9) return "warning"; // within ~10%
  return "success"; // under
}

export function CycleManager({ jobId }: { jobId: string }) {
  const { data, loading, error, refetch } = useApi<CycleListResponse>(
    `/api/jobs/${jobId}/billing-cycles`,
  );
  const toast = useToast();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (loading) {
    return (
      <Card title="Cost-Plus Billing Cycles">
        <Spinner />
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card title="Cost-Plus Billing Cycles">
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          {error ?? "Could not load billing cycles."}
        </p>
      </Card>
    );
  }

  const cycles = data.cycles;
  const openCycle = cycles.find((c) => c.status !== "closed");
  const finalClosed = cycles.some((c) => (c.is_final_cycle ?? 0) === 1 && c.status === "closed");
  // New cycle is gated on the prior cycle being closed (rule #2 / no overlap).
  const canCreate = !openCycle && !finalClosed;
  const createDisabledReason = openCycle
    ? `Cycle ${openCycle.cycle_number} is ${openCycle.status} — reconcile it before starting a new cycle.`
    : finalClosed
      ? "The final cycle is closed; no further cycles."
      : "";

  const priorCredit = (() => {
    const closed = [...cycles].reverse().find((c) => c.status === "closed");
    return round2(closed?.credit_to_next ?? 0);
  })();

  return (
    <Card
      title="Cost-Plus Billing Cycles"
      actions={
        <Button
          variant="primary"
          size="sm"
          disabled={!canCreate}
          title={canCreate ? "" : createDisabledReason}
          onClick={() => setBuilderOpen(true)}
        >
          + New Cycle
        </Button>
      }
    >
      {!canCreate && createDisabledReason && (
        <p class="text--muted" style={{ fontSize: "var(--text-xs)", marginBottom: "var(--space-sm)" }}>
          {createDisabledReason}
        </p>
      )}

      {data.unattributed_actuals.has_unattributed && (
        <div class="callout callout--warning" style={{ marginBottom: "var(--space-sm)" }}>
          <strong>{formatCurrency(data.unattributed_actuals.amount)}</strong> in actual costs fall outside
          every cycle window (a gap between cycles, or before the first / after the last). Widen a cycle's
          dates to capture them so nothing is left unbilled.
        </div>
      )}

      {cycles.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__icon">🗓️</div>
          <div class="empty-state__title">No billing cycles yet</div>
          <div>Create the first two-week mini-budget to start cost-plus billing.</div>
        </div>
      ) : (
        <div class="stack">
          {cycles.map((c) => (
            <CycleRow
              key={c.id}
              cycle={c}
              expanded={expanded === c.id}
              onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
              onChanged={refetch}
              toast={toast}
            />
          ))}
        </div>
      )}

      {builderOpen && (
        <NewCycleModal
          jobId={jobId}
          priorCredit={priorCredit}
          onClose={() => setBuilderOpen(false)}
          onCreated={() => {
            setBuilderOpen(false);
            refetch();
          }}
          toast={toast}
        />
      )}
    </Card>
  );
}

// ── one cycle (summary + expandable detail) ───────────────────────────────────

function CycleRow({
  cycle,
  expanded,
  onToggle,
  onChanged,
  toast,
}: {
  cycle: Cycle;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
  toast: ToastApi;
}) {
  const isFinal = (cycle.is_final_cycle ?? 0) === 1;
  const projected = cycle.projected_total ?? 0;
  const liveTotal = cycle.live_actuals?.total ?? cycle.actual_total ?? 0;
  const showTracker = cycle.status === "active" || cycle.status === "closed";
  const tone = trackerTone(projected, liveTotal);

  return (
    <div class={`cycle-card cycle-card--${cycle.status}`}>
      <div class="invoice-row" style={{ cursor: "pointer" }} onClick={onToggle}>
        <div class="invoice-row__main">
          <div class="invoice-row__title">
            <strong>
              Cycle {cycle.cycle_number}
              {isFinal ? " (Final)" : ""}
            </strong>
            <Badge tone={STATUS_TONE[cycle.status] ?? "neutral"}>{formatStatus(cycle.status)}</Badge>
          </div>
          <div class="invoice-row__meta">
            {formatDate(cycle.period_start)} – {formatDate(cycle.period_end)}
            {(cycle.credit_from_prior ?? 0) !== 0
              ? ` · prior credit ${formatCurrency(cycle.credit_from_prior)}`
              : ""}
          </div>
        </div>
        <div class="invoice-row__amount">
          <div>{formatCurrency(projected)}</div>
          {showTracker && (
            <div style={{ fontSize: "var(--text-xs)" }}>
              <Badge tone={tone}>actual {formatCurrency(liveTotal)}</Badge>
            </div>
          )}
        </div>
      </div>

      {expanded && <CycleDetail cycleId={cycle.id} onChanged={onChanged} toast={toast} />}
    </div>
  );
}

function CycleDetail({
  cycleId,
  onChanged,
  toast,
}: {
  cycleId: string;
  onChanged: () => void;
  toast: ToastApi;
}) {
  const { data, loading, refetch } = useApi<CycleDetailResponse>(`/api/billing-cycles/${cycleId}`);
  const [busy, setBusy] = useState(false);

  if (loading || !data) {
    return (
      <div style={{ padding: "var(--space-sm)" }}>
        <Spinner />
      </div>
    );
  }
  const c = data.cycle;
  const isFinal = (c.is_final_cycle ?? 0) === 1;

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      toast.push("success", label);
      refetch();
      onChanged();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const generateInvoice = () =>
    act("Upfront invoice generated", () =>
      api.post(`/api/billing-cycles/${c.id}/generate-invoice`, {}),
    );
  const reconcileCycle = () =>
    act("Cycle reconciled", () => api.post(`/api/billing-cycles/${c.id}/reconcile`, {}));
  const billFinal = () =>
    act("Final 50% billed", () => api.post(`/api/billing-cycles/${c.id}/bill-final`, {}));

  // Projected vs. actual side-by-side. For an active cycle the "actual" is the
  // live breakdown; for a closed cycle it's the stored reconciliation.
  const live = data.live_breakdown;
  const rows: { label: string; projected: number; actual: number | null }[] = [
    { label: "Materials", projected: c.projected_materials ?? 0, actual: live ? live.materials : null },
    { label: "Labor", projected: c.projected_labor ?? 0, actual: live ? live.labor : null },
    { label: "Subs", projected: c.projected_subs ?? 0, actual: live ? live.subs : null },
    { label: "Subtotal", projected: c.projected_subtotal ?? 0, actual: live ? live.subtotal : null },
    { label: `PM fee (${Math.round(c.pm_fee_rate * 100)}%)`, projected: c.projected_pm_fee ?? 0, actual: live ? live.pm_fee : null },
    {
      label: `Contractor fee (${Math.round(c.contractor_fee_rate * 100)}%)`,
      projected: c.projected_contractor_fee ?? 0,
      actual: live ? live.contractor_fee : null,
    },
    { label: "Total", projected: c.projected_total ?? 0, actual: live ? live.total : null },
  ];

  return (
    <div class="cycle-detail">
      <table class="table">
        <thead>
          <tr>
            <th>Category</th>
            <th class="num">Projected</th>
            <th class="num">{c.status === "closed" ? "Actual" : "Live actual"}</th>
          </tr>
        </thead>
        <tbody>
          {data.report
            ? data.report.categories.map((cat) => (
                <tr key={cat.category} class={cat.category === "total" ? "costing-row--total" : ""}>
                  <td>{cat.label}</td>
                  <td class="num">{formatCurrency(cat.projected)}</td>
                  <td class="num">{formatCurrency(cat.actual)}</td>
                </tr>
              ))
            : rows.map((r) => (
                <tr key={r.label} class={r.label === "Total" ? "costing-row--total" : ""}>
                  <td>{r.label}</td>
                  <td class="num">{formatCurrency(r.projected)}</td>
                  <td class="num">{r.actual == null ? "—" : formatCurrency(r.actual)}</td>
                </tr>
              ))}
        </tbody>
      </table>

      {data.report && (
        <div
          class={`callout callout--${data.report.outcome === "over_budget" ? "warning" : "success"}`}
          style={{ marginTop: "var(--space-sm)" }}
        >
          {data.report.explanation}
          {data.report.delta !== 0 && (
            <>
              {" "}
              <strong>
                Carry to next: {formatCurrency(data.report.credit_to_next)}
                {data.report.credit_to_next < 0 ? " (overage)" : data.report.credit_to_next > 0 ? " (credit)" : ""}
              </strong>
            </>
          )}
        </div>
      )}

      {data.invoices.length > 0 && (
        <div class="stack" style={{ marginTop: "var(--space-sm)" }}>
          {data.invoices.map((inv) => (
            <div class="invoice-row" key={inv.id}>
              <div class="invoice-row__main">
                <div class="invoice-row__title">
                  <strong>INV-{String(inv.invoice_number ?? 0).padStart(3, "0")}</strong>
                  <Badge tone="neutral">{formatStatus(inv.status)}</Badge>
                </div>
                <div class="invoice-row__meta">
                  {inv.title}
                  {(inv.credits_applied ?? 0) !== 0 ? ` · credit ${formatCurrency(inv.credits_applied)}` : ""}
                </div>
              </div>
              <div class="invoice-row__amount">{formatCurrency(inv.total_due)}</div>
            </div>
          ))}
        </div>
      )}

      <div class="flex gap-sm" style={{ marginTop: "var(--space-sm)", flexWrap: "wrap" }}>
        {c.status === "planning" && (
          <Button variant="primary" size="sm" disabled={busy} onClick={generateInvoice}>
            {isFinal ? "Generate 50% Upfront Invoice" : "Generate Invoice"}
          </Button>
        )}
        {c.status === "active" && (
          <Button variant="primary" size="sm" disabled={busy} onClick={reconcileCycle}>
            Reconcile
          </Button>
        )}
        {c.status === "closed" && isFinal && !c.reconciliation_invoice_id && (
          <Button variant="primary" size="sm" disabled={busy} onClick={billFinal}>
            Bill Final 50%
          </Button>
        )}
        {c.status === "closed" && !isFinal && (
          <span class="text--muted" style={{ fontSize: "var(--text-xs)", alignSelf: "center" }}>
            Reconciled · report shown above
          </span>
        )}
      </div>
    </div>
  );
}

// ── new mini-budget modal ─────────────────────────────────────────────────────

function NewCycleModal({
  jobId,
  priorCredit,
  onClose,
  onCreated,
  toast,
}: {
  jobId: string;
  priorCredit: number;
  onClose: () => void;
  onCreated: () => void;
  toast: ToastApi;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const twoWeeks = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
  const [periodStart, setPeriodStart] = useState(today);
  const [periodEnd, setPeriodEnd] = useState(twoWeeks);
  const [materials, setMaterials] = useState("");
  const [labor, setLabor] = useState("");
  const [subs, setSubs] = useState("");
  const [isFinal, setIsFinal] = useState(false);
  const [busy, setBusy] = useState(false);

  const m = Number(materials) || 0;
  const l = Number(labor) || 0;
  const s = Number(subs) || 0;
  const subtotal = round2(m + l + s);
  // Default preview rates (10% / 20%); the server snapshots the effective rates.
  const pmFee = round2(subtotal * 0.1);
  const contractorFee = round2(subtotal * 0.2);
  const total = round2(subtotal + pmFee + contractorFee);
  const upfrontBase = isFinal ? round2(total * 0.5) : total;
  const invoiceAmount = round2(upfrontBase - priorCredit);
  const valid = subtotal > 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.post(`/api/jobs/${jobId}/billing-cycles`, {
        period_start: periodStart,
        period_end: periodEnd,
        projected_materials: m,
        projected_labor: l,
        projected_subs: s,
        is_final_cycle: isFinal,
      });
      toast.push("success", "Billing cycle created");
      onCreated();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="New Billing Cycle"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Creating…" : "Create Mini-Budget"}
          </Button>
        </>
      }
    >
      <div class="form-row">
        <FormField label="Period start" required>
          <input
            class="form-input"
            type="date"
            value={periodStart}
            onInput={(e) => setPeriodStart((e.target as HTMLInputElement).value)}
          />
        </FormField>
        <FormField label="Period end" required>
          <input
            class="form-input"
            type="date"
            value={periodEnd}
            onInput={(e) => setPeriodEnd((e.target as HTMLInputElement).value)}
          />
        </FormField>
      </div>
      <FormField label="Projected materials">
        <input
          class="form-input"
          type="number"
          min="0"
          step="0.01"
          value={materials}
          onInput={(e) => setMaterials((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <FormField label="Projected labor">
        <input
          class="form-input"
          type="number"
          min="0"
          step="0.01"
          value={labor}
          onInput={(e) => setLabor((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <FormField label="Projected subs">
        <input
          class="form-input"
          type="number"
          min="0"
          step="0.01"
          value={subs}
          onInput={(e) => setSubs((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <label class="flex gap-sm items-center" style={{ fontSize: "var(--text-sm)" }}>
        <input type="checkbox" checked={isFinal} onChange={(e) => setIsFinal((e.target as HTMLInputElement).checked)} />
        Final cycle (50% upfront / 50% at completion)
      </label>

      <div class="cycle-preview" style={{ marginTop: "var(--space-md)" }}>
        <PreviewLine label="Subtotal" value={subtotal} />
        <PreviewLine label="PM fee (10%)" value={pmFee} />
        <PreviewLine label="Contractor fee (20%)" value={contractorFee} />
        <PreviewLine label="Cycle total" value={total} strong />
        {isFinal && <PreviewLine label="50% upfront" value={upfrontBase} />}
        {priorCredit !== 0 && (
          <PreviewLine label={priorCredit > 0 ? "Less prior credit" : "Plus prior overage"} value={-priorCredit} />
        )}
        <PreviewLine label="Invoice amount" value={invoiceAmount} strong />
      </div>
    </Modal>
  );
}

function PreviewLine({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div class="invoice-builder__total" style={strong ? {} : { opacity: 0.85 }}>
      <span>{strong ? <strong>{label}</strong> : label}</span>
      {strong ? <strong>{formatCurrency(value)}</strong> : <span>{formatCurrency(value)}</span>}
    </div>
  );
}
