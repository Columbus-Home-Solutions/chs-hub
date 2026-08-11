import type { RoutableProps } from "preact-router";
import { useState } from "preact/hooks";
import { useAuth } from "../store/auth";
import { useWeather } from "../store/weather";
import { useApi } from "../hooks/useApi";
import { useViewportTier } from "../hooks/useViewportTier";
import type { KpiTile, ActionItem, PipelineData, ScheduleEntry, ActivityEntry } from "./dashboard/types";

import { KpiTiles } from "./dashboard/KpiTiles";
import { WeatherAlerts } from "./dashboard/WeatherAlerts";
import { ActionItems } from "./dashboard/ActionItems";
import { PipelineSummary } from "./dashboard/PipelineSummary";
import { SmartNotes } from "./dashboard/SmartNotes";
import { TodaySchedule } from "./dashboard/TodaySchedule";
import { RecentActivity } from "./dashboard/RecentActivity";
import { JobsMapWidget } from "./dashboard/JobsMapWidget";
import { WeatherForecastCard } from "./dashboard/WeatherForecastCard";
import { QuickActionsWidget } from "./dashboard/QuickActionsWidget";
import { DocReviewQueue } from "./dashboard/DocReviewQueue";
import { JobHealthWidget } from "./dashboard/JobHealthWidget";
import { EstimateRequestsWidget } from "./dashboard/EstimateRequestsWidget";
import { OpenBidsWidget } from "./dashboard/OpenBidsWidget";

export function Dashboard(_props: RoutableProps) {
  const { user } = useAuth();
  const weather = useWeather();
  const tier = useViewportTier();
  const isPhone = tier === "mobile";
  const isTablet = tier === "tablet";
  const isDesktop = tier === "desktop";
  const name = user?.first_name || "there";

  // Phone: slim Home. Tablet: approved layout (see tablet branch). Desktop: full set.
  const showWeatherAlerts = isDesktop && !!weather && (weather.scheduleAlerts?.length ?? 0) > 0;
  const showWeatherForecast = isDesktop;
  const showDocReview = isDesktop;
  const showQuickActions = !isPhone;
  const showPipeline = isDesktop;
  const showJobHealth = !isPhone;
  // Estimate Requests is action-oriented (Visit Capture) — include on phone Home too.
  // Job Health / Open Bids stay tablet+desktop only.
  const showEstimateRequests = true;
  const showOpenBids = !isPhone;
  const showJobsMap = isDesktop;
  const showActivity = isDesktop;
  // Notes live in + → New Note on phone/tablet; desktop keeps the Home card.
  const showSmartNotes = isDesktop;

  const kpis = useApi<{ tiles: KpiTile[] }>("/api/dashboard/kpis");
  const actionItems = useApi<{ items: ActionItem[] }>("/api/dashboard/action-items");
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const visibleActionItems = (actionItems.data?.items ?? []).filter((i) => !dismissedIds.has(i.id));
  const pipeline = useApi<PipelineData>(showPipeline ? "/api/dashboard/pipeline" : null);
  const schedule = useApi<{ entries: ScheduleEntry[] }>("/api/dashboard/schedule");
  const activity = useApi<{ entries: ActivityEntry[]; bellCount: number }>(
    showActivity ? "/api/dashboard/activity" : null,
  );

  const actionItemsBlock = (
    <ActionItems
      items={visibleActionItems}
      loading={actionItems.loading}
      error={actionItems.error}
      mobile={isPhone || isTablet}
      onDismiss={(id) => setDismissedIds((prev) => new Set(prev).add(id))}
    />
  );

  const scheduleBlock = (
    <TodaySchedule
      entries={schedule.data?.entries ?? []}
      loading={schedule.loading}
      error={schedule.error}
    />
  );

  return (
    <div class={`dashboard dashboard--${tier}`}>
      <div class="view-header">
        <div>
          <h1 class="view-title">Welcome back, {name}</h1>
          <p class="view-subtitle">Here's what needs your attention today.</p>
        </div>
      </div>

      <KpiTiles
        tiles={kpis.data?.tiles ?? []}
        loading={kpis.loading}
      />

      {isTablet ? (
        <div class="dashboard__tablet">
          {showQuickActions && (
            <div class="dashboard__tablet-band">
              <QuickActionsWidget />
            </div>
          )}

          <div class="dashboard__tablet-split">
            <div class="dashboard__tablet-split-main">
              <div class="dashboard__tablet-scroll-card">{scheduleBlock}</div>
              <div class="dashboard__tablet-scroll-card">{actionItemsBlock}</div>
            </div>
            <div class="dashboard__tablet-split-side">
              {showEstimateRequests && <EstimateRequestsWidget />}
              {showOpenBids && <OpenBidsWidget />}
              {showJobHealth && <JobHealthWidget />}
            </div>
          </div>
        </div>
      ) : (
        <div class="dashboard__columns">
          <div class="dashboard__primary">
            {showWeatherAlerts && (
              <div class="dashboard-order-alerts">
                <WeatherAlerts
                  scheduleAlerts={weather!.scheduleAlerts}
                  forecast={weather!.forecast}
                />
              </div>
            )}

            {showWeatherForecast && (
              <div class="dashboard-order-weather">
                <WeatherForecastCard />
              </div>
            )}

            {showDocReview && (
              <div class="dashboard-order-doc-review">
                <DocReviewQueue />
              </div>
            )}

            <div class="dashboard-order-action-items">{actionItemsBlock}</div>

            {isPhone && showEstimateRequests && (
              <div class="dashboard-order-estimate-requests">
                <EstimateRequestsWidget />
              </div>
            )}

            {showQuickActions && (
              <div class="dashboard-order-quick-actions dashboard-order-quick-actions--mobile">
                <QuickActionsWidget />
              </div>
            )}

            <div class="dashboard-order-schedule">{scheduleBlock}</div>

            {showPipeline && (
              <div class="dashboard-order-pipeline">
                <PipelineSummary
                  data={pipeline.data ?? { leads: [], jobs: [], conversionRate: 0, unpaidTotal: 0 }}
                  loading={pipeline.loading}
                  error={pipeline.error}
                />
              </div>
            )}
          </div>

          <div class="dashboard__secondary">
            {showQuickActions && (
              <div class="dashboard-order-quick-actions dashboard-order-quick-actions--desktop">
                <QuickActionsWidget />
              </div>
            )}

            {!isPhone && showEstimateRequests && (
              <div class="dashboard-order-estimate-requests">
                <EstimateRequestsWidget />
              </div>
            )}

            {showOpenBids && (
              <div class="dashboard-order-open-bids">
                <OpenBidsWidget />
              </div>
            )}

            {showJobHealth && (
              <div class="dashboard-order-job-health">
                <JobHealthWidget />
              </div>
            )}

            {showSmartNotes && (
              <div class="dashboard-order-smart-notes">
                <SmartNotes />
              </div>
            )}

            {showJobsMap && (
              <div class="dashboard-order-jobs-map">
                <JobsMapWidget />
              </div>
            )}

            {showActivity && (
              <div class="dashboard-order-activity">
                <RecentActivity
                  entries={activity.data?.entries ?? []}
                  loading={activity.loading}
                  error={activity.error}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
