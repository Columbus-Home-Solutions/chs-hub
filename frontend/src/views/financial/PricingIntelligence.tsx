/**
 * Pricing Intelligence tab — Sprint 25 D3B.
 *
 * Displays AI-generated margin analysis and pricing recommendations for all
 * closed jobs. Data is served from GET /api/financial/pricing-intelligence,
 * which caches the Claude response in system_settings for 24 hours.
 */

import { useEffect, useState } from "preact/hooks";
import { Spinner } from "../../components/ui/Spinner";
import { Button } from "../../components/ui/Button";
import { useApi } from "../../hooks/useApi";
import { formatCurrency } from "../../lib/format";

interface JobTypeGroup {
  job_type: string;
  job_count: number;
  avg_margin: number;
  avg_contract: number;
  health: "strong" | "fair" | "weak";
  note: string;
}

interface Recommendation {
  priority: "high" | "medium";
  title: string;
  rationale: string;
  suggested_adjustment: string | null;
}

interface RawJob {
  id: string;
  title: string | null;
  job_type: string | null;
  contract_total: number;
  total_expenses: number;
  margin: number | null;
}

interface PricingData {
  headline: string;
  overall_avg_margin: number;
  by_job_type: JobTypeGroup[];
  recommendations: Recommendation[];
  watch_items: string[];
  raw_jobs: RawJob[];
  generated_at: string;
  job_count: number;
  from_cache: boolean;
  insufficient_data?: boolean;
  closed_job_count?: number;
  error?: string;
  message?: string;
}

function marginColor(margin: number): string {
  if (margin >= 30) return "var(--color-success)";
  if (margin >= 15) return "var(--color-warning)";
  return "var(--color-danger)";
}

function healthLabel(health: string): string {
  return health === "strong" ? "Strong" : health === "fair" ? "Fair" : "Weak";
}

function formatJobType(t: string | null): string {
  if (!t) return "Other";
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function PricingIntelligence() {
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);

  const url = refresh > 0
    ? `/api/financial/pricing-intelligence?refresh=true&_r=${refresh}`
    : "/api/financial/pricing-intelligence";

  const { data, loading, error } = useApi<PricingData>(url);

  const handleRefresh = () => {
    setRefreshing(true);
    setRefresh((n) => n + 1);
  };

  // Clear the "refreshing" overlay once the fetch completes.
  useEffect(() => {
    if (refreshing && !loading) {
      setRefreshing(false);
    }
  }, [refreshing, loading]);

  const isLoading = loading || refreshing;

  if (isLoading) {
    return (
      <div class="pricing-intel__loading">
        <Spinner center />
        <p>Running AI analysis…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">⚠️</div>
        <div class="empty-state__title">Analysis unavailable</div>
        <p>Try refreshing. If the problem persists, check the Worker logs.</p>
        <Button variant="secondary" onClick={handleRefresh}>Retry</Button>
      </div>
    );
  }

  if (data.insufficient_data) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">📊</div>
        <div class="empty-state__title">Not enough data yet</div>
        <p>
          Not enough closed jobs for analysis. Pricing Intelligence activates once 5 or more
          jobs are closed.
        </p>
        <p class="text--muted">Closed jobs so far: {data.closed_job_count ?? 0}</p>
      </div>
    );
  }

  if (data.error) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">⚠️</div>
        <div class="empty-state__title">Analysis unavailable</div>
        <p>{data.message ?? "Try refreshing. If the problem persists, check the Worker logs."}</p>
        <Button variant="secondary" onClick={handleRefresh}>Retry</Button>
      </div>
    );
  }

  const overallColor = marginColor(data.overall_avg_margin ?? 0);

  return (
    <div class="pricing-intel">
      {/* 1. Header bar */}
      <div class="pricing-intel__header">
        <div>
          <h2 class="pricing-intel__title">Pricing Intelligence</h2>
          {data.generated_at && (
            <p class="pricing-intel__ts text--muted">
              Last analyzed: {formatTs(data.generated_at)}
              {data.from_cache && " (cached)"}
            </p>
          )}
        </div>
        <Button variant="secondary" onClick={handleRefresh} disabled={isLoading}>
          Refresh Analysis
        </Button>
      </div>

      {/* 2. Headline card */}
      <div class="pricing-intel__headline">
        <p>{data.headline}</p>
      </div>

      {/* 3. Overall margin KPI */}
      <div class="pricing-intel__kpi-row">
        <div class="pricing-intel__kpi-card">
          <span class="pricing-intel__kpi-value" style={{ color: overallColor }}>
            {(data.overall_avg_margin ?? 0).toFixed(1)}%
          </span>
          <span class="pricing-intel__kpi-label">Average Job Margin</span>
          <span class="pricing-intel__kpi-meta text--muted">
            Based on {data.job_count} closed job{data.job_count !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* 4. By Job Type grid */}
      {data.by_job_type && data.by_job_type.length > 0 && (
        <section class="pricing-intel__section">
          <h3 class="pricing-intel__section-title">By Job Type</h3>
          <div class="pricing-intel__type-grid">
            {[...data.by_job_type].sort((a, b) => b.avg_margin - a.avg_margin).map((g) => (
              <div key={g.job_type} class="pricing-intel__type-card">
                <div class="pricing-intel__type-header">
                  <span class="pricing-intel__type-name">{formatJobType(g.job_type)}</span>
                  <span
                    class={`pricing-intel__health pricing-intel__health--${g.health}`}
                  >
                    {healthLabel(g.health)}
                  </span>
                </div>
                <div class="pricing-intel__type-margin" style={{ color: marginColor(g.avg_margin) }}>
                  {g.avg_margin.toFixed(1)}% margin
                </div>
                <div class="pricing-intel__type-meta text--muted">
                  {g.job_count} jobs · avg {formatCurrency(g.avg_contract)}
                </div>
                <p class="pricing-intel__type-note">{g.note}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 5. Recommendations */}
      {data.recommendations && data.recommendations.length > 0 && (
        <section class="pricing-intel__section">
          <h3 class="pricing-intel__section-title">Recommendations</h3>
          <div class="stack">
            {data.recommendations.map((rec, i) => (
              <div key={i} class={`pricing-intel__rec pricing-intel__rec--${rec.priority}`}>
                <div class="pricing-intel__rec-header">
                  <span class="pricing-intel__rec-title">{rec.title}</span>
                  <span class={`pricing-intel__rec-badge pricing-intel__rec-badge--${rec.priority}`}>
                    {rec.priority === "high" ? "High Priority" : "Medium"}
                  </span>
                </div>
                <p class="pricing-intel__rec-rationale">{rec.rationale}</p>
                {rec.suggested_adjustment && (
                  <p class="pricing-intel__rec-adjustment">
                    Suggested: {rec.suggested_adjustment}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 6. Watch items */}
      {data.watch_items && data.watch_items.length > 0 && (
        <section class="pricing-intel__section">
          <h3 class="pricing-intel__section-title">Watch Items</h3>
          <div class="stack">
            {data.watch_items.map((item, i) => (
              <div key={i} class="pricing-intel__watch-item">
                <span>⚠️</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 7. Raw data table (collapsed by default) */}
      {data.raw_jobs && data.raw_jobs.length > 0 && (
        <section class="pricing-intel__section">
          <button
            class="pricing-intel__raw-toggle"
            onClick={() => setRawExpanded((v) => !v)}
          >
            {rawExpanded ? "▲ Hide" : "▼ Show"} raw job data ({data.raw_jobs.length} jobs)
          </button>
          {rawExpanded && (
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Type</th>
                    <th>Contract</th>
                    <th>Expenses</th>
                    <th>Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {data.raw_jobs.map((j) => (
                    <tr key={j.id}>
                      <td>{j.title ?? "—"}</td>
                      <td>{formatJobType(j.job_type)}</td>
                      <td>{formatCurrency(j.contract_total)}</td>
                      <td>{formatCurrency(j.total_expenses)}</td>
                      <td style={{ color: j.margin !== null ? marginColor(j.margin) : undefined }}>
                        {j.margin !== null ? `${j.margin.toFixed(1)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
