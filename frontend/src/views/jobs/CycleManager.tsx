import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
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
interface ScopeAllocation {
  line_item_id: string;
  percentage: number;
}
interface ScopeLineItem {
  line_item_id: string;
  name: string;
  budget: number;
  materials?: number;
  labor?: number;
  subs?: number;
  sub_items: { id: string; category: string; budget: number }[];
}
interface ScopeContext {
  line_items: ScopeLineItem[];
  cumulative_allocations: Record<string, number>;
}
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
  scope_allocations: string | null;
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
interface ReconItemizedExpense {
  id: string;
  kind: "expense";
  date: string | null;
  vendor: string | null;
  description: string | null;
  expense_type: string | null;
  amount: number;
  sub_name: string | null;
  receipt_url: string | null;
}
interface ReconItemizedTimeEntry {
  id: string;
  kind: "time_entry";
  date: string | null;
  worker: string;
  role: string;
  hours: number | null;
  hourly_rate: number | null;
  amount: number;
}
interface ReconItemized {
  materials: ReconItemizedExpense[];
  labor: ReconItemizedTimeEntry[];
  subs: ReconItemizedExpense[];
}
interface ReconReport {
  categories: ReconCategory[];
  expenses: ReconExpense[];
  itemized: ReconItemized;
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
  scope_context: ScopeContext;
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
type ScopeState = Record<string, { checked: boolean; percentage: string }>;

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "info"> = {
  planning: "neutral",
  active: "info",
  reconciling: "warning",
  closed: "success",
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const ITEMIZED_CATEGORIES = new Set(["materials", "labor", "subs"]);

function formatTimeRole(role: string): string {
  if (role === "pm_skilled") return "PM/Skilled";
  if (role === "general") return "General";
  return role;
}

function expenseLabel(e: ReconItemizedExpense): string {
  const parts = [e.vendor ?? e.sub_name, e.description].filter(Boolean);
  return parts.length ? parts.join(" — ") : e.expense_type ?? "Expense";
}

function ReconItemizedList({
  category,
  itemized,
}: {
  category: string;
  itemized: ReconItemized;
}) {
  if (category === "labor") {
    const items = itemized.labor;
    if (!items.length) return null;
    return (
      <ul class="recon-itemized__list">
        {items.map((t) => (
          <li class="recon-itemized__line" key={t.id}>
            <span class="recon-itemized__desc">
              {t.worker}
              {t.role ? ` (${formatTimeRole(t.role)})` : ""}
              {t.hours != null ? ` · ${t.hours}h` : ""}
              {t.hourly_rate != null ? ` @ ${formatCurrency(t.hourly_rate)}/hr` : ""}
            </span>
            <span class="recon-itemized__date">{t.date ? formatDate(t.date) : "—"}</span>
            <span class="recon-itemized__amount">{formatCurrency(t.amount)}</span>
          </li>
        ))}
      </ul>
    );
  }

  const items = category === "subs" ? itemized.subs : itemized.materials;
  if (!items.length) return null;
  return (
    <ul class="recon-itemized__list">
      {items.map((e) => (
        <li class="recon-itemized__line" key={e.id}>
          <span class="recon-itemized__desc">{expenseLabel(e)}</span>
          <span class="recon-itemized__date">{e.date ? formatDate(e.date) : "—"}</span>
          <span class="recon-itemized__amount">
            {formatCurrency(e.amount)}
            {e.receipt_url && (
              <>
                {" "}
                <a class="recon-itemized__receipt" href={e.receipt_url} target="_blank" rel="noopener noreferrer">
                  view receipt
                </a>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ReconCategoryRows({ report }: { report: ReconReport }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (category: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const itemCount = (category: string) => {
    const itemized = report.itemized ?? { materials: [], labor: [], subs: [] };
    if (category === "materials") return itemized.materials.length;
    if (category === "labor") return itemized.labor.length;
    if (category === "subs") return itemized.subs.length;
    return 0;
  };

  return (
    <>
      {report.categories.map((cat) => {
        const count = ITEMIZED_CATEGORIES.has(cat.category) ? itemCount(cat.category) : 0;
        const isOpen = expanded.has(cat.category);
        return (
          <Fragment key={cat.category}>
            <tr class={cat.category === "total" ? "costing-row--total" : ""}>
              <td>
                <div class="recon-itemized__label">
                  <span>{cat.label}</span>
                  {count > 0 && (
                    <button
                      type="button"
                      class="recon-itemized__toggle"
                      onClick={() => toggle(cat.category)}
                    >
                      {isOpen ? "Hide" : `Show ${count} item${count === 1 ? "" : "s"}`}
                    </button>
                  )}
                </div>
              </td>
              <td class="num">{formatCurrency(cat.projected)}</td>
              <td class="num">{formatCurrency(cat.actual)}</td>
            </tr>
            {isOpen && count > 0 && (
              <tr class="recon-itemized__detail-row">
                <td colSpan={3}>
                  <ReconItemizedList
                    category={cat.category}
                    itemized={report.itemized ?? { materials: [], labor: [], subs: [] }}
                  />
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function parseScopeAllocations(raw: string | null | undefined): ScopeAllocation[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (x): x is ScopeAllocation =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as ScopeAllocation).line_item_id === "string" &&
          Number.isFinite(Number((x as ScopeAllocation).percentage)),
      )
      .map((x) => ({ line_item_id: x.line_item_id, percentage: Number(x.percentage) }));
  } catch {
    return [];
  }
}

function scopeStateFromAllocations(allocations: ScopeAllocation[]): ScopeState {
  const state: ScopeState = {};
  for (const a of allocations) {
    state[a.line_item_id] = { checked: true, percentage: String(a.percentage) };
  }
  return state;
}

function allocationsFromScopeState(scopeState: ScopeState): ScopeAllocation[] {
  return Object.entries(scopeState)
    .filter(([, v]) => v.checked)
    .map(([line_item_id, v]) => ({
      line_item_id,
      percentage: Math.max(0, Number(v.percentage) || 0),
    }));
}

/** Client mirror of src/lib/job-costing.ts projectedCostsFromScope. */
function projectedCostsFromScope(
  lines: ScopeLineItem[],
  allocations: ScopeAllocation[],
): { materials: number; labor: number; subs: number } {
  const pctByLine = new Map(allocations.map((a) => [a.line_item_id, Math.max(0, a.percentage) / 100]));
  let materials = 0;
  let labor = 0;
  let subs = 0;
  for (const line of lines) {
    const factor = pctByLine.get(line.line_item_id);
    if (!factor) continue;
    for (const sub of line.sub_items) {
      const scaled = round2(sub.budget * factor);
      const cat = (sub.category ?? "").toLowerCase();
      if (cat === "labor") labor = round2(labor + scaled);
      else if (cat === "subcontractor") subs = round2(subs + scaled);
      else materials = round2(materials + scaled);
    }
  }
  return { materials, labor, subs };
}

function computePreview(
  materials: number,
  labor: number,
  subs: number,
  pmRate: number,
  contractorRate: number,
) {
  const subtotal = round2(materials + labor + subs);
  const pmFee = round2(subtotal * pmRate);
  const contractorFee = round2(subtotal * contractorRate);
  const total = round2(subtotal + pmFee + contractorFee);
  return { subtotal, pmFee, contractorFee, total };
}

/** Budget-tracker color logic, matching the Sprint 10 Budget-vs-Actual tones. */
function trackerTone(budget: number, actual: number): "success" | "warning" | "error" {
  if (actual > budget) return "error";
  if (budget > 0 && actual >= budget * 0.9) return "warning";
  return "success";
}

/** Full (100%) category rollup for one line item — mirrors categoryCostsForLineItem. */
function categoryCostsForLineItem(line: ScopeLineItem): { materials: number; labor: number; subs: number } {
  return projectedCostsFromScope([line], [{ line_item_id: line.line_item_id, percentage: 100 }]);
}

function ScopeCategoryBreakdown({ line }: { line: ScopeLineItem }) {
  const cats =
    line.materials != null && line.labor != null && line.subs != null
      ? { materials: line.materials, labor: line.labor, subs: line.subs }
      : categoryCostsForLineItem(line);
  return (
    <span class="cycle-scope__breakdown">
      <span class="cycle-scope__breakdown-item">
        <span class="cycle-scope__breakdown-label">Materials</span>
        {formatCurrency(cats.materials)}
      </span>
      <span class="cycle-scope__breakdown-item">
        <span class="cycle-scope__breakdown-label">Labor</span>
        {formatCurrency(cats.labor)}
      </span>
      <span class="cycle-scope__breakdown-item">
        <span class="cycle-scope__breakdown-label">Subs</span>
        {formatCurrency(cats.subs)}
      </span>
    </span>
  );
}

export function CycleManager({
  jobId,
  onInvoicesChanged,
}: {
  jobId: string;
  onInvoicesChanged?: () => void;
}) {
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
              jobId={jobId}
              cycle={c}
              expanded={expanded === c.id}
              onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
              onChanged={() => {
                refetch();
                onInvoicesChanged?.();
              }}
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
            onInvoicesChanged?.();
          }}
          toast={toast}
        />
      )}
    </Card>
  );
}

// ── one cycle (summary + expandable detail) ───────────────────────────────────

function CycleRow({
  jobId,
  cycle,
  expanded,
  onToggle,
  onChanged,
  toast,
}: {
  jobId: string;
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

      {expanded && (
        <CycleDetail jobId={jobId} cycleId={cycle.id} onChanged={onChanged} toast={toast} />
      )}
    </div>
  );
}

function CycleDetail({
  jobId: _jobId,
  cycleId,
  onChanged,
  toast,
}: {
  jobId: string;
  cycleId: string;
  onChanged: () => void;
  toast: ToastApi;
}) {
  const { data, loading, refetch } = useApi<CycleDetailResponse>(`/api/billing-cycles/${cycleId}`);
  const [busy, setBusy] = useState(false);
  const [materials, setMaterials] = useState("");
  const [labor, setLabor] = useState("");
  const [subs, setSubs] = useState("");
  const [scopeState, setScopeState] = useState<ScopeState>({});
  const [manualOverride, setManualOverride] = useState(false);
  const [dirty, setDirty] = useState(false);

  const editable = data?.cycle.status === "planning" || data?.cycle.status === "active";

  useEffect(() => {
    if (!data) return;
    const c = data.cycle;
    setMaterials(String(c.projected_materials ?? 0));
    setLabor(String(c.projected_labor ?? 0));
    setSubs(String(c.projected_subs ?? 0));
    setScopeState(scopeStateFromAllocations(parseScopeAllocations(c.scope_allocations)));
    setManualOverride(false);
    setDirty(false);
  }, [data?.cycle.id, data?.cycle.projected_materials, data?.cycle.projected_labor, data?.cycle.projected_subs, data?.cycle.scope_allocations]);

  if (loading || !data) {
    return (
      <div style={{ padding: "var(--space-sm)" }}>
        <Spinner />
      </div>
    );
  }
  const c = data.cycle;
  const isFinal = (c.is_final_cycle ?? 0) === 1;
  const scopeContext = data.scope_context ?? { line_items: [], cumulative_allocations: {} };

  const m = Number(materials) || 0;
  const l = Number(labor) || 0;
  const s = Number(subs) || 0;
  const preview = computePreview(m, l, s, c.pm_fee_rate, c.contractor_fee_rate);

  const applyScopeToFields = (nextScope: ScopeState) => {
    const allocations = allocationsFromScopeState(nextScope);
    if (!allocations.length) return;
    const projected = projectedCostsFromScope(scopeContext.line_items, allocations);
    setMaterials(String(projected.materials));
    setLabor(String(projected.labor));
    setSubs(String(projected.subs));
  };

  const updateScope = (lineItemId: string, patch: Partial<{ checked: boolean; percentage: string }>) => {
    setDirty(true);
    const next: ScopeState = {
      ...scopeState,
      [lineItemId]: { checked: false, percentage: "100", ...scopeState[lineItemId], ...patch },
    };
    if (patch.checked === false) delete next[lineItemId];
    setScopeState(next);
    if (!manualOverride) applyScopeToFields(next);
  };

  const onFieldInput = (field: "materials" | "labor" | "subs", value: string) => {
    setDirty(true);
    setManualOverride(true);
    if (field === "materials") setMaterials(value);
    else if (field === "labor") setLabor(value);
    else setSubs(value);
  };

  const saveMiniBudget = async () => {
    setBusy(true);
    try {
      await api.put(`/api/billing-cycles/${c.id}`, {
        projected_materials: m,
        projected_labor: l,
        projected_subs: s,
        scope_allocations: allocationsFromScopeState(scopeState),
      });
      toast.push("success", "Mini-budget saved");
      setDirty(false);
      refetch();
      onChanged();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

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

  const live = data.live_breakdown;
  const rows: { label: string; projected: number; actual: number | null }[] = [
    { label: "Materials", projected: m, actual: live ? live.materials : null },
    { label: "Labor", projected: l, actual: live ? live.labor : null },
    { label: "Subs", projected: s, actual: live ? live.subs : null },
    { label: "Subtotal", projected: preview.subtotal, actual: live ? live.subtotal : null },
    {
      label: `PM fee (${Math.round(c.pm_fee_rate * 100)}%)`,
      projected: preview.pmFee,
      actual: live ? live.pm_fee : null,
    },
    {
      label: `Contractor fee (${Math.round(c.contractor_fee_rate * 100)}%)`,
      projected: preview.contractorFee,
      actual: live ? live.contractor_fee : null,
    },
    { label: "Total", projected: preview.total, actual: live ? live.total : null },
  ];

  return (
    <div class="cycle-detail">
      {editable ? (
        <MiniBudgetEditor
          materials={materials}
          labor={labor}
          subs={subs}
          preview={preview}
          pmRate={c.pm_fee_rate}
          contractorRate={c.contractor_fee_rate}
          scopeContext={scopeContext}
          scopeState={scopeState}
          manualOverride={manualOverride}
          dirty={dirty}
          busy={busy}
          onFieldInput={onFieldInput}
          onScopeChange={updateScope}
          onSave={saveMiniBudget}
        />
      ) : (
        <ScopeReadOnly scopeContext={scopeContext} scopeState={scopeState} />
      )}

      <table class="table" style={{ marginTop: "var(--space-sm)" }}>
        <thead>
          <tr>
            <th>Category</th>
            <th class="num">Projected</th>
            <th class="num">{c.status === "closed" ? "Actual" : "Live actual"}</th>
          </tr>
        </thead>
        <tbody>
          {data.report ? (
            <ReconCategoryRows report={data.report} />
          ) : (
            rows.map((r) => (
              <tr key={r.label} class={r.label === "Total" ? "costing-row--total" : ""}>
                <td>{r.label}</td>
                <td class="num">{formatCurrency(r.projected)}</td>
                <td class="num">{r.actual == null ? "—" : formatCurrency(r.actual)}</td>
              </tr>
            ))
          )}
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
                {data.report.credit_to_next < 0
                  ? " (overage)"
                  : data.report.credit_to_next > 0
                    ? " (credit)"
                    : ""}
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
          <Button variant="primary" size="sm" disabled={busy || preview.subtotal <= 0} onClick={generateInvoice}>
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

// ── shared mini-budget + scope UI ─────────────────────────────────────────────

function MiniBudgetEditor({
  materials,
  labor,
  subs,
  preview,
  pmRate,
  contractorRate,
  scopeContext,
  scopeState,
  manualOverride,
  dirty,
  busy,
  onFieldInput,
  onScopeChange,
  onSave,
}: {
  materials: string;
  labor: string;
  subs: string;
  preview: ReturnType<typeof computePreview>;
  pmRate: number;
  contractorRate: number;
  scopeContext: ScopeContext;
  scopeState: ScopeState;
  manualOverride: boolean;
  dirty: boolean;
  busy: boolean;
  onFieldInput: (field: "materials" | "labor" | "subs", value: string) => void;
  onScopeChange: (lineItemId: string, patch: Partial<{ checked: boolean; percentage: string }>) => void;
  onSave: () => void;
}) {
  return (
    <div class="cycle-mini-budget">
      <ScopeChecklist
        scopeContext={scopeContext}
        scopeState={scopeState}
        readOnly={false}
        onScopeChange={onScopeChange}
      />

      {manualOverride && (
        <p class="text--muted cycle-scope-hint" style={{ fontSize: "var(--text-xs)" }}>
          Projected amounts were hand-edited — scope changes won't overwrite them until you clear and re-select.
        </p>
      )}

      <div class="form-row" style={{ marginTop: "var(--space-sm)" }}>
        <FormField label="Projected materials">
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            value={materials}
            onInput={(e) => onFieldInput("materials", (e.target as HTMLInputElement).value)}
          />
        </FormField>
        <FormField label="Projected labor">
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            value={labor}
            onInput={(e) => onFieldInput("labor", (e.target as HTMLInputElement).value)}
          />
        </FormField>
        <FormField label="Projected subs">
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            value={subs}
            onInput={(e) => onFieldInput("subs", (e.target as HTMLInputElement).value)}
          />
        </FormField>
      </div>

      <div class="cycle-preview">
        <PreviewLine label="Subtotal" value={preview.subtotal} />
        <PreviewLine label={`PM fee (${Math.round(pmRate * 100)}%)`} value={preview.pmFee} />
        <PreviewLine label={`Contractor fee (${Math.round(contractorRate * 100)}%)`} value={preview.contractorFee} />
        <PreviewLine label="Cycle total" value={preview.total} strong />
      </div>

      <div style={{ marginTop: "var(--space-sm)" }}>
        <Button variant="primary" size="sm" disabled={busy || !dirty || preview.subtotal <= 0} onClick={onSave}>
          {busy ? "Saving…" : "Save mini-budget"}
        </Button>
      </div>
    </div>
  );
}

function ScopeReadOnly({
  scopeContext,
  scopeState,
}: {
  scopeContext: ScopeContext;
  scopeState: ScopeState;
}) {
  const selected = scopeContext.line_items.filter((li) => scopeState[li.line_item_id]?.checked);
  if (!selected.length) return null;
  return (
    <div class="cycle-scope-readonly">
      <h4 class="cycle-scope__title">Scope for this cycle</h4>
      <ul class="cycle-scope__list">
        {selected.map((li) => (
          <li key={li.line_item_id}>
            {li.name} — {scopeState[li.line_item_id]?.percentage ?? "100"}%
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScopeChecklist({
  scopeContext,
  scopeState,
  readOnly,
  onScopeChange,
}: {
  scopeContext: ScopeContext;
  scopeState: ScopeState;
  readOnly: boolean;
  onScopeChange?: (lineItemId: string, patch: Partial<{ checked: boolean; percentage: string }>) => void;
}) {
  if (!scopeContext.line_items.length) {
    return (
      <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
        No estimate line items found — enter projected amounts manually.
      </p>
    );
  }

  return (
    <div class="cycle-scope">
      <h4 class="cycle-scope__title">Scope for this cycle</h4>
      <p class="text--muted cycle-scope__hint" style={{ fontSize: "var(--text-xs)" }}>
        Optional — select trades and what percentage of each applies to this cycle. Amounts auto-fill the
        projected fields below; you can still adjust them by hand.
      </p>
      <div class="cycle-scope__list">
        {scopeContext.line_items.map((li) => {
          const row = scopeState[li.line_item_id];
          const checked = row?.checked ?? false;
          const pct = row?.percentage ?? "100";
          const prior = scopeContext.cumulative_allocations[li.line_item_id] ?? 0;
          const current = checked ? Number(pct) || 0 : 0;
          const cumulative = round2(prior + current);
          const overAllocated = checked && cumulative > 100;

          return (
            <div class="cycle-scope__row" key={li.line_item_id}>
              <label class="cycle-scope__check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={readOnly}
                  onChange={(e) =>
                    onScopeChange?.(li.line_item_id, {
                      checked: (e.target as HTMLInputElement).checked,
                      percentage: "100",
                    })
                  }
                />
                <span class="cycle-scope__name">{li.name}</span>
                <ScopeCategoryBreakdown line={li} />
              </label>
              {checked && (
                <div class="cycle-scope__pct">
                  <input
                    class="form-input form-input--sm"
                    type="number"
                    min="1"
                    max="100"
                    step="1"
                    value={pct}
                    disabled={readOnly}
                    onInput={(e) =>
                      onScopeChange?.(li.line_item_id, { percentage: (e.target as HTMLInputElement).value })
                    }
                  />
                  <span class="text--muted">%</span>
                </div>
              )}
              {prior > 0 && (
                <Badge tone="neutral" class="cycle-scope__badge">
                  {Math.round(prior)}% allocated in prior cycles
                </Badge>
              )}
              {overAllocated && (
                <span class="cycle-scope__warn text--warning" style={{ fontSize: "var(--text-xs)" }}>
                  This puts {li.name} at {Math.round(cumulative)}% across cycles — confirm if expected (cost
                  increase or underscoped estimate).
                </span>
              )}
            </div>
          );
        })}
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
  const costing = useApi<{ costing: { lines: ScopeLineItem[] } }>(`/api/jobs/${jobId}/costing`);
  const cyclesList = useApi<CycleListResponse>(`/api/jobs/${jobId}/billing-cycles`);
  const today = new Date().toISOString().slice(0, 10);
  const twoWeeks = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
  const [periodStart, setPeriodStart] = useState(today);
  const [periodEnd, setPeriodEnd] = useState(twoWeeks);
  const [materials, setMaterials] = useState("");
  const [labor, setLabor] = useState("");
  const [subs, setSubs] = useState("");
  const [scopeState, setScopeState] = useState<ScopeState>({});
  const [manualOverride, setManualOverride] = useState(false);
  const [isFinal, setIsFinal] = useState(false);
  const [busy, setBusy] = useState(false);

  const scopeContext: ScopeContext = {
    line_items: (costing.data?.costing.lines ?? []).map((l) => {
      const sub_items = l.sub_items.map((s) => ({
        id: s.id,
        category: s.category,
        budget: s.budget,
      }));
      const cats = categoryCostsForLineItem({
        line_item_id: l.line_item_id,
        name: l.name,
        budget: l.budget,
        sub_items,
      });
      return {
        line_item_id: l.line_item_id,
        name: l.name,
        budget: l.budget,
        materials: cats.materials,
        labor: cats.labor,
        subs: cats.subs,
        sub_items,
      };
    }),
    cumulative_allocations: (() => {
      const map: Record<string, number> = {};
      for (const cycle of cyclesList.data?.cycles ?? []) {
        for (const a of parseScopeAllocations(cycle.scope_allocations)) {
          map[a.line_item_id] = round2((map[a.line_item_id] ?? 0) + a.percentage);
        }
      }
      return map;
    })(),
  };

  const m = Number(materials) || 0;
  const l = Number(labor) || 0;
  const s = Number(subs) || 0;
  const preview = computePreview(m, l, s, 0.1, 0.2);
  const upfrontBase = isFinal ? round2(preview.total * 0.5) : preview.total;
  const invoiceAmount = round2(upfrontBase - priorCredit);
  const valid = preview.subtotal > 0;

  const applyScopeToFields = (nextScope: ScopeState) => {
    const allocations = allocationsFromScopeState(nextScope);
    if (!allocations.length) return;
    const projected = projectedCostsFromScope(scopeContext.line_items, allocations);
    setMaterials(String(projected.materials));
    setLabor(String(projected.labor));
    setSubs(String(projected.subs));
  };

  const updateScope = (lineItemId: string, patch: Partial<{ checked: boolean; percentage: string }>) => {
    const next: ScopeState = {
      ...scopeState,
      [lineItemId]: { checked: false, percentage: "100", ...scopeState[lineItemId], ...patch },
    };
    if (patch.checked === false) delete next[lineItemId];
    setScopeState(next);
    if (!manualOverride) applyScopeToFields(next);
  };

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
        scope_allocations: allocationsFromScopeState(scopeState),
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

      {costing.loading ? (
        <Spinner />
      ) : (
        <ScopeChecklist
          scopeContext={scopeContext}
          scopeState={scopeState}
          readOnly={false}
          onScopeChange={updateScope}
        />
      )}

      <div class="form-row" style={{ marginTop: "var(--space-sm)" }}>
        <FormField label="Projected materials">
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            value={materials}
            onInput={(e) => {
              setManualOverride(true);
              setMaterials((e.target as HTMLInputElement).value);
            }}
          />
        </FormField>
        <FormField label="Projected labor">
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            value={labor}
            onInput={(e) => {
              setManualOverride(true);
              setLabor((e.target as HTMLInputElement).value);
            }}
          />
        </FormField>
        <FormField label="Projected subs">
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            value={subs}
            onInput={(e) => {
              setManualOverride(true);
              setSubs((e.target as HTMLInputElement).value);
            }}
          />
        </FormField>
      </div>

      <label class="flex gap-sm items-center" style={{ fontSize: "var(--text-sm)" }}>
        <input type="checkbox" checked={isFinal} onChange={(e) => setIsFinal((e.target as HTMLInputElement).checked)} />
        Final cycle (50% upfront / 50% at completion)
      </label>

      <div class="cycle-preview" style={{ marginTop: "var(--space-md)" }}>
        <PreviewLine label="Subtotal" value={preview.subtotal} />
        <PreviewLine label="PM fee (10%)" value={preview.pmFee} />
        <PreviewLine label="Contractor fee (20%)" value={preview.contractorFee} />
        <PreviewLine label="Cycle total" value={preview.total} strong />
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
