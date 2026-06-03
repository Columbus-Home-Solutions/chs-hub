import { route } from "preact-router";
import type { PipelineData, PipelineStage } from "./types";

interface Props {
  data: PipelineData;
  loading: boolean;
  error: string | null;
}

function PipelineBars({ stages, title }: { stages: PipelineStage[]; title: string }) {
  const maxCount = Math.max(...stages.map((s) => s.count), 1);
  return (
    <div class="pipeline-mini">
      <h3 class="pipeline-mini__title">{title}</h3>
      {stages.map((stage) => (
        <button
          key={stage.status}
          class="pipeline-mini__row"
          onClick={() =>
            route(title.includes("Lead") ? `/estimating?status=${stage.status}` : `/jobs?status=${stage.status}`)
          }
        >
          <span class="pipeline-mini__label">{stage.label}</span>
          <span class="pipeline-mini__bar-wrap">
            <span
              class="pipeline-mini__bar"
              style={{ width: `${(stage.count / maxCount) * 100}%` }}
            />
          </span>
          <span class="pipeline-mini__count">{stage.count}</span>
        </button>
      ))}
    </div>
  );
}

export function PipelineSummary({ data, loading, error }: Props) {
  if (loading) {
    return (
      <div class="dash-card">
        <div class="dash-card__header">
          <h2 class="dash-card__title">Pipeline</h2>
        </div>
        <div class="dash-card__body">
          <div class="pipeline-summary--skeleton" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="dash-card">
        <div class="dash-card__header"><h2 class="dash-card__title">Pipeline</h2></div>
        <div class="dash-card__body dash-card__body--error">Unable to load pipeline.</div>
      </div>
    );
  }

  const { leads, jobs, conversionRate, unpaidTotal } = data;

  return (
    <div class="dash-card">
      <div class="dash-card__header">
        <h2 class="dash-card__title">Pipeline</h2>
      </div>
      <div class="dash-card__body">
        <div class="pipeline-summary__cols">
          <div class="pipeline-summary__col">
            <PipelineBars stages={leads} title="Lead Pipeline" />
            <div class="pipeline-summary__stat">
              Conversion: {conversionRate}%
            </div>
          </div>
          <div class="pipeline-summary__col">
            <PipelineBars stages={jobs} title="Job Pipeline" />
            <div class="pipeline-summary__stat">
              Unpaid: ${unpaidTotal.toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
