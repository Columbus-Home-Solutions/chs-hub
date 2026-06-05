import type { RoutableProps } from "preact-router";
import { useState } from "preact/hooks";
import { useAuth } from "../store/auth";
import { useWeather } from "../store/weather";
import { useApi } from "../hooks/useApi";
import type { KpiTile, ActionItem, PipelineData, ScheduleEntry, ActivityEntry } from "./dashboard/types";

import { KpiTiles } from "./dashboard/KpiTiles";
import { WeatherAlerts } from "./dashboard/WeatherAlerts";
import { ActionItems } from "./dashboard/ActionItems";
import { PipelineSummary } from "./dashboard/PipelineSummary";
import { LeadPipeline } from "./dashboard/LeadPipeline";
import { SmartNotes } from "./dashboard/SmartNotes";
import { TodaySchedule } from "./dashboard/TodaySchedule";
import { UpcomingMeetings } from "./dashboard/UpcomingMeetings";
import { RecentActivity } from "./dashboard/RecentActivity";
import { JobsMapWidget } from "./dashboard/JobsMapWidget";
import { WeatherForecastCard } from "./dashboard/WeatherForecastCard";

export function Dashboard(_props: RoutableProps) {
  const { user } = useAuth();
  const weather = useWeather();
  const name = user?.first_name || "there";

  // All fetches fire in parallel — no waterfall.
  const kpis = useApi<{ tiles: KpiTile[] }>("/api/dashboard/kpis");
  const actionItems = useApi<{ items: ActionItem[] }>("/api/dashboard/action-items");
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const visibleActionItems = (actionItems.data?.items ?? []).filter((i) => !dismissedIds.has(i.id));
  const pipeline = useApi<PipelineData>("/api/dashboard/pipeline");
  const schedule = useApi<{ entries: ScheduleEntry[] }>("/api/dashboard/schedule");
  const activity = useApi<{ entries: ActivityEntry[]; bellCount: number }>("/api/dashboard/activity");

  return (
    <div class="dashboard">
      {/* Page header */}
      <div class="view-header">
        <div>
          <h1 class="view-title">Welcome back, {name}</h1>
          <p class="view-subtitle">Here's what needs your attention today.</p>
        </div>
      </div>

      {/* KPI strip — full width, renders first */}
      <KpiTiles
        tiles={kpis.data?.tiles ?? []}
        loading={kpis.loading}
      />

      {/* Two-column content area */}
      <div class="dashboard__columns">
        {/* Primary column (~60%) */}
        <div class="dashboard__primary">
          {/* Weather: renders only when alerts exist */}
          {weather && (weather.scheduleAlerts?.length ?? 0) > 0 && (
            <WeatherAlerts
              scheduleAlerts={weather.scheduleAlerts}
              forecast={weather.forecast}
            />
          )}

          <ActionItems
            items={visibleActionItems}
            loading={actionItems.loading}
            error={actionItems.error}
            onDismiss={(id) => setDismissedIds((prev) => new Set(prev).add(id))}
          />

          <PipelineSummary
            data={pipeline.data ?? { leads: [], jobs: [], conversionRate: 0, unpaidTotal: 0 }}
            loading={pipeline.loading}
            error={pipeline.error}
          />

          {/* LeadPipeline Kanban — desktop only, hidden on mobile via CSS */}
          <div class="dashboard__desktop-only">
            <LeadPipeline />
          </div>
        </div>

        {/* Secondary column (~40%) */}
        <div class="dashboard__secondary">
          <WeatherForecastCard />
          <TodaySchedule
            entries={schedule.data?.entries ?? []}
            loading={schedule.loading}
            error={schedule.error}
          />
          <UpcomingMeetings />
          <SmartNotes />
          <JobsMapWidget />
          <RecentActivity
            entries={activity.data?.entries ?? []}
            loading={activity.loading}
            error={activity.error}
          />
        </div>
      </div>
    </div>
  );
}
