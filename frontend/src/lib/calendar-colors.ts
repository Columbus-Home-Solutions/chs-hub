export type CalendarEventType =
  | "job_appointment"
  | "warranty_call"
  | "estimate_visit"
  | "proposal_review"
  | "permit_inspection"
  | "deadline"
  | "google_meeting";

export const TYPE_PROPOSAL_REVIEW = "#EC4899";
export const TYPE_PERMIT_INSPECTION = "#6366F1";
export const TYPE_DEADLINE = "#EF4444";
export const TYPE_WARRANTY_CALL = "#14B8A6";
export const TYPE_ESTIMATE_VISIT = "#06B6D4";
export const TYPE_GOOGLE_MEETING = "#8B5CF6";
export const TYPE_UNASSIGNED = "#6B7280";

export type JobRag = "on_track" | "at_risk" | "behind";

export interface CalendarEvent {
  id: string;
  type: CalendarEventType;
  title: string;
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

export interface ScheduleJob {
  id: string;
  job_number: number | null;
  title: string | null;
  status: string | null;
  start_date: string | null;
  target_end_date: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  assigned_to_color: string | null;
  rag: JobRag;
}

export function getCalendarColor(event: CalendarEvent): string {
  if (event.type === "warranty_call") {
    if (!event.assigned_user_name && !event.assigned_sub_name && !event.assigned_user_id && !event.assigned_sub_id) {
      return TYPE_UNASSIGNED;
    }
    return TYPE_WARRANTY_CALL;
  }
  if (event.type === "google_meeting") return TYPE_GOOGLE_MEETING;
  if (event.type === "estimate_visit") return TYPE_ESTIMATE_VISIT;
  if (event.type === "proposal_review") return TYPE_PROPOSAL_REVIEW;
  if (event.type === "permit_inspection") return TYPE_PERMIT_INSPECTION;
  if (event.type === "deadline") return TYPE_DEADLINE;
  if (event.assigned_user_color) return event.assigned_user_color;
  return TYPE_UNASSIGNED;
}

export const CALENDAR_LEGEND: Array<{ color: string; label: string }> = [
  { color: "#3B82F6", label: "Job (assignee color)" },
  { color: TYPE_WARRANTY_CALL, label: "Warranty call" },
  { color: TYPE_ESTIMATE_VISIT, label: "Estimate visit" },
  { color: TYPE_PROPOSAL_REVIEW, label: "Proposal review" },
  { color: TYPE_PERMIT_INSPECTION, label: "Permit Inspection" },
  { color: TYPE_DEADLINE, label: "Deadline" },
  { color: TYPE_GOOGLE_MEETING, label: "Google Meet" },
  { color: TYPE_UNASSIGNED, label: "Unassigned" },
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
    case "permit_inspection":
      return "Permit Inspection";
    case "deadline":
      return "Deadline";
    case "google_meeting":
      return "Google Meet";
  }
}

export function subBadgeLabel(name: string | null | undefined): string | null {
  const n = (name ?? "").trim();
  return n ? `Sub: ${n}` : null;
}
