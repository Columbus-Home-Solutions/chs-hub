import { eventTypeLabel, type CalendarEvent } from "./calendar-colors";

/** Chips shown in a month tile before "+N more". Three one-line chips fit the fixed tile. */
export const MONTH_VISIBLE_CHIPS = 3;

/** Full entry text for the month-chip tooltip. The chip itself stays one truncated line. */
export function monthChipTooltip(e: CalendarEvent): string {
  const lines = [e.title];
  if (e.job_number != null) {
    lines.push(`JOB-${String(e.job_number).padStart(3, "0")}`);
  }
  if (e.start_time) {
    lines.push(`${e.start_time}${e.end_time ? `–${e.end_time}` : ""}`);
  }
  lines.push(e.assigned_user_name ?? e.assigned_sub_name ?? "Unassigned");
  lines.push(eventTypeLabel(e.type));
  return lines.join("\n");
}
