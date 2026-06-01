import { useEffect, useState } from "preact/hooks";
import { formatCurrency, formatDate } from "../../lib/format";
import { getJson, type PortalBudget, type BudgetCycle, type ReconReport } from "./portalApi";

/**
 * Cost-plus Budget & Costs — read-only client view. Renders Sprint 11's cycle
 * list + buildReconciliationReport() payload verbatim; no money is recomputed.
 */
export function BudgetTab({ token }: { token: string }) {
  const [data, setData] = useState<PortalBudget | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<PortalBudget>(`/api/portal/${token}/budget`)
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [token]);

  if (error) return <div class="quote-error">{error}</div>;
  if (!data) return <div class="quote-muted">Loading budget…</div>;

  const reconById = new Map(data.reconciliations.map((r) => [r.cycle_id, r]));

  return (
    <div class="portal-budget">
      <div class="portal-card portal-budget__totals">
        <h3 class="portal-card__title">Project to Date</h3>
        <div class="portal-budget__totals-grid">
          <Mini label="Projected" value={formatCurrency(data.totals.projected_to_date)} />
          <Mini label="Actual Spent" value={formatCurrency(data.totals.actual_to_date)} />
          <Mini
            label={data.totals.variance_to_date >= 0 ? "Under Budget" : "Over Budget"}
            value={formatCurrency(Math.abs(data.totals.variance_to_date))}
            tone={data.totals.variance_to_date >= 0 ? "good" : "warn"}
          />
        </div>
        {data.unattributed_actuals.has_unattributed && (
          <div class="quote-muted" style={{ marginTop: "10px" }}>
            {formatCurrency(data.unattributed_actuals.amount)} in costs are not yet assigned to a billing cycle.
          </div>
        )}
      </div>

      {data.cycles.length === 0 ? (
        <div class="portal-empty">
          <div class="portal-empty__icon">📊</div>
          <div class="portal-empty__title">No billing cycles yet</div>
          <div class="quote-muted">Your cost-plus budget cycles will appear here.</div>
        </div>
      ) : (
        data.cycles.map((c) => (
          <CycleCard key={c.id} cycle={c} report={reconById.get(c.id) ?? null} />
        ))
      )}
    </div>
  );
}

function CycleCard({ cycle, report }: { cycle: BudgetCycle; report: ReconReport | null }) {
  const isActive = cycle.status === "active";
  return (
    <div class="portal-card">
      <div class="portal-invoice__head">
        <div>
          <div class="portal-invoice__title">
            Cycle {cycle.cycle_number}
            {cycle.is_final_cycle ? " (Final)" : ""}
          </div>
          <div class="quote-muted">
            {formatDate(cycle.period_start)} – {formatDate(cycle.period_end)}
          </div>
        </div>
        <span class={`portal-pill portal-pill--${cycle.status}`}>{cycle.status}</span>
      </div>

      {/* Mini-budget (projected) */}
      <div class="portal-budget__section">
        <div class="portal-budget__section-label">Projected Budget</div>
        <Line label="Materials" value={cycle.projected_materials} />
        <Line label="Labor" value={cycle.projected_labor} />
        <Line label="Subcontractors" value={cycle.projected_subs} />
        <Line label="Subtotal" value={cycle.projected_subtotal} strong />
        <Line label="PM Fee (10%)" value={cycle.projected_pm_fee} />
        <Line label="Contractor Fee (20%)" value={cycle.projected_contractor_fee} />
        <Line label="Projected Total" value={cycle.projected_total} strong />
        {cycle.credit_from_prior != null && cycle.credit_from_prior !== 0 && (
          <Line label="Credit from prior cycle" value={cycle.credit_from_prior} />
        )}
      </div>

      {/* Live actuals for an active cycle */}
      {isActive && cycle.live_actuals && (
        <div class="portal-budget__section">
          <div class="portal-budget__section-label">Costs So Far (live)</div>
          <Line label="Materials" value={cycle.live_actuals.materials} />
          <Line label="Labor" value={cycle.live_actuals.labor} />
          <Line label="Subcontractors" value={cycle.live_actuals.subs} />
          <Line label="Total So Far" value={cycle.live_actuals.total} strong />
        </div>
      )}

      {/* Reconciliation (closed cycle): projected vs actual side-by-side */}
      {report && (
        <div class="portal-budget__section">
          <div class="portal-budget__section-label">Reconciliation</div>
          <div class="portal-recon">
            <div class="portal-recon__head">
              <span>Category</span>
              <span>Projected</span>
              <span>Actual</span>
              <span>Variance</span>
            </div>
            {report.categories.map((cat) => (
              <div class="portal-recon__row" key={cat.category}>
                <span>{cat.label}</span>
                <span>{formatCurrency(cat.projected)}</span>
                <span>{formatCurrency(cat.actual)}</span>
                <span class={cat.variance >= 0 ? "portal-var--good" : "portal-var--warn"}>
                  {formatCurrency(cat.variance)}
                </span>
              </div>
            ))}
          </div>

          {report.expenses.length > 0 && (
            <div class="portal-budget__expenses">
              <div class="portal-budget__section-label">Itemized Costs</div>
              {report.expenses.map((e) => (
                <div class="portal-invoice__history-row" key={e.id}>
                  <span>
                    {e.date ? formatDate(e.date) : "—"} · {e.vendor ?? e.description ?? e.expense_type ?? "Cost"}
                  </span>
                  <span>{formatCurrency(e.amount)}</span>
                </div>
              ))}
            </div>
          )}

          <div class={`portal-budget__explain portal-budget__explain--${report.outcome}`}>
            {report.explanation}
          </div>
        </div>
      )}
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: number | null; strong?: boolean }) {
  return (
    <div class={`portal-invoice__row${strong ? " portal-invoice__row--strong" : ""}`}>
      <span>{label}</span>
      <span>{formatCurrency(value ?? 0)}</span>
    </div>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" }) {
  return (
    <div class="portal-stat">
      <div class="portal-stat__label">{label}</div>
      <div class={`portal-stat__value${tone ? ` portal-var--${tone}` : ""}`}>{value}</div>
    </div>
  );
}
