/** Unified calendar event types for the cross-job schedule view. */

export type CalendarEventType =
  | "job_appointment"
  | "warranty_call"
  | "estimate_visit"
  | "proposal_review"
  | "google_meeting";

export interface CalendarEvent {
  id: string;
  type: CalendarEventType;
  title: string;
  /** YYYY-MM-DD for grid grouping */
  date: string;
  start_time: string | null;
  end_time: string | null;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  assigned_user_color: string | null;
  assigned_sub_id: string | null;
  assigned_sub_name: string | null;
  assigned_sub_color: string | null;
  job_id: string | null;
  job_number: number | null;
  job_title: string | null;
  link_path: string | null;
  meet_link: string | null;
  description: string | null;
  status: string | null;
}

export function getCalendarColor(event: CalendarEvent): string {
  if (event.type === "warranty_call") {
    if (!event.assigned_user_id && !event.assigned_sub_id) return "#6B7280";
    return "#F59E0B";
  }
  if (event.type === "google_meeting") return "#8B5CF6";
  if (event.type === "estimate_visit") return "#06B6D4";
  if (event.type === "proposal_review") return "#6366F1";
  if (event.assigned_user_color) return event.assigned_user_color;
  if (event.assigned_sub_color) return event.assigned_sub_color;
  return "#6B7280";
}

export function datePart(isoOrDate: string | null): string | null {
  if (!isoOrDate) return null;
  return isoOrDate.slice(0, 10);
}

export function timePart(isoOrDate: string | null): string | null {
  if (!isoOrDate || isoOrDate.length <= 10) return null;
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate.slice(11, 16);
  return d.toISOString().slice(11, 16);
}
