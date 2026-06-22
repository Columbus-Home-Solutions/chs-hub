/** Shared types for dashboard API responses. */

export interface KpiTile {
  id: string;
  label: string;
  value: number | string;
  subtitle: string;
  link: string;
  deltaDir?: "up" | "down" | null;
  deltaPct?: number | null;
}

export interface ActionItem {
  id: string;
  priority: "high" | "medium" | "low";
  type: string;
  title: string;
  meta: Record<string, unknown>;
  link: string;
  createdAt: string;
}

export interface PipelineStage {
  status: string;
  label: string;
  count: number;
}

export interface PipelineData {
  leads: PipelineStage[];
  jobs: PipelineStage[];
  conversionRate: number;
  unpaidTotal: number;
}

export interface ScheduleEntry {
  type: "schedule" | "appointment" | "google_calendar";
  entry_type?: "job" | "estimate" | "warranty" | "google_calendar";
  id: string;
  startTime: string | null;
  endTime?: string | null;
  label: string;
  description: string | null;
  link: string | null;
  meetLink?: string | null;
}

export interface ActivityEntry {
  id: string;
  icon: string;
  description: string;
  createdAt: string;
  link: string | null;
}
