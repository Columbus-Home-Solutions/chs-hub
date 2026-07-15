import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { formatCurrency, formatDate } from "../../lib/format";
import {
  getJson,
  type PortalBudget,
  type BudgetCycle,
  type ReconReport,
  type ReconItemized,
  type ReconItemizedExpense,
} from "./portalApi";

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
          <CycleCard key={c.id} token={token} cycle={c} report={reconById.get(c.id) ?? null} />
        ))
      )}
    </div>
  );
}

const ITEMIZED_CATEGORIES = new Set(["materials", "labor", "subs"]);

function formatTimeRole(role: string): string {
  if (role === "pm_skilled") return "PM/Skilled";
  if (role === "general") return "General";
  return role;
}

function expenseLabel(e: ReconItemizedExpense): string {
  const parts = [e.vendor ?? e.sub_name, e.description].filter(Boolean);
  return parts.length ? parts.join(" — ") : e.expense_type ?? "Cost";
}

function portalReceiptUrl(token: string, expenseId: string): string {
  return `/api/portal/${encodeURIComponent(token)}/expenses/${encodeURIComponent(expenseId)}/receipt`;
}

function ReconItemizedList({
  token,
  category,
  itemized,
}: {
  token: string;
  category: string;
  itemized: ReconItemized;
}) {
  if (category === "labor") {
    const items = itemized.labor;
    if (!items.length) return null;
    return (
      <ul class="portal-recon-itemized__list">
        {items.map((t) => (
          <li class="portal-recon-itemized__line" key={t.id}>
            <span>
              {t.worker}
              {t.role ? ` (${formatTimeRole(t.role)})` : ""}
              {t.hours != null ? ` · ${t.hours}h` : ""}
              {t.hourly_rate != null ? ` @ ${formatCurrency(t.hourly_rate)}/hr` : ""}
            </span>
            <span class="quote-muted">{t.date ? formatDate(t.date) : "—"}</span>
            <span>{formatCurrency(t.amount)}</span>
          </li>
        ))}
      </ul>
    );
  }

  const items = category === "subs" ? itemized.subs : itemized.materials;
  if (!items.length) return null;
  return (
    <ul class="portal-recon-itemized__list">
      {items.map((e) => (
        <li class="portal-recon-itemized__line" key={e.id}>
          <span>{expenseLabel(e)}</span>
          <span class="quote-muted">{e.date ? formatDate(e.date) : "—"}</span>
          <span>
            {formatCurrency(e.amount)}
            {e.receipt_url && (
              <>
                {" "}
                <a
                  class="portal-recon-itemized__receipt"
                  href={portalReceiptUrl(token, e.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
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

function ReconCategoryRows({ token, report }: { token: string; report: ReconReport }) {
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
            <div class="portal-recon__row">
              <span>
                {cat.label}
                {count > 0 && (
                  <button
                    type="button"
                    class="portal-recon-itemized__toggle"
                    onClick={() => toggle(cat.category)}
                  >
                    {isOpen ? "Hide" : `Show ${count} item${count === 1 ? "" : "s"}`}
                  </button>
                )}
              </span>
              <span>{formatCurrency(cat.projected)}</span>
              <span>{formatCurrency(cat.actual)}</span>
              <span class={cat.variance >= 0 ? "portal-var--good" : "portal-var--warn"}>
                {formatCurrency(cat.variance)}
              </span>
            </div>
            {isOpen && count > 0 && (
              <div class="portal-recon-itemized__panel">
                <ReconItemizedList
                  token={token}
                  category={cat.category}
                  itemized={report.itemized ?? { materials: [], labor: [], subs: [] }}
                />
              </div>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function CycleCard({
  token,
  cycle,
  report,
}: {
  token: string;
  cycle: BudgetCycle;
  report: ReconReport | null;
}) {
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
            <ReconCategoryRows token={token} report={report} />
          </div>

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
