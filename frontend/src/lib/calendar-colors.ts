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
  date: string;
  start_time: string | null;
  end_time: string | null;
  assigned_user_name: string | null;
  assigned_user_color: string | null;
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
    if (!event.assigned_user_name && !event.assigned_sub_name) return "#6B7280";
    return "#F59E0B";
  }
  if (event.type === "google_meeting") return "#8B5CF6";
  if (event.type === "estimate_visit") return "#06B6D4";
  if (event.type === "proposal_review") return "#6366F1";
  if (event.assigned_user_color) return event.assigned_user_color;
  if (event.assigned_sub_color) return event.assigned_sub_color;
  return "#6B7280";
}

export const CALENDAR_LEGEND: Array<{ color: string; label: string }> = [
  { color: "#3B82F6", label: "Job (assignee color)" },
  { color: "#F59E0B", label: "Warranty call" },
  { color: "#06B6D4", label: "Estimate visit" },
  { color: "#6366F1", label: "Proposal review" },
  { color: "#8B5CF6", label: "Google Meet" },
  { color: "#6B7280", label: "Unassigned" },
];

export function eventTypeLabel(type: CalendarEventType): string {
  switch (type) {
    case "job_appointment":
      return "Job appointment";
    case "warranty_call":
      return "Warranty call";
    case "estimate_visit":
      return "Estimate visit";
    case "proposal_review":
      return "Proposal Review";
    case "google_meeting":
      return "Google Meet";
  }
}
