import { Card } from "../../components/ui/Card";
import { Spinner } from "../../components/ui/Spinner";
import { formatCurrency } from "../../lib/format";

export interface JobCostingPayload {
  has_budget: boolean;
  unallocated: number;
  totals: {
    budget: number;
    actual: number;
    variance: number;
    status: "under" | "within" | "over";
  };
}

interface JobCostCardProps {
  jobStatus: string;
  costing: JobCostingPayload | null;
  loading: boolean;
  error: string | null;
  onViewDetails: () => void;
}

/**
 * Compact budget-vs-actual summary for Job Detail → Overview.
 * Numbers come from GET /api/jobs/:id/costing (same totals as the Financial tab).
 */
export function JobCostCard({ jobStatus, costing, loading, error, onViewDetails }: JobCostCardProps) {
  return (
    <Card
      title="Job Cost"
      actions={
        <button type="button" class="link-btn" onClick={onViewDetails}>
          View details →
        </button>
      }
    >
      <JobCostBody jobStatus={jobStatus} costing={costing} loading={loading} error={error} />
    </Card>
  );
}

function JobCostBody({
  jobStatus,
  costing,
  loading,
  error,
}: Omit<JobCostCardProps, "onViewDetails">) {
  if (loading && !costing) return <Spinner />;
  if (error || !costing) {
    return <p class="job-cost__note">Couldn&apos;t load job costs.</p>;
  }

  const budget = costing.totals.budget;
  const actual = costing.totals.actual;
  const noBudget = !costing.has_budget || budget <= 0;

  if (noBudget) {
    return (
      <div class="job-cost">
        <p class="job-cost__note" style={{ marginTop: 0 }}>
          No cost budget on this job&apos;s estimate.
        </p>
        {actual > 0 && <Metric label="Actual cost" value={formatCurrency(actual)} />}
      </div>
    );
  }

  const noCosts = actual === 0;
  const finished = jobStatus === "complete" || jobStatus === "closed";
  const over = !noCosts && actual > budget;
  const pct = (actual / budget) * 100;
  const barWidth = Math.min(100, Math.max(0, pct));
  // Reuse the endpoint's status flag. A $0 actual is "under" on the server,
  // which would paint the empty bar green — keep that bar neutral instead.
  const barStatus = noCosts ? null : costing.totals.status;

  return (
    <div class="job-cost">
      <div class="job-cost__metrics">
        <Metric label="Est. cost" value={formatCurrency(budget)} />
        <Metric label="Actual cost" value={formatCurrency(actual)} />
        {noCosts ? (
          <Metric label="Remaining" value="—" />
        ) : over ? (
          <Metric label="Over budget" value={formatCurrency(actual - budget)} error />
        ) : (
          <Metric label="Remaining" value={formatCurrency(budget - actual)} />
        )}
      </div>
      <div class="job-cost__track" role="img" aria-label={`${Math.round(pct)}% of budget used`}>
        <div
          class={`job-cost__fill${barStatus ? ` job-cost__fill--${barStatus}` : ""}`}
          style={{ width: `${barWidth}%` }}
        />
      </div>
      <div class="job-cost__pct">{Math.round(pct)}% of budget used</div>
      {noCosts && finished && (
        <div class="callout callout--warning" role="status">
          No costs were logged for this job. Actual vs. estimate unavailable.
        </div>
      )}
      {noCosts && !finished && <p class="job-cost__note">No costs logged yet.</p>}
      {!noCosts && costing.unallocated > 0 && (
        <p class="job-cost__note">Includes {formatCurrency(costing.unallocated)} unallocated</p>
      )}
    </div>
  );
}

function Metric({ label, value, error }: { label: string; value: string; error?: boolean }) {
  return (
    <div>
      <div class="job-cost__label">{label}</div>
      <div class={`job-cost__value${error ? " job-cost__value--error" : ""}`}>{value}</div>
    </div>
  );
}
